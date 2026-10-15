// Engine: runs one bot. One tick =
//   market   (market.js)   read closed bars + live price
//   strategy (strategy.js) decide exits / entry from that data and the saved state
//   executor (executor.js) fill the decision (simulated at market price; Bitget orders not enabled)
// then reconcile and save state. Everything that happens is emitted on the event bus
// (events.js); alerts.js and recorder.js subscribe to it, a live executor will later.
const fs = require('fs');
const { STOP_FILE } = require('./executor');
// Pause trading (the dashboard switch): no order is sent and a live bot's resting orders are taken off the exchange
const paused = () => fs.existsSync(STOP_FILE);
const path = require('path');
const S = require('./strategy');
const I = require('./indicators');

function usMarketOpen(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  if (['Sat', 'Sun'].includes(p.weekday)) return false;
  const m = +p.hour * 60 + +p.minute;
  return m >= 570 && m < 960; // 09:30-16:00 (US holidays not handled: Bitget will reject, bot logs it)
}

// USDT-M futures fees per exchange, checked against real fills on 2026-10-06 (Binance: SOXL stock perp, 0% maker);
// manual orders record theirs (maker = limit, taker = market)
const FEES = { bitget: { maker: 0.0002, taker: 0.0006 }, binance: { maker: 0, taker: 0.0004 } };
const EXCHANGE = { bitget: 'Bitget', binance: 'Binance' };
const localTime = ts => new Date(ts).toLocaleString('sv-SE').slice(0, 16);

// a store kept in memory: for tests and tools that don't need the database. cmds = commands waiting for the bot.
function memoryStore(cmds = []) {
  return { saved: null, cmds, saveState(st) { this.saved = JSON.parse(JSON.stringify(st)); }, takeCommands() { return this.cmds.splice(0); }, hasCommands() { return this.cmds.length > 0; } };
}

class Engine {
  // store = where the state and the dashboard's commands live: { saveState(st), takeCommands(), hasCommands() } (db.js in the
  // runner; memoryStore() in tests). state = the saved state to continue from (null = a new bot).
  constructor(cfg, { market, executor, bus = null }, { dir = '.', now = () => Date.now(), marketOpen, quiet = false, store = memoryStore(), state = null } = {}) {
    marketOpen = marketOpen || (d => !this.cfg.usMarketHoursOnly || usMarketOpen(d));
    this.cfg = cfg; this.market = market; this.executor = executor; this.bus = bus;
    this.dir = dir; this.now = now;
    this.marketOpen = marketOpen; this.quiet = quiet;
    this.store = store;
    this.logPath = path.join(dir, cfg.logFile);
    this.st = this.prepare(state);
  }

  // ---------- state / log ----------
  // st.pos = the open martingale cycle: { id, orders: [{ n, ts, px, qty, margin }], qty, cost, openedAt } or null
  prepare(saved) {
    const fresh = { seq: 0, pos: null, lastBarTs: 0, pending: null, realizedPnl: 0, halted: false, history: [] };
    if (!saved) return fresh;
    const st = JSON.parse(JSON.stringify(saved));
    if (st.portions) this.migratePortions(st);
    return { ...fresh, ...st };
  }

  // State from the per-portion strategy. Nothing is dropped: open portions become the filled
  // orders of the current cycle (same time / price / qty), closed ones stay in legacyHistory.
  // The original portions are kept in legacyPortions.
  migratePortions(st) {
    const open = st.portions.filter(p => p.remaining > 0).sort((a, b) => a.openedAt - b.openedAt);
    st.legacyHistory = [...(st.legacyHistory || []), ...(st.history || []).filter(h => !h.orders)];
    st.history = (st.history || []).filter(h => h.orders);
    st.pos = open.length ? {
      id: open[0].id, openedAt: open[0].openedAt, migrated: true,
      orders: open.map((p, n) => ({ n, ts: p.openedAt, px: p.entryPx, qty: p.remaining, margin: S.marginOf(p.entryPx, p.remaining, this.cfg.leverage), fromPortion: p.id })),
      qty: +open.reduce((s, p) => s + p.remaining, 0).toFixed(8),
      cost: open.reduce((s, p) => s + p.entryPx * p.remaining, 0),
    } : null;
    st.legacyPortions = st.portions;
    delete st.portions;
    this.migrated = open.length;
  }
  // the whole state, in one write; callers await it, and every order is tracked here BEFORE it is sent
  save() { return this.store.saveState(this.st); }

  log(level, msg) {
    const line = `${localTime(this.now())} ${level.padEnd(5)} ${msg}`;
    if (!this.quiet || level !== 'INFO') console.log(line);
    fs.appendFileSync(this.logPath, line + '\n');
  }

  emit(type, data = {}) {
    if (!this.bus) return;
    const c = this.cfg;
    this.bus.emit(type, { ts: this.now(), bot: c.id, symbol: c.symbol, tf: c.tf, mode: c.dryRun ? 'SIM' : 'LIVE', pdp: this.pdp, ...data });
  }

  // ---------- setup ----------
  async init() {
    const c = await this.market.contract();
    this.step = +c.sizeMultiplier || Math.pow(10, -(+c.volumePlace));
    this.minQty = +c.minTradeNum;
    this.minNotional = +c.minTradeUSDT || 0; // e.g. Bitget 5 USDT, Binance 50-100 USDT
    this.qdp = +c.volumePlace;
    this.pdp = +c.pricePlace;
    await this.recoverPending();
  }
  get fees() { return FEES[this.cfg.broker || 'bitget']; }
  get exchange() { return EXCHANGE[this.cfg.broker || 'bitget']; }
  // the fee of one fill: what the exchange charged, else the standard rate for the order type (alert mode, older fills)
  feeOf(fill, orderType) {
    if (fill.fee != null && Number.isFinite(+fill.fee)) return { fee: +fill.fee };
    return { fee: fill.px * fill.qty * (orderType === 'limit' ? this.fees.maker : this.fees.taker), feeEst: true };
  }
  q(x) { return +(Math.floor(x / this.step + 1e-9) * this.step).toFixed(this.qdp); }
  px(x) { return x.toFixed(this.pdp); }

