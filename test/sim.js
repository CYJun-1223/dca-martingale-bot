// Offline test: runs the real Engine against a fake exchange with synthetic prices.
//   node test/sim.js [seed]
// Checks invariants every tick; exits 1 on any violation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../apps/server/engine');
const S = require('../apps/server/strategy');
const baseCfg = require('../apps/server/config');
const { Alerts } = require('../apps/server/alerts');
const { Recorder } = require('../apps/server/recorder');
const { Bus } = require('../apps/server/events');

let seed = +(process.argv[2] || 7);
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function makeBars(n, start = 500) {
  const bars = []; let px = start, t = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = px;
    const regime = Math.sin(i / 120) * 0.002;          // slow up/down waves
    px *= 1 + regime + (rnd() - 0.5) * 0.025;
    const h = Math.max(o, px) * (1 + rnd() * 0.006), l = Math.min(o, px) * (1 - rnd() * 0.006);
    bars.push({ ts: t, o, h, l, c: px }); t += 36e5;
  }
  return bars;
}

class FakeExchange {
  constructor(bars) { this.bars = bars; this.i = 300; this.price = bars[300].o; this.pos = 0; this.orders = new Map(); this.failNext = false; }
  async contract() { return { sizeMultiplier: '0.01', minTradeNum: '0.01', volumePlace: '2', pricePlace: '2' }; }
  async closedBars() { return this.bars.slice(Math.max(0, this.i - 300), this.i); }
  async lastPrice() { return this.price; }
  async marketOrder({ side, size, reduceOnly, clientOid }) {
    if (this.failNext) { this.failNext = false; this.orders.set(clientOid, { px: this.price, qty: +size }); this.apply(side, +size); throw new Error('simulated timeout'); }
    if (reduceOnly && +size > this.pos + 1e-9) throw new Error('reduceOnly exceeds position');
    this.apply(side, +size);
    this.orders.set(clientOid, { px: this.price, qty: +size });
    return { px: this.price, qty: +size, done: true };
  }
  apply(side, size) { this.pos = +(this.pos + (side === 'buy' ? size : -size)).toFixed(8); }
  async findOrder(cid) { return this.orders.get(cid) || null; }
  async positionQty() { return this.pos; }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soxxsim-'));
  // any signal; a smaller TP and steps so cycles complete often on synthetic data
  const cfg = { ...baseCfg, usMarketHoursOnly: false, tpPct: +(process.env.TP || 2), stepPct: 2, stepMult: 1.5, amountMult: 2, maxAdds: 5 };
  const bars = makeBars(3000);
  const ex = new FakeExchange(bars);
  let now = bars[300].ts, violations = 0, ticks = 0, maxOrders = 0;
  const fail = m => { violations++; console.log('VIOLATION:', m); };
  const alerts = new Alerts(cfg, { dir, botId: 'sim', now: () => now, send: async () => {} });
  const bus = new Bus({ onError: (err, ev) => fail(`subscriber error on ${ev.type}: ${err.message}`) });
  alerts.attach(bus);
  const ledger = []; // the trade ledger rows (the database table trades in the runner)
  new Recorder('sim', r => { ledger.push(r); }).attach(bus);
  const events = [];
  bus.subscribe(ev => { if (['open', 'add', 'close'].includes(ev.type)) events.push(ev); });
  const e = new Engine(cfg, { market: ex, executor: ex, bus }, { dir, now: () => now, marketOpen: () => true, quiet: true });
  await e.init();

