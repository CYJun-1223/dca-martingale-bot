// What the dashboard shows: market data (price, contract rules, funding, symbol check), the exchange accounts, and the per-bot /
// per-watch view built from the database state and the exchange. Everything here only reads; nothing places an order.
//   const views = createViews({ runtime })      runtime = the folder with the bots' log files
const fs = require('fs');
const path = require('path');
const bots = require('./bots');
const watches = require('./watches');
const S = require('./strategy');
const { Bitget } = require('./bitget');
const { Binance } = require('./binance');
const db = require('./db');
const { TF_MS, nextCheckAt, createMarket, BROKERS } = require('./market');

function createViews({ runtime }) {
  const api = new Bitget({});

  // ---- prices (public ticker per broker, cached 10s per broker + symbol) ----
  const priceCache = {};
  const marketFor = (symbol, broker = 'bitget') => createMarket({ ...require('./config'), symbol, broker }, api);
  async function price(symbol, broker = 'bitget') {
    const key = `${broker}:${symbol}`, c = priceCache[key];
    if (c && Date.now() - c.at < 10e3) return c.px;
    try {
      const px = await marketFor(symbol, broker).lastPrice();
      priceCache[key] = { px, at: Date.now() };
      return px;
    } catch { return c ? c.px : null; }
  }

  // contract rules (qty step, minimums) so the dashboard shows the same quantities the bot will order; cached 1h
  const contractCache = {};
  async function contract(symbol, broker = 'bitget') {
    const key = `${broker}:${symbol}`, c = contractCache[key];
    if (c && Date.now() - c.at < 3600e3) return c.v;
    try {
      const r = await marketFor(symbol, broker).contract();
      const v = { step: +r.sizeMultiplier || Math.pow(10, -(+r.volumePlace)), qdp: +r.volumePlace, pdp: +r.pricePlace, minQty: +r.minTradeNum, minValue: +r.minTradeUSDT || 0 };
      contractCache[key] = { v, at: Date.now() };
      return v;
    } catch { return c ? c.v : null; }
  }

  // does the symbol exist on the broker, is it tradable, and does it allow this leverage (fresh read, not cached)
  async function checkSymbol(symbol, broker, leverage) {
    const label = BROKERS[broker].label;
    let r;
    try { r = await marketFor(symbol, broker).contract(); } catch (e) { return { ok: false, message: `${symbol} is not available on ${label}: ${e.message}` }; }
    const maxLever = +r.maxLever || null, minLever = +r.minLever || 1, status = r.symbolStatus || 'normal', lev = +leverage;
    const out = { symbol, status, maxLever, minLever, minQty: +r.minTradeNum, minValue: +r.minTradeUSDT || 0, price: await price(symbol, broker), leverage: lev };
    if (status !== 'normal') return { ...out, ok: false, message: `${symbol} exists on ${label} but its status is "${status}", so it cannot be traded now.` };
    if (lev && (lev < minLever || (maxLever && lev > maxLever))) return { ...out, ok: false, message: `${symbol} exists on ${label}, but ${lev}x is not allowed: leverage must be ${minLever} to ${maxLever || '?'}x.` };
    return { ...out, ok: true, message: `${symbol} is on ${label}, trading, price ${out.price}. Leverage ${minLever} to ${maxLever || '?'}x${lev ? `: ${lev}x is allowed` : ''}. Minimum order ${out.minQty} (${out.minValue} USDT).` };
  }

  // funding rate (Bitget public endpoint, cached 5 min): rate per interval and the next settlement
  const fundingCache = {};
  async function funding(symbol, broker = 'bitget') {
    if (broker !== 'bitget') return null;
    const c = fundingCache[symbol];
    if (c && Date.now() - c.at < 300e3) return c.v;
    try {
      const j = await (await fetch(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`)).json();
      const d = j.data && j.data[0];
      const v = d ? { rate: +d.fundingRate, hours: +d.fundingRateInterval, next: +d.nextUpdate } : null;
      fundingCache[symbol] = { v, at: Date.now() };
      return v;
    } catch { return c ? c.v : null; }
  }

  // the Bitget client for the .env key (private calls: open orders, account)
  const keyedBitget = () => new Bitget({ key: process.env.BITGET_API_KEY, secret: process.env.BITGET_API_SECRET, passphrase: process.env.BITGET_PASSPHRASE, demo: process.env.BITGET_DEMO === '1' });

  // the open orders (委托) really resting on the exchange for a live bot, read with the .env key; cached 8 s per symbol so the
  // dashboard's refresh stays cheap. { ok, at, cids } or { ok: false, at, error }
  const pendingCache = {};
  async function pendingOn(cfg) {
    const c = pendingCache[cfg.symbol];
    if (c && Date.now() - c.at < 8e3) return c.v;
    let v;
    try {
      v = { ok: true, at: Date.now(), cids: new Set((await keyedBitget().pendingOrders(cfg.symbol, cfg.productType)).map(o => o.clientOid)) };
    } catch (e) { v = { ok: false, at: Date.now(), error: e.message }; }
    pendingCache[cfg.symbol] = { v, at: Date.now() };
    return v;
  }

  // the futures account behind the .env keys, per exchange (only those with a key): equity, unrealized P&L, free to open,
  // held by open orders. Read-only, cached 15 s. { bitget: { equity, upl, free, locked } | { error } , binance: ... }
  let accountCache = null;
  async function accounts() {
    if (accountCache && Date.now() - accountCache.at < 15e3) return accountCache.v;
    const v = {}, read = async (k, fn) => { try { v[k] = await fn(); } catch (e) { v[k] = { error: e.message }; } };
    if (process.env.BITGET_API_KEY) await read('bitget', async () => {
      const u = (await keyedBitget().req('GET', '/api/v2/mix/account/accounts', { auth: true, query: { productType: 'USDT-FUTURES' } })).find(x => x.marginCoin === 'USDT');
      return { equity: +u.usdtEquity, upl: +u.unrealizedPL, free: +u.crossedMaxAvailable, locked: +u.locked };
    });
    if (process.env.BINANCE_API_KEY) await read('binance', async () => {
      const a = await new Binance({ key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET }).req('GET', '/fapi/v2/account');
      return { equity: +a.totalMarginBalance, upl: +a.totalUnrealizedProfit, free: +a.availableBalance, locked: +a.totalOpenOrderInitialMargin };
    });
    accountCache = { v, at: Date.now() };
    return v;
  }

  function tail(file, lines) {
    if (!fs.existsSync(file)) return [];
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
  }

  // raising max add orders: the investment grows by what the new orders need, so the planned ones keep their size
  async function maxAddsPlan(bot, to) {
    if (bot.maxAdds >= 20) throw new Error('Already at the maximum of 20 add orders.');
    if (!Number.isInteger(to) || to <= bot.maxAdds || to > 20) throw new Error(`Max add orders can only go up: choose ${bot.maxAdds + 1} to 20.`);
    const cfg = bots.cfgFor(bot), st = await db.loadState(bot.id);
    const extra = Math.ceil(S.extraInvestment(cfg, st && st.pos, to) * 100) / 100;
    return { current: bot.maxAdds, to, extra, investment: bot.investment, investmentAfter: +(bot.investment + extra).toFixed(2) };
  }

  // running / starting / stopped / not responding (enabled but no recent check), from the last save of the bot's state:
  // the engine saves every check, so a recent save means the process is alive
  function statusOf(rec, st, mtime, everyMs) {
    const fresh = st && Date.now() - mtime < everyMs * 2 + 120e3, enabled = rec.enabled !== false;
    const status = rec.closedAt ? 'closed' : !enabled ? 'stopped' : fresh ? 'running' : !st || Date.now() - Date.parse(rec.updatedAt || rec.createdAt) < 120e3 ? 'starting' : 'down';
    return { fresh, enabled, status };
  }

  async function botView(bot) {
    const cfg = bots.cfgFor(bot);
    const { state: st, at: mtime } = await db.botStateRow(bot.id), queued = await db.pendingCommands(bot.id);
    // how often this bot checks now (15s with a cycle open or a limit / market entry, else its K-line): 2 missed checks + 2 min = not responding
    const checkTf = S.checkEvery(cfg, !!(st && st.pos)), every = checkTf === '15s' ? S.CYCLE_CHECK_MS : TF_MS[checkTf];
    const { fresh, enabled, status } = statusOf(bot, st, mtime, every);
    const running = enabled && fresh;
    const px = await price(cfg.symbol, cfg.broker);
    // the open martingale cycle with its levels and live P&L
    let pos = null;
    if (st && st.pos) {
      const L = S.levels(st.pos, cfg), margin = st.pos.orders.reduce((s, o) => s + (o.margin || 0), 0);
      const upnl = px ? (px - L.avg) * st.pos.qty : null;
      pos = { ...st.pos, ...L, margin, upnl, pnlPct: upnl !== null && margin ? upnl / margin * 100 : null,
        preview: S.plan(cfg, st.pos.orders[0].px) }; // pos.plan stays the cycle's fixed adds (live bots); preview = the rules applied now
    }
    // a live bot keeps its cycle on the exchange as resting orders: which of them are really pending there (null = could not ask Bitget)
    let resting = null;
    if (!bot.dryRun && st && st.pos && st.live && (bot.broker || 'bitget') === 'bitget') {
      const ex = await pendingOn(cfg), row = o => o && { px: o.px, qty: o.qty, onExchange: ex.ok ? ex.cids.has(o.cid) : null };
      resting = { checkedAt: ex.at, error: ex.ok ? null : ex.error, tp: row(st.live.tp), adds: Object.fromEntries(Object.entries(st.live.adds || {}).map(([k, o]) => [k, row(o)])) };
    }
    return {
      bot, price: px, running: !!running, status, enabled, lastSeen: mtime || null, resting,
      state: st && {
        realizedPnl: st.realizedPnl || 0, halted: st.halted, pending: st.pending,
        lastBarTs: st.lastBarTs, closed: (st.history || []).length,
      },
      pos,
      firstMargin: S.firstMargin(cfg),
      contract: await contract(cfg.symbol, cfg.broker),
      funding: await funding(cfg.symbol, cfg.broker),
      upnl: pos ? pos.upnl || 0 : 0,
      log: tail(path.join(runtime, cfg.logFile), 30),
      alerts: tail(path.join(runtime, `alerts-${bot.id}.log`), 50),
      history: st && st.history ? st.history.filter(h => h.orders).slice(-100).reverse() : [],
      // manual orders not filled yet: limit orders waiting for their price + ones the bot hasn't picked up
      manualOrders: [...((st && st.manualOrders) || []), ...queued.filter(c => c.type === 'manual').map(c => ({ ...c, queued: true }))],
      // stop / close armed at a price (already picked up by the bot, or still waiting in the queue)
      armed: { ...((st && st.armed) || {}), ...Object.fromEntries(queued.filter(c => c.type === 'stop' || c.type === 'close').map(c => [c.type, c.how === 'limit' ? { now: true, how: 'limit', limitPx: c.px, queued: true } : c.how === 'hold' ? { now: true, how: 'hold', queued: true }
        : c.px > 0 ? { px: c.px, dir: c.dir, queued: true } : { now: true, queued: true }])) },
      closing: st && st.closing ? { px: st.closing.px, qty: st.closing.qty } : null, // a closing limit sell resting on the exchange
      // an order the exchange minimum blocked: shown until the investment covers it
      short: (() => {
        const s = st && st.short;
        if (!s) return null;
        const topUp = S.topUpFor(cfg, st.pos, s.n, s.need);
        return topUp > 0.005 ? { n: s.n, need: s.need, topUp: Math.ceil(topUp * 100) / 100 } : null;
      })(),
      checkTf, lastCheck: st && st.lastCheck,
    };
  }

  // an alert-only watch: status, price, and the signals it has sent
  async function watchView(w) {
    const cfg = watches.cfgFor(w), { state: st, at: mtime } = await db.watchStateRow(w.id);
    const checkTf = watches.watchTf(cfg); // an alert looks once per candle of its shortest K-line
    const { fresh, enabled, status } = statusOf(w, st, mtime, TF_MS[checkTf]);
    return { watch: w, price: await price(cfg.symbol, cfg.broker), running: enabled && !!fresh, status, enabled, lastSeen: mtime || null,
      lastCheck: st && st.lastCheck, signals: st ? st.signals.slice(0, 30) : [], checkTf, nextCheck: enabled ? nextCheckAt(Date.now(), checkTf) : null, alerts: tail(path.join(runtime, cfg.alertsFile), 30) };
  }

  return { price, contract, funding, checkSymbol, marketFor, accounts, maxAddsPlan, botView, watchView };
}

module.exports = { createViews };