  // ---------- main tick ----------
  async tick() {
    const cfg = this.cfg;
    await this.applyCommands();
    if (this.resting && this.st.pos) return this.restingTick(); // an open live cycle lives on the exchange: no indicator checks, no market re-trading
    // 1 market
    const bars = await this.market.closedBars(cfg.tf, 300);
    const price = await this.market.lastPrice();
    this.processManual(price);
    const action = await this.processArmed(price);
    if (action) { // the bot is stopping or closing: no more orders or entries
      this.st.lastCheck = { ts: this.now(), price };
      await this.save();
      return { price, action };
    }
    // 2 strategy
    // conditions with their own K-line need those candles too, but only when a new bot candle has just closed
    const extra = {}, lastBar = bars[bars.length - 1];
    if (lastBar && lastBar.ts > this.st.lastBarTs) {
      for (const tf of S.distinctTfs(S.entryOf(cfg), cfg.tf)) if (tf !== cfg.tf) extra[tf] = await this.market.closedBars(tf, 300);
    }
    const d = S.decide(this.st, bars, price, cfg, this.marketOpen(new Date(this.now())), extra);
    // executor: take profit first, then an add order, then a new cycle on a new bar
    // fillMode 'manual': the orders are placed by hand on the exchange; the bot only advises and waits for the real fill (a 'fill' command)
    const byHand = cfg.fillMode === 'manual';
    if (d.exit) byHand ? this.adviseTp(d.exit.qty, price) : await this.order({ kind: 'tp', side: 'sell', qty: d.exit.qty, reduceOnly: true });
    else if (d.add) byHand ? this.adviseBuy('add', d.add.n, price) : await this.buy('add', d.add.n, price);
    if (d.newBar) {
      this.trace(bars, d.signal);
      if (d.signal) {
        this.log('INFO', `signal on ${localTime(d.bar.ts)} bar: ${d.entry ? 'opening a cycle' : `no action: ${d.ignored}`}`);
        this.emit('signal', { barTs: d.bar.ts, close: d.bar.c, action: d.entry ? 'open' : 'none', reason: d.ignored, entry: S.entryOf(cfg) });
      }
    }
    const entry = S.entryOf(cfg);
    // a maker order is placed by hand BEFORE the price gets there, so it is advised as soon as there is no cycle
    if (byHand && entry.mode === 'maker' && !this.st.pos && !this.st.halted && !d.entry && !S.cyclesDone(this.st, cfg)) this.adviseBuy('open', 0, entry.limitPx);
    else if (d.entry && !paused()) byHand ? this.adviseBuy('open', 0, d.entryPx || price) : await this.buy('open', 0, d.entryPx || price, d.entryPx);
    if (d.newBar) this.st.lastBarTs = d.bar.ts;
    this.st.lastCheck = { ts: this.now(), price };
    await this.reconcile();
    await this.save();
    return { price, newBar: d.newBar };
  }

  // ---------- orders ----------
  // order #n of the cycle (0 = first order): margin grows by amountMult each add
  // fillPx: fill at this price instead of the market (a maker entry fills at its limit)
  async buy(kind, n, price, fillPx) {
    const cfg = this.cfg;
    if (kind === 'open' && this.st.pos) return;
    if (kind === 'add' && (!this.st.pos || S.planned(this.st.pos).length !== n)) return; // stale decision
    const margin = n === 0 ? S.marginFor(cfg, 0) : S.addMargin(cfg, this.st.pos, n);
    if (!(margin > 0)) return; // investment used up
    const qty = this.q(S.qtyFor(margin, price, cfg.leverage));
    if (qty < this.minQty || qty * price < this.minNotional) {
      // not enough for the exchange minimum: skip this order (the bot keeps running and waits for funds), tell the user once
      const need = S.minOrderMargin(price, cfg.leverage, { step: this.step, qdp: this.qdp, minQty: this.minQty, minValue: this.minNotional });
      const topUp = S.topUpFor(cfg, this.st.pos, n, need);
      const key = `${this.st.pos ? this.st.pos.id : 'new'}:${n}:${margin.toFixed(2)}`;
      const first = !this.st.short || this.st.short.key !== key;
      this.st.short = { n, need, have: margin, topUp, key, ts: this.now() };
      if (first) {
        const msg = `Order #${n} needs at least ${need.toFixed(2)} USDT margin but the plan gives ${margin.toFixed(2)}. Add about ${Math.ceil(topUp * 100) / 100} USDT (Add funds) to place it. Until then this order is skipped; the rest of the bot keeps running.`;
        this.log('WARN', msg);
        this.emit('error', { message: msg });
      }
      return;
    }
    this.st.short = null;
    await this.order({ kind, n, margin, side: 'buy', qty, reduceOnly: false, ...(fillPx ? { px: fillPx } : {}) });
  }

  // ---------- by-hand orders (fillMode 'manual') ----------
  // Tell the user once per order what to place on the exchange. The numbers are an estimate: the real
  // fill is entered afterwards ('fill' command) and the rest of the ladder follows from it.
  advise(key, text) {
    const a = this.st.advised = this.st.advised || {};
    if (a[key]) return;
    a[key] = this.now();
    this.log('INFO', text);
    this.emit('advice', { message: text });
  }