  for (; ex.i < bars.length - 1; ex.i++) {
    const b = bars[ex.i];
    for (const p of [b.o, b.h, b.l, b.c]) { // 4 intrabar ticks through the forming bar
      ex.price = p; now = b.ts + 60e3;
      if (ticks === 500) ex.failNext = true; // network error after the order reached the exchange
      const before = e.st.pos ? { ...e.st.pos, orders: [...e.st.pos.orders] } : null;
      await e.tick(); ticks++;
      const pos = e.st.pos;
      const local = pos ? pos.qty : 0;
      if (Math.abs(local - ex.pos) > 1e-6) fail(`qty mismatch local ${local} vs exchange ${ex.pos} at tick ${ticks}`);
      if (e.st.halted) fail('engine halted');
      if (pos) {
        if (pos.orders.length > cfg.maxAdds + 1) fail(`${pos.orders.length} orders > ${cfg.maxAdds + 1}`);
        maxOrders = Math.max(maxOrders, pos.orders.length);
        const sumQty = +pos.orders.reduce((s, o) => s + o.qty, 0).toFixed(8);
        if (Math.abs(sumQty - pos.qty) > 1e-6) fail(`cycle #${pos.id} qty ${pos.qty} != sum of orders ${sumQty}`);
        // each add fills at or below its trigger: drop k = stepPct x (1 + stepMult + ... + stepMult^(k-1)) below the entry
        for (let k = 1; k < pos.orders.length; k++) {
          const trig = pos.orders[0].px * (1 - S.dropAt(cfg, k));
          if (pos.orders[k].px > trig + 1e-9) fail(`cycle #${pos.id} add ${k} at ${pos.orders[k].px} above trigger ${trig}`);
          const m = S.marginFor(cfg, k) / S.marginFor(cfg, k - 1);
          if (Math.abs(m - cfg.amountMult) > 1e-9) fail('amount multiple wrong');
        }
      }
      // a take profit closes everything at or above avg x (1 + tp%)
      if (before && !pos) {
        const h = e.st.history[e.st.history.length - 1];
        if (h.exitPx < h.avg * (1 + cfg.tpPct / 100) - 1e-9) fail(`cycle #${h.id} closed at ${h.exitPx} below TP ${h.avg * (1 + cfg.tpPct / 100)}`);
        if (Math.abs(h.pnl - (h.exitPx - h.avg) * h.qty) > 1e-6) fail(`cycle #${h.id} pnl wrong`);
      }
    }
  }

  const log = fs.readFileSync(path.join(dir, cfg.logFile), 'utf8');
  const count = k => (log.match(new RegExp(`TRADE ${k}\\s`, 'g')) || []).length;
  const counts = { open: count('OPEN'), add: count('ADD'), tp: count('TP') };
  const sent = k => alerts.sent.filter(a => a.kind === k).length;
  for (const k of Object.keys(counts)) if (sent(k) !== counts[k]) fail(`${k}: ${counts[k]} fills but ${sent(k)} alerts`);
  if (!sent('signal')) fail('no signal alerts');
  const rows = ledger;
  if (rows.length !== counts.open + counts.add + counts.tp) fail(`the trade ledger has ${rows.length} rows for ${counts.open + counts.add + counts.tp} fills`);
  if (counts.tp !== e.st.history.length) fail('history length != take profits');
  const histPnl = e.st.history.reduce((a, h) => a + h.pnl, 0);
  if (Math.abs(histPnl - e.st.realizedPnl) > 1e-6) fail(`history pnl ${histPnl} != realized ${e.st.realizedPnl}`);
  for (const h of e.st.history) if (!(h.openedAt <= h.closedAt)) fail(`cycle #${h.id} closed before it opened`);
  if (events.filter(x => x.type === 'open').length !== counts.open) fail('open events != opens');

  console.log(`ticks ${ticks}, bars ${bars.length - 300}`);
  console.log(`cycles ${counts.open}, adds ${counts.add}, take profits ${counts.tp}, max orders in a cycle ${maxOrders}/${cfg.maxAdds + 1}, errors logged ${(log.match(/ERROR/g) || []).length}`);
  console.log(`realized ${e.st.realizedPnl.toFixed(2)} USDT on ${cfg.investment} investment, open now ${e.st.pos ? `cycle #${e.st.pos.id} with ${e.st.pos.orders.length} orders` : 'none'}`);
  console.log(`alerts: ${['signal', 'open', 'add', 'tp', 'error'].map(k => `${k} ${sent(k)}`).join(', ')}`);
  console.log(`price ${bars[300].c.toFixed(2)} -> ${bars[bars.length - 1].c.toFixed(2)}`);
  console.log(violations ? `\n${violations} VIOLATIONS` : '\nall invariants held');
  console.log('sample log:\n' + log.split('\n').filter(l => /TRADE|ERROR|WARN/.test(l)).slice(0, 12).join('\n'));
  process.exit(violations ? 1 : 0);
})();