  adviseBuy(kind, n, price) {
    const cfg = this.cfg, margin = n === 0 ? S.marginFor(cfg, 0) : S.addMargin(cfg, this.st.pos, n);
    if (!(margin > 0)) return;
    const qty = this.q(S.qtyFor(margin, price, cfg.leverage)), what = kind === 'open' ? `first order of cycle #${this.st.seq + 1}` : `add ${n}/${cfg.maxAdds} of cycle #${this.st.pos.id}`;
    if (qty < this.minQty) return this.advise(`short:${kind}:${n}`, `The ${what} is ${margin.toFixed(2)} USDT margin: below the minimum size ${this.minQty}.`);
    const how = kind === 'open' && cfg.entry.mode === 'taker' ? 'market (taker)' : 'limit (maker)';
    this.advise(`${kind}:${kind === 'open' ? this.st.seq + 1 : this.st.pos.id}:${n}`,
      `Place ${how} buy for the ${what}: about ${qty} @ ${this.px(price)} (${margin.toFixed(2)} USDT margin at ${cfg.leverage}x ${cfg.marginMode === 'isolated' ? 'isolated 逐仓' : 'cross 全仓'}). Enter the real fill afterwards.`);
  }

  adviseTp(qty, price) {
    this.advise(`tp:${this.st.pos.id}`, `Take profit reached for cycle #${this.st.pos.id}: sell ${qty} at about ${this.px(price)}. Enter the real fill afterwards.`);
  }

  // the real fill from the exchange: a buy is the next planned order of the cycle (first order, or add n);
  // a sell that takes the whole position closes the cycle, a smaller one reduces it
  applyReal(c) {
    const cfg = this.cfg, px = +c.px, qty = this.q(+c.qty), side = c.side === 'sell' ? 'sell' : 'buy', pos = this.st.pos;
    if (!(px > 0) || !(qty >= this.minQty)) { this.emit('error', { message: `Fill ignored: price ${c.px} and size ${c.qty} must be above 0 and at least ${this.minQty}.` }); return; }
    if (side === 'sell') {
      if (!pos) { this.emit('error', { message: `Sell fill of ${qty} ignored: no open position.` }); return; }
      if (qty >= pos.qty - this.minQty / 2) this.applyFill({ kind: 'tp' }, { px, qty: pos.qty });
      else this.reduce(qty, px, 'limit', 0);
      return;
    }
    const full = pos && S.planned(pos).length > cfg.maxAdds; // every planned order is already in: this one is extra
    this.applyFill({ kind: pos ? 'add' : 'open', margin: S.marginOf(px, qty, cfg.leverage), ...(full ? { manual: true, orderType: 'limit', fee: 0 } : {}) }, { px, qty });
  }

  async order(p) {
    const cid = `sx${this.now()}${Math.floor(Math.random() * 1e4)}`;
    this.st.pending = { ...p, cid };
    await this.save(); // persisted BEFORE sending so a crash can be recovered
    let fill = null;
    try {
      fill = await this.executor.marketOrder({ side: p.side, size: p.qty, reduceOnly: p.reduceOnly, clientOid: cid, px: p.px });
    } catch (e) {
      this.log('ERROR', `${p.kind} ${p.side} ${p.qty} failed: ${e.message}`);
      this.emit('error', { message: `${p.kind.toUpperCase()} order for ${p.qty} failed: ${e.message}` });
      fill = await this.executor.findOrder(cid); // it may have gone through anyway
    }
    // live: the real fill sets the margin used; the rest of the ladder follows from it
    if (fill && fill.qty > 0) this.applyFill(!this.cfg.dryRun && p.side === 'buy' ? { ...this.st.pending, margin: S.marginOf(fill.px, fill.qty, this.cfg.leverage) } : this.st.pending, fill);
    this.st.pending = null;
    await this.save();
  }

  async recoverPending() {
    const p = this.st.pending;
    if (!p) return;
    const fill = await this.executor.findOrder(p.cid);
    if (fill) { this.log('WARN', `recovered unfinished order ${p.cid}`); this.applyFill(p, fill); }
    else this.log('WARN', `unfinished order ${p.cid} was not filled; dropped`);
    this.st.pending = null;
    await this.save();
  }

  // ---------- resting orders (live bots) ----------
  // Once the first order is filled, the rest of the cycle lives on the exchange as limit orders (委托): a buy for every
  // add still to come and one reduce-only sell for the take profit. The bot only looks at the fills (every few
  // seconds, no indicators) and keeps those orders right: after an add fills the take profit moves to the new
  // average price and size. st.live = { rev, adds: { k: { cid, px, qty } }, tp: { cid, px, qty } | null }.
  get resting() { return !this.cfg.dryRun && !!this.executor.live && this.cfg.fillMode !== 'manual'; }
  liveSt() { const l = this.st.live = this.st.live || {}; l.rev = l.rev || 0; l.adds = l.adds || {}; if (l.tp === undefined) l.tp = null; return l; }
  // an error / notice told once per key (the loop runs every few seconds)
  once(key, fn) { const a = this.st.advised = this.st.advised || {}; if (!a[key]) { a[key] = this.now(); fn(); } }

  async restingTick() {
    const price = await this.market.lastPrice();
    let action = await this.processArmed(price);
    const closing = !!(this.st.armed && (this.st.armed.close || this.st.armed.reset)); // a close / reset is under way: its orders must not be put back
    if (!action && this.st.closing && !closing) { // cancelled on the dashboard: take the limit sell back (if it had filled, a close ends the bot)
      const wasClose = !this.st.closing.reset;
      if (await this.dropLimitClose() && wasClose) action = 'close';
    }
    if (!action && !closing) {
      await this.syncFills();
      if (paused()) await this.pauseResting(); // nothing may fill while paused; resuming places the ladder again
      else if (this.st.pos) await this.syncOrders();
    }
    this.st.lastCheck = { ts: this.now(), price };
    if (!action) await this.reconcile();
    await this.save();
    return action ? { price, action } : { price, resting: true };
  }

  // orders we placed that are no longer open: filled (all or part) or cancelled
  async syncFills() {
    const live = this.liveSt(), open = new Set((await this.executor.pendingOrders()).map(o => o.cid));
    for (const [k, o] of Object.entries(live.adds)) {
      if (open.has(o.cid)) continue;
      await this.settle('add', o);
      delete live.adds[k];
    }
    if (live.tp && !open.has(live.tp.cid)) {
      const t = live.tp;
      live.tp = null;
      await this.settle('tp', t);
    }
    await this.save();
  }

  // book what an order that is no longer open did (nothing if it was cancelled / never placed)
  async settle(kind, o) {
    const d = await this.executor.orderState(o.cid); // throws on a network error: tracking is kept and tried again
    if (!d || !(d.qty > 0)) return;
    const pos = this.st.pos;
    if (!pos) return;
    if (kind === 'add') return this.applyFill({ kind: 'add', margin: S.marginOf(d.px, d.qty, this.cfg.leverage) }, { px: d.px, qty: d.qty, fee: d.fee, ts: d.ts, orderType: 'limit' });
    if (d.qty >= pos.qty - this.minQty / 2) { // the whole position is sold: the cycle is over, nothing else may fill
      this.applyFill({ kind: 'tp' }, { px: d.px, qty: pos.qty, fee: d.fee, ts: d.ts, orderType: 'limit' });
      await this.cancelResting(true);
    } else this.reduce(d.qty, d.px, 'limit', this.feeOf(d, 'limit').fee); // an add filled just before the take profit moved: the rest stays
  }

  // The cycle's adds, fixed in pos.plan when the cycle opens so a code or settings change never moves an open cycle;
  // raising maxAdds appends the new adds, lowering it drops the ones past it. pos.plan = { maxAdds, adds: [{ k, px, qty }] }
  planAdds(rules) {
    const pos = this.st.pos, cfg = this.cfg, pick = a => ({ k: a.k, px: a.px, qty: a.qty });
    if (!pos.plan) pos.plan = { maxAdds: cfg.maxAdds, adds: S.ladder(pos, cfg, rules).adds.map(pick) };
    if (cfg.maxAdds > pos.plan.maxAdds) {
      pos.plan.adds.push(...S.ladder(pos, cfg, rules).adds.filter(a => a.k > pos.plan.maxAdds).map(pick));
      pos.plan.maxAdds = cfg.maxAdds;
    }
    const done = S.planned(pos).length;
    return pos.plan.adds.filter(a => a.k >= done && a.k <= cfg.maxAdds);
  }

  // make the exchange's open orders equal to the cycle's plan, placing and cancelling only the difference
  async syncOrders() {
    const live = this.liveSt(), rules = { q: x => this.q(x), pdp: this.pdp, minQty: this.minQty, minNotional: this.minNotional };
    const want = { adds: this.planAdds(rules), tp: { px: +S.levels(this.st.pos, this.cfg).tp.toFixed(this.pdp), qty: this.st.pos.qty } };
    const exQty = await this.executor.positionQty();
    if (exQty !== null) want.tp.qty = this.q(Math.min(want.tp.qty, exQty)); // never ask to sell more than the exchange holds
    const sig = () => this.st.pos ? `${this.st.pos.orders.length}:${this.st.pos.qty}` : '', before = sig();
    if (live.tp && (live.tp.px !== want.tp.px || live.tp.qty !== want.tp.qty)) { await this.cancelOne('tp', live.tp); live.tp = null; }
    for (const [k, o] of Object.entries(live.adds)) {
      const w = want.adds.find(a => a.k === +k);
      if (!w || w.px !== o.px || w.qty !== o.qty) { await this.cancelOne('add', o); delete live.adds[k]; }
    }
    if (sig() !== before) return; // an order filled while it was being cancelled: the plan above is stale, the next pass redoes it
    if (!live.tp && want.tp.qty >= this.minQty) await this.place(live, 'tp', want.tp);
    for (const a of want.adds) if (!live.adds[a.k]) await this.place(live, a.k, a);
    await this.save();
    const n = Object.keys(live.adds).length;
    if (n) this.once(`ladder:${this.st.pos.id}`, () => {
      const px = Object.values(live.adds).map(o => o.px);
      this.log('INFO', `resting orders placed: ${n} limit buys ${this.px(Math.max(...px))} to ${this.px(Math.min(...px))}${live.tp ? `, take profit ${this.px(live.tp.px)}` : ''}`);
      this.emit('advice', { message: `Cycle #${this.st.pos.id}: ${n} limit buys placed from ${this.px(Math.max(...px))} down to ${this.px(Math.min(...px))}${live.tp ? `, and a take profit sell of ${live.tp.qty} at ${this.px(live.tp.px)}` : ''}. See Open orders (委托) on ${this.exchange}.` });
    });
  }

  // place one resting order. The tracking is saved BEFORE sending so a crash cannot lose an order that went through.
  async place(live, key, w) {
    const pos = this.st.pos, cid = `sx${pos.id}${key === 'tp' ? 't' : 'a' + key}r${++live.rev}`, rec = { cid, px: w.px, qty: w.qty };
    if (key === 'tp') live.tp = rec; else live.adds[key] = rec;
    await this.save();
    try {
      await this.executor.limitOrder({ side: key === 'tp' ? 'sell' : 'buy', size: w.qty, price: w.px, reduceOnly: key === 'tp', clientOid: cid });
    } catch (e) {
      if (key === 'tp') live.tp = null; else delete live.adds[key];
      this.log('ERROR', `resting ${key === 'tp' ? 'take profit' : `add ${key}`} ${w.qty} @ ${this.px(w.px)} failed: ${e.message}`);
      this.once(`placefail:${pos.id}:${key}:${w.px}`, () => this.emit('error', { message: `Could not place the ${key === 'tp' ? 'take profit' : `add ${key}`} order (${w.qty} @ ${this.px(w.px)}): ${e.message}. The bot retries.` }));
    }
  }

  // cancel one tracked order, then book anything it filled before the cancel got through
  async cancelOne(kind, o) {
    try { await this.executor.cancel(o.cid); }
    catch (e) { // already filled / cancelled is fine; an order that is still open is not
      if ((await this.executor.pendingOrders()).some(x => x.cid === o.cid)) throw e;
    }
    await this.settle(kind, o);
  }

  // cancel the resting orders: the adds only (the bot was switched off: the take profit keeps protecting the position),
  // or everything (the position is being sold / the cycle is over)
  async cancelResting(all) {
    const live = this.liveSt();
    for (const [k, o] of Object.entries(live.adds)) { await this.cancelOne('add', o); delete live.adds[k]; }
    if (all && live.tp) { const t = live.tp; live.tp = null; await this.cancelOne('tp', t); }
    await this.save();
  }

  // paused: cancel every resting order of the cycle once (fills found while cancelling are booked by cancelOne)
  async pauseResting() {
    const live = this.liveSt(), n = Object.keys(live.adds).length + (live.tp ? 1 : 0);
    if (!n) return;
    await this.cancelResting(true);
    this.log('INFO', `trading paused: ${n} resting order(s) cancelled; they are placed again on resume`);
    this.emit('advice', { message: `Trading paused: the ${n} resting order(s) of cycle #${this.st.pos ? this.st.pos.id : '-'} were cancelled on ${this.exchange}. The position stays open. Resume to place them again.` });
  }

  // the bot was switched off on the dashboard (not just a restart): the ladder must not keep buying with nobody watching
  async onStop() { if (this.resting && this.st.pos) await this.cancelResting(false); }

  // ---------- manual orders ----------
  // The dashboard queues commands in commands-<id>.json (it never writes state itself):
  //   { type: 'manual', side: 'buy' | 'sell', orderType: 'market' | 'limit', px (limit price), qty }
  //   { type: 'cancel', ref }
  // Market orders fill at the price of the next check (taker fee); limit orders wait in st.manualOrders
  // until the price reaches them and fill at the limit (maker fee). Buys join the cycle as manual orders
  // (on top of the investment); sells reduce the position and realize P&L.
  hasCommands() { return this.store.hasCommands(); }

  async applyCommands() {
    const cmds = await this.store.takeCommands(); // taken = gone from the queue; the dashboard adds new ones meanwhile
    if (!cmds.length) return;
    this.st.manualOrders = this.st.manualOrders || [];
    for (const c of cmds) {
      // stop / close the bot: now, or armed at a price (fires on the first check where the price has reached it)
      // close has a "how": 'market' (sell at market, now or when a price is reached), 'limit' (a limit sell at c.px that rests on the
      // exchange; the bot closes when it fills) or 'hold' (end the bot, keep the position)
      // reset: sell the cycle at market or with a limit order at c.px; the bot keeps running and starts a new cycle by its entry rule
      if (c.type === 'reset') {
        if (c.how === 'limit' && !(c.px > 0)) { this.log('WARN', 'reset with a limit sell needs a price: ignored'); continue; }
        const at = c.at || this.now();
        (this.st.armed = this.st.armed || {}).reset = c.how === 'limit' ? { now: true, how: 'limit', limitPx: +c.px, at } : { now: true, how: 'market', at };
        this.log('INFO', `reset cycle requested: ${c.how === 'limit' ? `limit sell at ${this.px(+c.px)}` : 'sell at market'}`);
        continue;
      }
      if (c.type === 'stop' || c.type === 'close') {
        const a = this.st.armed = this.st.armed || {}, how = c.type === 'close' && (c.how === 'hold' || c.how === 'limit') ? c.how : 'market', at = c.at || this.now();
        if (how === 'limit' && !(c.px > 0)) { this.log('WARN', 'close with a limit sell needs a price: ignored'); continue; }
        a[c.type] = how === 'limit' ? { now: true, how, limitPx: +c.px, at } : how === 'hold' ? { now: true, how, at }
          : c.px > 0 ? { px: +c.px, dir: c.dir === 'up' ? 'up' : 'down', at } : { now: true, at };
        this.log('INFO', `${c.type} bot ${how === 'limit' ? `requested: limit sell at ${this.px(+c.px)}` : how === 'hold' ? 'requested: keep the position' : c.px > 0 ? `armed at ${this.px(+c.px)}` : 'requested'}`);
        continue;
      }
      if (c.type === 'disarm') {
        if (this.st.armed) delete this.st.armed[c.what];
        this.log('INFO', `${c.what} cancelled`);
        continue;
      }
      if (!this.cfg.dryRun && (c.type === 'fill' || c.type === 'manual')) { // a live bot's fills come from Bitget; a typed or simulated one would desync it
        this.emit('error', { message: `${c.type === 'fill' ? 'Entered fill' : 'Manual order'} ignored: a live bot only records real ${this.exchange} fills.` });
        continue;
      }
      if (c.type === 'fill') { this.applyReal(c); continue; }
      if (c.type === 'cancel') {
        const o = this.st.manualOrders.find(x => x.ref === c.ref);
        this.st.manualOrders = this.st.manualOrders.filter(x => x.ref !== c.ref);
        if (o) this.log('INFO', `manual ${o.side} limit ${o.qty} @ ${this.px(o.px)} cancelled`);
        continue;
      }
      const side = c.side === 'sell' ? 'sell' : 'buy', orderType = c.orderType === 'limit' ? 'limit' : 'market';
      if (c.type !== 'manual' || !(c.qty > 0) || (orderType === 'limit' && !(c.px > 0))) { this.log('WARN', `bad command ${JSON.stringify(c)}`); continue; }
      const qty = this.q(c.qty);
      if (qty < this.minQty) { this.emit('error', { message: `Manual order ${c.qty} is below the minimum size ${this.minQty}.` }); continue; }
      this.st.manualOrders.push({ ref: c.ref || `m${c.at || this.now()}`, side, orderType, px: orderType === 'limit' ? +c.px : null, qty, at: c.at || this.now() });
    }
    await await this.save();
  }

  // armed stop / close: due at once (now) or when the price has reached the level in its direction.
  // Returns 'close' | 'stop' when the runner has to disable the bot, else null.
  async processArmed(price) {
    const a = this.st.armed;
    if (!a) return null;
    const due = x => x && (x.now || (x.dir === 'up' ? price >= x.px : price <= x.px));
    if (due(a.reset)) { // sell the cycle and keep going: never stops or closes the bot
      await this.closeBot(price, { ...a.reset, reset: true });
      return null;
    }
    if (due(a.close)) {
      const r = await this.closeBot(price, a.close);
      if (r === 'pending') return null; // a limit sell is resting on the exchange: the bot stays on until it fills
      if (!r) return null; // the sell failed: still armed, retried on the next check
      return 'close';
    }
    if (due(a.stop)) {
      this.st.armed = null;
      const msg = a.stop.now ? 'Bot stopped.' : `Stop price ${this.px(a.stop.px)} reached (price ${this.px(price)}). Bot stopped; an open cycle stays as it is.`;
      this.log('INFO', msg);
      this.emit('halt', { message: msg });
      return 'stop';
    }
    return null;
  }

  // End the bot for good. spec.how: 'market' (default) sells the whole position at market; 'limit' sells it with a limit order at
  // spec.limitPx and waits for the fill; 'hold' ends the bot and leaves the position on the exchange. true = closed,
  // 'pending' = a limit sell is resting, false = it failed and is retried.
  async closeBot(price, spec = {}) {
    this.st.manualOrders = [];
    const reset = !!spec.reset, kind = reset ? 'reset' : 'close';
    if (spec.how === 'hold' && !reset) return this.holdClose();
    if (spec.how === 'limit') return this.limitClose(price, spec.limitPx, reset);
    if (this.resting) await this.cancelResting(true); // nothing may fill after the position is sold
    if (this.st.pos) await this.order({ kind, side: 'sell', qty: this.st.pos.qty, reduceOnly: true });
    if (this.st.pos) return false;
    return reset ? this.finishReset(`Cycle reset at ${this.px(price)}: the position is sold at market. A new cycle starts by the entry rule.`)
      : this.finishClose(`Bot closed at ${this.px(price)}. The position is sold and this bot won't run again.`);
  }

  finishClose(msg) {
    this.st.armed = null; this.st.closing = null;
    this.st.closedAt = this.now();
    this.log('INFO', msg);
    this.emit('halt', { message: msg });
    return true;
  }

  // a reset sells the cycle like a close, but the bot keeps running: its entry rule opens the next cycle
  finishReset(msg) {
    if (this.st.armed) delete this.st.armed.reset;
    this.st.closing = null;
    this.log('INFO', msg);
    this.emit('advice', { message: msg });
    return true;
  }

  // keep the position: every resting order is cancelled (nothing may fill with nobody watching) and the position stays on the
  // exchange, no longer managed. It is kept in the history as "held" so nothing is lost.
  async holdClose() {
    if (this.resting) await this.cancelResting(true);
    const pos = this.st.pos;
    let kept = '';
    if (pos) {
      const L = S.levels(pos, this.cfg), now = this.now();
      this.st.history.push({ id: pos.id, openedAt: pos.openedAt, closedAt: now, orders: pos.orders, qty: pos.qty, avg: L.avg, exitPx: null,
        margin: pos.orders.reduce((x, o) => x + (o.margin || 0), 0), pnl: pos.realized || 0, reductions: pos.reductions, closedBy: 'held' });
      this.st.held = { id: pos.id, qty: pos.qty, avg: L.avg, at: now };
      this.st.pos = null;
      kept = ` ${pos.qty} (average ${this.px(L.avg)}) stays open on the exchange and is no longer managed.`;
    }
    return this.finishClose(`Bot closed. Its orders were cancelled.${kept}`);
  }

  // sell the position with a limit order at limitPx and wait for the fill (a cancelled / emptied order ends the wait).
  // reset = the bot keeps running afterwards (a new cycle) instead of closing.
  async limitClose(price, limitPx, reset = false) {
    const pos = this.st.pos, done = msg => reset ? this.finishReset(msg) : this.finishClose(msg), what = reset ? 'Cycle reset' : 'Bot closed';
    if (!pos) return done(`${what}: there was no position to sell.`);
    if (!this.resting) { // simulated: no order book, so the limit sell fills once the price has reached it
      if (price < limitPx) return 'pending';
      await this.order({ kind: reset ? 'reset' : 'close', side: 'sell', qty: pos.qty, reduceOnly: true, px: limitPx });
      return this.st.pos ? false : done(`${what}: the limit sell filled at ${this.px(limitPx)}.`);
    }
    const c = this.st.closing;
    if (c) return (await this.checkLimitClose(c)) ? true : this.st.closing ? 'pending' : false;
    await this.cancelResting(true); // the buys and the take profit make way for the sell
    if (!this.st.pos) return done(`${what}: the take profit filled first.`);
    const cid = `sx${pos.id}c${++this.liveSt().rev}`;
    this.st.closing = { cid, px: limitPx, qty: pos.qty, ...(reset ? { reset: true } : {}) };
    await this.save(); // tracked BEFORE sending, like every resting order
    try { await this.executor.limitOrder({ side: 'sell', size: pos.qty, price: limitPx, reduceOnly: true, clientOid: cid }); }
    catch (e) {
      this.st.closing = null;
      this.log('ERROR', `limit sell ${pos.qty} @ ${this.px(limitPx)} failed: ${e.message}`);
      this.emit('error', { message: `Could not place the limit sell: ${e.message}` });
      return false;
    }
    this.log('INFO', `${reset ? 'resetting' : 'closing'}: limit sell ${pos.qty} @ ${this.px(limitPx)} placed; ${reset ? 'a new cycle starts' : 'the bot closes'} when it fills`);
    this.emit('advice', { message: `${reset ? 'Resetting' : 'Closing'} cycle #${pos.id}: limit sell of ${pos.qty} placed at ${this.px(limitPx)}. ${reset ? 'A new cycle starts' : 'The bot closes'} when it fills. See Open orders (委托) on ${this.exchange}.` });
    return 'pending';
  }

  // has the closing / resetting limit sell filled? true = the cycle is sold (and the bot closed, unless it was a reset)
  async checkLimitClose(c) {
    if ((await this.executor.pendingOrders()).some(o => o.cid === c.cid)) return false; // still resting
    const d = await this.executor.orderState(c.cid), pos = this.st.pos;
    this.st.closing = null;
    if (d && d.qty > 0 && pos) {
      if (d.qty >= pos.qty - this.minQty / 2) {
        this.applyFill({ kind: c.reset ? 'reset' : 'close' }, { px: d.px, qty: pos.qty });
        return c.reset ? this.finishReset(`Cycle reset: the limit sell filled at ${this.px(d.px)}. A new cycle starts by the entry rule.`)
          : this.finishClose(`Bot closed: the limit sell filled at ${this.px(d.px)}.`);
      }
      this.reduce(d.qty, d.px, 'limit', this.feeOf(d, 'limit').fee); // part of it: the rest is sold by a new limit order on the next check
      return false;
    }
    this.log('WARN', `the ${c.reset ? 'reset' : 'closing'} limit sell is gone without a fill (cancelled): dropped, the cycle carries on`);
    this.emit('error', { message: `The ${c.reset ? 'reset' : 'closing'} limit sell was cancelled on the exchange. Nothing was sold; the cycle carries on.` });
    if (this.st.armed) delete this.st.armed[c.reset ? 'reset' : 'close'];
    return false;
  }

  // the close / reset was cancelled on the dashboard while its limit sell is resting: take the sell back (the ladder is re-placed next)
  async dropLimitClose() {
    const c = this.st.closing;
    if (!c) return false;
    try { await this.executor.cancel(c.cid); }
    catch (e) { if ((await this.executor.pendingOrders()).some(o => o.cid === c.cid)) throw e; }
    return this.checkLimitClose(c); // it may have filled just before the cancel
  }

  // fill queued manual orders that are due at this price
  processManual(price) {
    const cfg = this.cfg, keep = [];
    for (const o of this.st.manualOrders || []) {
      const due = o.orderType === 'market' || (o.side === 'buy' ? price <= o.px : price >= o.px);
      if (!due) { keep.push(o); continue; }
      const px = o.orderType === 'market' ? price : o.px;
      const fee = px * o.qty * (o.orderType === 'market' ? this.fees.taker : this.fees.maker);
      if (o.side === 'buy') {
        const margin = px * o.qty / cfg.leverage;
        this.log('INFO', `manual ${o.orderType} buy ${o.qty} @ ${this.px(px)} (${margin.toFixed(2)} USDT margin, fee ${fee.toFixed(4)})`);
        this.applyFill({ kind: this.st.pos ? 'add' : 'open', n: null, margin, manual: true, orderType: o.orderType, fee }, { px, qty: o.qty });
      } else if (!this.st.pos) {
        this.emit('error', { message: `Manual sell ${o.qty} skipped: no open position.` });
      } else {
        this.reduce(Math.min(o.qty, this.st.pos.qty), px, o.orderType, fee);
      }
    }
    this.st.manualOrders = keep;
  }

  // sell part of the position at px: realizes (px - avg) x qty minus the fee; the average price stays
  reduce(qty, px, orderType, fee) {
    const cfg = this.cfg, pos = this.st.pos, now = this.now(), L = S.levels(pos, cfg);
    const pnl = (px - L.avg) * qty - fee;
    this.st.realizedPnl += pnl;
    pos.realized = (pos.realized || 0) + pnl;
    pos.qty = this.q(pos.qty - qty);
    pos.cost = L.avg * pos.qty;
    (pos.reductions = pos.reductions || []).push({ ts: now, px, qty, pnl, orderType, fee });
    this.log('TRADE', `REDUCE cycle #${pos.id} ${qty} @ ${this.px(px)} (${orderType}) | avg ${this.px(L.avg)} | pnl ${pnl.toFixed(2)} | left ${pos.qty}`);
    this.emit('reduce', { id: pos.id, px, qty, pnl, orderType, fee, avg: L.avg, left: pos.qty, realized: this.st.realizedPnl });
    if (pos.qty < this.minQty) { // sold everything: the cycle is closed
      this.st.history.push({ id: pos.id, openedAt: pos.openedAt, closedAt: now, orders: pos.orders, qty, avg: L.avg, exitPx: px,
        margin: pos.orders.reduce((s, o) => s + (o.margin || 0), 0), pnl: pos.realized, closedBy: 'manual' });
      if (this.st.history.length > 500) this.st.history.shift();
      this.st.pos = null;
    }
  }

  applyFill(p, fill) {
    const cfg = this.cfg, now = fill.ts > 0 && fill.ts <= this.now() ? fill.ts : this.now(); // the exchange's fill time when known
    if (p.kind === 'open' || p.kind === 'add') {
      if (p.kind === 'open') this.st.pos = { id: ++this.st.seq, orders: [], qty: 0, cost: 0, openedAt: now };
      const pos = this.st.pos;
      if (!pos) { this.log('WARN', 'add filled without an open cycle'); return; }
      const type = p.orderType || fill.orderType || 'market';
      pos.orders.push({ n: p.manual ? null : pos.orders.filter(o => !o.manual).length, ts: now, px: fill.px, qty: fill.qty, margin: p.margin, orderType: type,
        ...(p.manual ? { manual: true, fee: p.fee } : this.feeOf(fill, type)) });
      pos.qty = this.q(pos.qty + fill.qty);
      pos.cost += fill.px * fill.qty;
      const L = S.levels(pos, cfg), n = pos.orders[pos.orders.length - 1].n;
      this.log('TRADE', `${p.kind.toUpperCase().padEnd(5)} cycle #${pos.id} order ${n}/${cfg.maxAdds} ${fill.qty} @ ${this.px(fill.px)} | avg ${this.px(L.avg)} TP ${this.px(L.tp)}${L.nextAdd ? ` next add ${this.px(L.nextAdd)}` : ' (last add)'}`);
      this.emit(p.kind, { id: pos.id, n, manual: !!p.manual, orderType: p.orderType, fee: p.fee, maxAdds: cfg.maxAdds, px: fill.px, qty: fill.qty, margin: p.margin, totalQty: pos.qty,
        totalMargin: pos.orders.reduce((s, o) => s + (o.margin || 0), 0), avg: L.avg, tp: L.tp, nextAdd: L.nextAdd });
      return;
    }
    // take profit, or closing the bot: the whole position is sold
    const closing = p.kind === 'close' || p.kind === 'reset'; // sold on request (a reset keeps the bot running), not by the take profit
    const pos = this.st.pos;
    if (!pos) { this.log('WARN', 'take-profit fill without an open cycle'); return; }
    const L = S.levels(pos, cfg);
    const pnl = (fill.px - L.avg) * fill.qty;
    const margin = pos.orders.reduce((s, o) => s + (o.margin || 0), 0);
    this.st.realizedPnl += pnl;
    this.log('TRADE', `${closing ? (p.kind === 'reset' ? 'RESET' : 'CLOSE') : 'TP   '} cycle #${pos.id} ${fill.qty} @ ${this.px(fill.px)} | avg ${this.px(L.avg)} orders ${pos.orders.length} | pnl ${pnl.toFixed(2)} | total ${this.st.realizedPnl.toFixed(2)} USDT`);
    this.emit('close', { kind: p.kind, id: pos.id, px: fill.px, qty: fill.qty, avg: L.avg, orders: pos.orders.length, pnl,
      pnlPct: margin ? pnl / margin * 100 : 0, realized: this.st.realizedPnl, openedAt: pos.openedAt, heldMs: now - pos.openedAt });
    const exitType = fill.orderType || 'market';
    this.st.history.push({ id: pos.id, openedAt: pos.openedAt, closedAt: now, orders: pos.orders, qty: pos.qty, avg: L.avg,
      exitPx: fill.px, exit: { ts: now, px: fill.px, qty: fill.qty, orderType: exitType, ...this.feeOf(fill, exitType) },
      margin, pnl: pnl + (pos.realized || 0), reductions: pos.reductions, ...(closing ? { closedBy: p.kind === 'reset' ? 'reset' : 'closed' } : {}) });
    if (this.st.history.length > 500) this.st.history.shift();
    this.st.pos = null;
    this.st.short = null;
  }

  async reconcile() {
    const exQty = await this.executor.positionQty();
    if (exQty === null) return; // paper mode
    const local = this.st.pos ? this.st.pos.qty : 0;
    const bad = Math.abs(exQty - local) >= this.minQty;
    if (bad && !this.st.halted) {
      this.st.halted = true;
      this.log('WARN', `POSITION MISMATCH: ${this.exchange} ${exQty} vs bot ${this.q(local)}. New entries paused until they match.`);
      this.emit('mismatch', { exchangeQty: exQty, botQty: this.q(local), resolved: false });
    } else if (!bad && this.st.halted) {
      this.st.halted = false;
      this.log('INFO', 'position back in sync; entries resumed');
      this.emit('mismatch', { resolved: true });
    }
  }

  // ---------- trace ----------
  traceRows(bars) {
    const t = this.cfg.trace, closes = bars.map(b => b.c);
    const cols = { time: bars.map(b => localTime(b.ts)), close: closes };
    for (const n of t.sma) cols[`sma${n}`] = I.sma(closes, n);
    for (const n of t.ema) cols[`ema${n}`] = I.ema(closes, n);
    for (const [n, m] of t.boll) {
      const b = I.boll(closes, n, m), k = `bb${n}x${m}`;
      cols[`${k}_up`] = b.up; cols[`${k}_mid`] = b.mid; cols[`${k}_lo`] = b.lo;
      // %B: 0 = at lower band, 1 = at upper band
      cols[`${k}_pb`] = closes.map((c, i) => b.up[i] === null ? null : (c - b.lo[i]) / (b.up[i] - b.lo[i]));
    }
    return cols;
  }

  trace(bars, signal) {
    const cols = this.traceRows(bars), keys = Object.keys(cols), i = bars.length - 1;
    const fmt = (k, v) => v === null ? '' : typeof v === 'string' ? v : k.endsWith('_pb') ? v.toFixed(2) : this.px(v);
    const dir = path.join(this.dir, this.cfg.traceDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.cfg.symbol}_${this.cfg.tf}.csv`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, [...keys, 'signal', 'orders'].join(',') + '\n');
    const row = keys.map(k => fmt(k, cols[k][i]));
    const orders = this.st.pos ? this.st.pos.orders.length : 0;
    fs.appendFileSync(file, [...row, signal ? 1 : 0, orders].join(',') + '\n');
    const s = S.entrySignals(S.entryOf(this.cfg)).find(x => x.type.startsWith("boll"));
    const b = s ? `bb${s.period}x${s.mult}` : null;
    const extra = b && cols[`${b}_pb`] ? ` %B ${fmt('_pb', cols[`${b}_pb`][i])}` : '';
    this.log('INFO', `bar ${cols.time[i]} close ${this.px(bars[i].c)}${extra}${signal ? ' SIGNAL' : ''} | ${orders ? `cycle #${this.st.pos.id}, ${orders} orders` : 'no position'}`);
  }
}

module.exports = { Engine, usMarketOpen, localTime, memoryStore };
