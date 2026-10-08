// Unit checks for the stage modules. node test/units.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
// never the real STOP_ALL: a running live bot would pause (and cancel its orders on the exchange)
process.env.STOP_FILE = path.join(os.tmpdir(), `STOP_ALL-test-${process.pid}`);
const S = require('../strategy');
const { CHECK_TF, checkTfFor, nextCheckAt, TF_MS } = require('../market');
const { createExecutor, SimExecutor } = require('../executor');
const { Alerts, format } = require('../alerts');
const { Bus } = require('../events');
const bots = require('../bots');
const base = require('../config');

const tests = [];
const MG_INPUT = { id: 'x-1', symbol: 'BTCUSDT', tf: '4H', leverage: 3, investment: 500, maxAdds: 5, stepPct: 2, stepMult: 1.5, amountMult: 2, tpPct: 2,
  entry: { logic: 'and', window: 3, signals: [{ type: 'rsi-cross', period: 14, level: 30 }, { type: 'macd-cross', fast: 12, slow: 26, signal: 9 }] } };
const test = (name, fn) => tests.push([name, fn]);

test('check timeframe is one step below the signal timeframe', () => {
  assert.strictEqual(checkTfFor({ tf: '4H' }), '15m');
  assert.strictEqual(checkTfFor({ tf: '1H' }), '5m');
  assert.strictEqual(checkTfFor({ tf: '1D' }), '1H');
  assert.strictEqual(checkTfFor({ tf: '4H', checkTf: '5m' }), '5m');
  for (const tf of Object.keys(CHECK_TF)) assert.ok(TF_MS[CHECK_TF[tf]] <= TF_MS[tf], tf);
});

test('next check lands just after the next check-bar close', () => {
  const t = Date.UTC(2026, 8, 26, 10, 7, 30);
  assert.strictEqual(nextCheckAt(t, '15m'), Date.UTC(2026, 8, 26, 10, 15, 5));
  assert.strictEqual(nextCheckAt(t, '5m'), Date.UTC(2026, 8, 26, 10, 10, 5));
  assert.strictEqual(nextCheckAt(t, '1H'), Date.UTC(2026, 8, 26, 11, 0, 5));
  const exact = Date.UTC(2026, 8, 26, 10, 15, 0);
  assert.strictEqual(nextCheckAt(exact, '15m'), Date.UTC(2026, 8, 26, 10, 30, 5));
});

test('executor: alert mode simulates, live is refused', async () => {
  const market = { lastPrice: async () => 123.4 };
  const ex = createExecutor({ dryRun: true }, null, market);
  assert.ok(ex instanceof SimExecutor);
  assert.deepStrictEqual(await ex.marketOrder({ size: 2 }), { px: 123.4, qty: 2, done: true });
  assert.strictEqual(await ex.positionQty(), null);
  delete process.env.LIVE_TRADING;
  assert.throws(() => createExecutor({ dryRun: false }, {}, market), /Live trading is off/);
});

test('executor: live orders respect the size cap and STOP_ALL; closing skips the cap', async () => {
  const { BitgetExecutor, STOP_FILE } = require('../executor');
  const sent = [];
  const api = { ticker: async () => ({ lastPr: '100' }), placeOrder: async b => sent.push(b),
    orderDetail: async () => ({ state: 'filled', baseVolume: '1', priceAvg: '100' }) };
  const ex = new BitgetExecutor(api, { symbol: 'SMHUSDT', productType: 'USDT-FUTURES', marginCoin: 'USDT' });
  process.env.MAX_ORDER_USDT = '300';
  await assert.rejects(ex.marketOrder({ side: 'buy', size: 4, reduceOnly: false, clientOid: 'a' }), /over the 300 USDT cap/);
  assert.strictEqual(sent.length, 0);
  await ex.marketOrder({ side: 'sell', size: 4, reduceOnly: true, clientOid: 'b' });
  assert.strictEqual(sent.length, 1);
  fs.writeFileSync(STOP_FILE, 'x');
  try { await assert.rejects(ex.marketOrder({ side: 'sell', size: 1, reduceOnly: true, clientOid: 'c' }), /Trading is paused/); }
  finally { fs.unlinkSync(STOP_FILE); delete process.env.MAX_ORDER_USDT; }
  assert.strictEqual(sent.length, 1);
});

test('executor: Binance adapter sends Binance names and reads Binance replies', async () => {
  const { BinanceExecutor } = require('../executor');
  const sent = [], orders = { f1: { orderId: 77, status: 'FILLED', executedQty: '0.5', avgPrice: '620.1', updateTime: 1791300000000 } };
  const api = { base: 'x', placeOrder: async b => sent.push(b),
    order: async (sym, cid) => { if (orders[cid]) return orders[cid]; const e = new Error('Binance -2013: Order does not exist.'); e.code = -2013; throw e; },
    openOrders: async () => [{ clientOrderId: 'sx1a1r1', side: 'BUY', price: '600.5', origQty: '0.2', executedQty: '0' }],
    userTrades: async (sym, id) => id === 77 ? [{ commission: '-0.07' }, { commission: '0.054' }] : [],
    positionRisk: async () => [{ symbol: 'SMHUSDT', positionAmt: '0.7' }] };
  const ex = new BinanceExecutor(api, { symbol: 'SMHUSDT', leverage: 10 });
  ex.lastPrice = async () => 620;
  process.env.MAX_ORDER_USDT = '300';
  try {
    await ex.limitOrder({ side: 'buy', size: 0.2, price: 600.5, reduceOnly: false, clientOid: 'sx1a1r1' });
    assert.deepStrictEqual(sent[0], { symbol: 'SMHUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '0.2', price: '600.5', reduceOnly: 'false', newClientOrderId: 'sx1a1r1' });
    await assert.rejects(ex.limitOrder({ side: 'buy', size: 1, price: 600, reduceOnly: false, clientOid: 'big' }), /over the 300 USDT cap/);
    assert.deepStrictEqual(await ex.marketOrder({ side: 'sell', size: 0.5, reduceOnly: true, clientOid: 'f1' }), { px: 620.1, qty: 0.5, done: true, fee: 0.124, ts: 1791300000000 });
    assert.deepStrictEqual(sent[1], { symbol: 'SMHUSDT', side: 'SELL', type: 'MARKET', quantity: '0.5', reduceOnly: 'true', newClientOrderId: 'f1' });
  } finally { delete process.env.MAX_ORDER_USDT; }
  assert.deepStrictEqual(await ex.orderState('f1'), { px: 620.1, qty: 0.5, fee: 0.124, ts: 1791300000000 }, 'fee = sum of the trades commission');
  assert.strictEqual(await ex.orderState('gone'), null, 'unknown order = null, like Bitget');
  assert.strictEqual(await ex.findOrder('gone'), null);
  assert.deepStrictEqual(await ex.pendingOrders(), [{ cid: 'sx1a1r1', side: 'buy', px: 600.5, size: 0.2, filled: 0 }]);
  assert.strictEqual(await ex.positionQty(), 0.7);
  process.env.LIVE_TRADING = '1';
  try { assert.ok(createExecutor({ dryRun: false, broker: 'binance' }, { binance: api }, null) instanceof BinanceExecutor); }
  finally { delete process.env.LIVE_TRADING; }
});

test('bots: live bots are rejected unless LIVE_TRADING=1', () => {
  delete process.env.LIVE_TRADING;
  const input = { ...MG_INPUT, dryRun: false };
  assert.throws(() => bots.validate(input, []), /Live trading is off/);
  process.env.LIVE_TRADING = '1';
  assert.strictEqual(bots.validate(input, []).dryRun, false);
  delete process.env.LIVE_TRADING;
  assert.strictEqual(bots.validate({ ...input, dryRun: true, checkTf: '1D' }, []).checkTf, undefined, 'the old check-interval setting is ignored, never rejected');
});

test('alerts: log file always, sender when configured, failures swallowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
  const got = [];
  const a = new Alerts({ symbol: 'SOXXUSDT', dryRun: true }, { dir, botId: 'b1', send: async t => got.push(t) });
  await a.send('open', 'Opened #1');
  assert.match(fs.readFileSync(a.file, 'utf8'), /OPEN\s+Opened #1/);
  assert.match(got[0], /SOXXUSDT · Bitget · b1\nOpened #1/);
  const bad = new Alerts({ symbol: 'X', dryRun: true }, { dir, botId: 'b2', send: async () => { throw new Error('down'); } });
  await bad.send('error', 'boom'); // must not throw
  assert.match(fs.readFileSync(bad.file, 'utf8'), /ALERTERR telegram: down/);
});

test('decide: a signal opens a cycle only when none is open; adds and TP follow the price', () => {
  const cfg = { ...base, investment: 630, maxAdds: 5, stepPct: 2, stepMult: 1.5, amountMult: 2, tpPct: 2, leverage: 3 };
  // steady series then a sharp drop -> close crosses below the lower band
  const bars = Array.from({ length: 60 }, (_, i) => ({ ts: i * 36e5, c: 100 + Math.sin(i) * 0.5 }));
  bars.push({ ts: 60 * 36e5, c: 90 });
  const none = { pos: null, lastBarTs: 0, halted: false };
  assert.strictEqual(S.decide(none, bars, 90, cfg, true).entry, true);
  assert.strictEqual(S.decide({ ...none, lastBarTs: 60 * 36e5 }, bars, 90, cfg, true).newBar, false, 'same bar twice');
  assert.strictEqual(S.decide(none, bars, 90, cfg, false).ignored, 'outside US market hours');
  assert.strictEqual(S.decide({ ...none, seq: 2 }, bars, 90, { ...cfg, maxCycles: 2 }, true).entry, false, 'cycle limit reached');
  assert.strictEqual(S.decide({ ...none, seq: 1 }, bars, 90, { ...cfg, maxCycles: 2 }, true).entry, true, 'below the cycle limit');
  const pos = { id: 1, orders: [{ n: 0, px: 100, qty: 1, margin: 10 }], qty: 1, cost: 100 };
  const d = S.decide({ ...none, pos }, bars, 99, cfg, true);
  assert.strictEqual(d.entry, false); assert.strictEqual(d.ignored, 'a cycle is already open');
  assert.strictEqual(d.add, null, '1% down: no add yet');
  assert.deepStrictEqual(S.decide({ ...none, pos, lastBarTs: 1e15 }, bars, 98, cfg, true).add, { n: 1, margin: 20 }, '2% down: add 1 (first order 10 x 2)');
  assert.deepStrictEqual(S.decide({ ...none, pos, lastBarTs: 1e15 }, bars, 102, cfg, true).exit, { kind: 'tp', qty: 1 }, 'avg 100 + 2% = TP');
  const two = { id: 1, orders: [{ n: 0, px: 100, qty: 1 }, { n: 1, px: 98, qty: 2 }], qty: 3, cost: 296 };
  const L = S.levels(two, cfg);
  assert.ok(Math.abs(L.avg - 98.6667) < 1e-4 && Math.abs(L.tp - 98.6667 * 1.02) < 1e-4);
  assert.ok(Math.abs(L.nextAdd - 100 * 0.95) < 1e-9, 'add 2 = 2% + 2% x 1.5 = 5% below the entry');
});

test('martingale plan: first order from the investment, steps and amounts multiply', () => {
  const cfg = { investment: 630, maxAdds: 5, stepPct: 2, stepMult: 1.5, amountMult: 2, tpPct: 2, leverage: 3 };
  assert.strictEqual(S.firstMargin(cfg), 10, '630 / (1+2+4+8+16+32)');
  const p = S.plan(cfg, 100);
  assert.deepStrictEqual(p.map(r => +r.orderMargin.toFixed(6)), [10, 20, 40, 80, 160, 320]);
  assert.ok(Math.abs(p[5].margin - 630) < 1e-9, 'all orders use exactly the investment');
  const drops = [0, 2, 5, 9.5, 16.25, 26.375]; // 2, 3, 4.5, 6.75, 10.125 added up, all from the entry
  drops.forEach((d, k) => assert.ok(Math.abs(p[k].px - 100 * (1 - d / 100)) < 1e-9, `order ${k} price`));
  assert.ok(p.every(r => Math.abs(r.tp - r.avg * 1.02) < 1e-9));
  assert.strictEqual(S.firstMargin({ ...cfg, amountMult: 1 }), 105, 'amount x1 = equal orders');
});

test('DCA order rules: the reference table (T 150, 20 adds, 10x, entry 639.4, step 0.85% x 1.02, amount x 1.12, first order = A)', () => {
  const cfg = { investment: 150, maxAdds: 20, leverage: 10, stepPct: 0.85, stepMult: 1.02, amountMult: 1.12, tpPct: 1 };
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 5e-5, `${msg}: ${a} vs ${b}`);
  close(S.firstMargin(cfg), 1.8360, 'first order = A = 150 / sum(1.12^0..20)');
  const rows = S.plan(cfg, 639.4), down = x => Math.floor(x * 100 + 1e-9) / 100;
  assert.ok(Math.abs(rows[20].margin - 150) < 1e-9, 'all of T goes into the orders');
  const t = rows.map(r => [down(r.px), +r.orderMargin.toFixed(2), down(r.notional / r.px)]);
  assert.deepStrictEqual(t[0], [639.4, 1.84, 0.02]);
  assert.deepStrictEqual(t[1], [633.96, 2.06, 0.02]);
  assert.deepStrictEqual(t[20], [507.34, 17.71, 0.31]);
  assert.strictEqual(+rows[20].dropPct.toFixed(2), 20.65);
  assert.strictEqual(+t.reduce((s, [px, , q]) => s + px * q, 0).toFixed(2), 1282.95, 'total position value');
  // the live ladder after the first fill: same prices and sizes, rounded down to the exchange steps
  const rules = { q: x => down(x), pdp: 2, minQty: 0.01, minNotional: 5 };
  const pos = { orders: [{ n: 0, px: 639.4, qty: 0.02, margin: S.firstMargin(cfg) }], qty: 0.02, cost: 12.788 };
  const l = S.ladder(pos, cfg, rules).adds;
  assert.deepStrictEqual([l[0].px, l[0].qty], [633.96, 0.02]);
  assert.deepStrictEqual([l[19].px, l[19].qty], [507.34, 0.31]);
});

test('entry group: OR fires on any condition, AND needs all within the window', () => {
  // prices fall then rise: MACD crosses up first, RSI crosses 30 a few bars later
  const c = [...Array.from({ length: 80 }, (_, i) => 200 - i), ...Array.from({ length: 60 }, (_, i) => 120 + i * 1.5)];
  const macdSig = { type: 'macd-cross', fast: 12, slow: 26, signal: 9 }, rsiSig = { type: 'rsi-cross', period: 14, level: 30 };
  const at = entry => c.map((_, i) => S.entrySignal(c.slice(0, i + 1), entry)).map((x, i) => x ? i : -1).filter(i => i >= 0);
  const m = at({ logic: 'or', signals: [macdSig] })[0], r = at({ logic: 'or', signals: [rsiSig] })[0];
  assert.deepStrictEqual(at({ logic: 'or', signals: [macdSig, rsiSig] }), [m, r].sort((a, b) => a - b));
  const gap = Math.abs(r - m);
  assert.deepStrictEqual(at({ logic: 'and', window: gap + 1, signals: [macdSig, rsiSig] }), [Math.max(m, r)], 'AND fires when the second one crosses');
  assert.deepStrictEqual(at({ logic: 'and', window: gap, signals: [macdSig, rsiSig] }), [], 'too far apart for the window');
  assert.throws(() => bots.parseEntry({ logic: 'and', signals: [] }), /1 to 5/);
  assert.match(S.describeEntry({ logic: 'and', window: 3, signals: [macdSig, rsiSig] }), /MACD\(12, 26, 9\) golden cross AND RSI\(14\) .* \[AND within 3 bars\]/);

  // groups: (MACD AND RSI) OR (a condition that never fires) behaves like the AND group alone
  const never = { type: 'ma-cross', ma: 'sma', fast: 5, slow: 6 }; // prices only fall then rise once: check it
  const nv = at({ logic: 'or', signals: [never] });
  const grouped = { logic: 'or', window: gap + 1, groups: [{ logic: 'and', signals: [macdSig, rsiSig] }, { logic: 'or', signals: [never] }] };
  assert.deepStrictEqual(at(grouped), [...new Set([Math.max(m, r), ...nv])].sort((a, b) => a - b), '(A AND B) OR C');
  // groups joined by AND: every group must fire within the window
  const both = { logic: 'and', window: gap + 1, groups: [{ logic: 'or', signals: [macdSig] }, { logic: 'or', signals: [rsiSig] }] };
  assert.deepStrictEqual(at(both), [Math.max(m, r)], '(A) AND (B) = A AND B');
  assert.match(S.describeEntry(grouped), /^\(MACD\(12, 26, 9\) golden cross AND RSI\(14\) crosses up through 30\) OR \(SMA 5\/6 golden cross\)/);
  assert.throws(() => bots.parseEntry({ logic: 'or', groups: [{ logic: 'and', signals: [] }] }), /group 1 needs 1 to 5 conditions/);
  assert.throws(() => bots.parseEntry({ logic: 'or', groups: [{ signals: [macdSig] }, { signals: [{ type: 'rsi-cross', period: 14, level: 200 }] }] }), /group 2, condition 1: level/);
  assert.deepStrictEqual(bots.parseEntry({ logic: 'and', window: 4, signals: [macdSig] }), { logic: 'or', window: 4, groups: [{ logic: 'and', signals: [macdSig] }], volatility: null }, 'old flat shape = one group');
});

test('bus: every subscriber gets each event; a failing one does not stop the others', async () => {
  const errs = [], seen = [];
  const bus = new Bus({ onError: e => errs.push(e.message) });
  bus.subscribe(() => { throw new Error('sync boom'); });
  bus.subscribe(async () => { throw new Error('async boom'); });
  bus.subscribe(ev => seen.push(ev.type));
  bus.emit('open', { id: 1 }); bus.emit('close', { id: 1 });
  await new Promise(r => setImmediate(r));
  assert.deepStrictEqual(seen, ['open', 'close']);
  assert.deepStrictEqual(errs.sort(), ['async boom', 'async boom', 'sync boom', 'sync boom']);
});

test('alerts: open / close events become readable messages with times', () => {
  const base = { symbol: 'SOXXUSDT', tf: '1H', mode: 'SIM', pdp: 2, ts: Date.UTC(2026, 8, 27, 2, 0) };
  const [k1, m1] = format({ ...base, type: 'open', id: 3, n: 0, maxAdds: 5, px: 570, qty: 0.08, margin: 15.87, totalMargin: 15.87, avg: 570, tp: 581.4, nextAdd: 558.6 });
  assert.strictEqual(k1, 'open'); assert.match(m1, /Cycle #3 opened at 2026-09-27 \d\d:00: 0\.08 @ 570\.00 \(15\.87 USDT margin\)\navg 570\.00 · TP 581\.40 · next add 558\.60/);
  const [k2, m2] = format({ ...base, type: 'add', id: 3, n: 2, maxAdds: 5, px: 545, qty: 0.35, margin: 63.49, totalMargin: 111.11, avg: 554, tp: 565.08, nextAdd: null });
  assert.strictEqual(k2, 'add'); assert.match(m2, /Cycle #3 add 2\/5 [\s\S]* no adds left · margin used 111\.11 USDT/);
  const [k3, m3] = format({ ...base, type: 'close', kind: 'tp', id: 3, px: 565.1, qty: 0.58, avg: 554, orders: 3, pnl: 6.44, pnlPct: 5.8, realized: 80,
    openedAt: base.ts - 3 * 864e5 - 2 * 36e5, heldMs: 3 * 864e5 + 2 * 36e5 });
  assert.strictEqual(k3, 'tp'); assert.match(m3, /Cycle #3 take profit .* \(avg 554\.00, 3 orders\)\nP&L \+6\.44 USDT \(\+5\.80% on margin\) · opened .*, held 3d 2h/);
  assert.strictEqual(format({ type: 'unknown' }), null);
});

test('RSI matches Wilder / TA-Lib on the StockCharts example data', () => {
  const { rsi } = require('../indicators');
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const r = rsi(c, 14);
  assert.strictEqual(r[13], null);
  // TA-Lib / TradingView (unrounded). StockCharts' table shows 70.53, 66.32, ... because it rounds the averages
  [70.46, 66.25, 66.48, 69.35, 66.29, 57.92].forEach((v, k) => assert.ok(Math.abs(r[14 + k] - v) < 0.02, `rsi[${14 + k}] ${r[14 + k]} vs ${v}`));
});

test('MACD: line = EMA(fast) - EMA(slow), signal = EMA of the line, hist = difference', () => {
  const { macd, ema } = require('../indicators');
  const c = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 9) + i * 0.1);
  const m = macd(c, 12, 26, 9), f = ema(c, 12), s = ema(c, 26);
  assert.strictEqual(m.line[24], null); assert.strictEqual(m.signal[32], null);
  assert.ok(m.signal[33] !== null, 'signal starts after slow + signal - 2 bars');
  for (let i = 25; i < c.length; i++) assert.ok(Math.abs(m.line[i] - (f[i] - s[i])) < 1e-9);
  const seed = m.line.slice(25, 34).reduce((a, b) => a + b, 0) / 9;
  assert.ok(Math.abs(m.signal[33] - seed) < 1e-9, 'signal seeded with SMA of the first 9 MACD values');
  for (let i = 34; i < c.length; i++) assert.ok(Math.abs(m.hist[i] - (m.line[i] - m.signal[i])) < 1e-9);
});

test('entry signals fire once, on the bar that crosses', () => {
  const { macd, rsi } = require('../indicators');
  // falling then rising prices: MACD golden cross and RSI leaving oversold both happen once
  const c = [...Array.from({ length: 80 }, (_, i) => 200 - i), ...Array.from({ length: 60 }, (_, i) => 120 + i * 1.5)];
  const fires = sig => c.map((_, i) => S.entrySignal(c.slice(0, i + 1), { logic: 'or', signals: [sig] })).map((x, i) => x ? i : -1).filter(i => i >= 0);
  const mc = fires({ type: 'macd-cross', fast: 12, slow: 26, signal: 9 });
  assert.strictEqual(mc.length, 1, `macd fired ${mc}`);
  const m = macd(c, 12, 26, 9), i = mc[0];
  assert.ok(m.line[i - 1] <= m.signal[i - 1] && m.line[i] > m.signal[i]);
  const rc = fires({ type: 'rsi-cross', period: 14, level: 30 });
  assert.strictEqual(rc.length, 1, `rsi fired ${rc}`);
  const r = rsi(c, 14);
  assert.ok(r[rc[0] - 1] <= 30 && r[rc[0]] > 30);
});

test('bots: each indicator validates its own fields', () => {
  const ok = s => bots.parseSignal(s);
  assert.deepStrictEqual(ok({ type: 'macd-cross', fast: '12', slow: '26', signal: '9' }), { type: 'macd-cross', fast: 12, slow: 26, signal: 9 });
  assert.deepStrictEqual(ok({ type: 'rsi-cross', period: 14, level: 30 }), { type: 'rsi-cross', period: 14, level: 30 });
  assert.deepStrictEqual(ok({ type: 'ma-cross', ma: 'ema', fast: 20, slow: 50 }), { type: 'ma-cross', ma: 'ema', fast: 20, slow: 50 });
  assert.deepStrictEqual(ok({ type: 'boll-revert', period: 20, mult: 2.5 }), { type: 'boll-revert', period: 20, mult: 2.5 });
  assert.throws(() => ok({ type: 'macd-cross', fast: 26, slow: 12, signal: 9 }), /fast must be smaller/);
  assert.throws(() => ok({ type: 'rsi-cross', period: 14, level: 150 }), /level/);
  assert.throws(() => ok({ type: 'macd-cross', fast: 12, slow: 26 }), /signal/);
  assert.throws(() => ok({ type: 'kdj' }), /signal type/);
  assert.strictEqual(S.describe({ type: 'macd-cross', fast: 12, slow: 26, signal: 9 }), 'MACD(12, 26, 9) golden cross');
});

test('bots: martingale fields are validated', () => {
  const b = bots.validate(MG_INPUT, []);
  assert.deepStrictEqual([b.investment, b.maxAdds, b.stepPct, b.stepMult, b.amountMult, b.tpPct], [500, 5, 2, 1.5, 2, 2]);
  assert.strictEqual(b.entry.groups[0].logic, 'and'); assert.strictEqual(b.entry.groups[0].signals.length, 2);
  for (const k of ['capitalUSDT', 'parts', 'tps', 'signal']) assert.ok(!(k in b), `no old field ${k}`);
  assert.throws(() => bots.validate({ ...MG_INPUT, maxAdds: 2.5 }, []), /whole number/);
  assert.throws(() => bots.validate({ ...MG_INPUT, stepPct: 40, stepMult: 3 }, []), /steps are too large/);
  assert.throws(() => bots.validate({ ...MG_INPUT, tpPct: 0 }, []), /tpPct/);
  assert.throws(() => bots.validate({ ...MG_INPUT, entry: { logic: 'or', signals: [{ type: 'rsi-cross', period: 14, level: 300 }] } }, []), /condition 1: level/);
});

test('upgrading keeps open positions and history (old portion state -> martingale cycle)', () => {
  const { Engine } = require('../engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const old = { seq: 3, lastBarTs: 123, realizedPnl: 12.5, halted: false, pending: null,
    portions: [{ id: 3, entryPx: 95, qty: 1, remaining: 1, openedAt: 2000 }, { id: 2, entryPx: 100, qty: 1, remaining: 0.4, openedAt: 1000, tp1Done: true }],
    history: [{ id: 1, entryPx: 90, qty: 1, openedAt: 500, closedAt: 900, exits: [], pnl: 12.5 }] };
  const e = new Engine({ ...base, leverage: 2, logFile: 'bot.log' }, { market: {}, executor: {} }, { dir, quiet: true, state: old });
  const p = e.st.pos;
  assert.strictEqual(e.migrated, 2);
  assert.deepStrictEqual(p.orders.map(o => [o.px, o.qty, o.ts]), [[100, 0.4, 1000], [95, 1, 2000]], 'oldest first, remaining qty, original times');
  assert.strictEqual(p.qty, 1.4); assert.strictEqual(p.cost, 135); assert.strictEqual(p.openedAt, 1000);
  assert.ok(Math.abs(p.orders[0].margin - 100 * 0.4 * (1.1 / 2 + 1.1 * 0.0006)) < 1e-9, 'margin = price x qty x (1.1 / leverage + 1.1 x fee)');
  assert.strictEqual(e.st.realizedPnl, 12.5); assert.strictEqual(e.st.lastBarTs, 123);
  assert.strictEqual(e.st.legacyHistory.length, 1, 'closed portions kept'); assert.strictEqual(e.st.legacyPortions.length, 2);
  assert.deepStrictEqual(old.portions.length, 2, 'the saved state itself is never changed in place');
});

test('manual orders sit on top of the investment; planned adds follow the plan; volatility filter', () => {
  const cfg = { investment: 1000, maxAdds: 20, amountMult: 1.12, stepPct: 0.8, stepMult: 1.04, tpPct: 2.4 };
  // the carried-over position: first order per plan + the rest as a manual order
  const first = S.marginFor(cfg, 0);
  assert.ok(Math.abs(first - 12.2395) < 1e-3, `1000 / sum(1.12^0..20) = ${first}`);
  const p = { orders: [{ n: 0, px: 573.68, qty: 0.06, margin: first }, { n: null, px: 573.68, qty: 0.98, margin: 0.98 * 573.68 / 3, manual: true }], qty: 1.04, cost: 1.04 * 573.68 };
  assert.strictEqual(S.planned(p).length, 1, 'manual orders are not part of the ladder');
  for (let k = 1; k <= 20; k++) assert.ok(Math.abs(S.addMargin(cfg, p, k) - S.marginFor(cfg, k)) < 1e-9, `add ${k} follows the plan`);
  const L = S.levels(p, cfg);
  assert.ok(Math.abs(L.nextAdd - 573.68 * 0.992) < 1e-9, 'next add measured from the entry');
  assert.ok(Math.abs(L.avg - 573.68) < 1e-9);
  // an order that used more than planned changes nothing: every add stays A x amountMult^k
  assert.strictEqual(S.addMargin(cfg, { orders: [{ margin: 198.88 }] }, 5), S.marginFor(cfg, 5), 'adds are fixed');
  // ATR as % of price
  const { atr } = require('../indicators');
  const bars = Array.from({ length: 30 }, (_, i) => ({ h: 101, l: 99, c: 100 }));
  assert.ok(Math.abs(atr(bars, 14)[29] - 2) < 1e-9, 'constant 2-point range -> ATR 2');
  assert.strictEqual(S.volatilityCheck(bars, { period: 14, minPct: 1 }).ok, true);
  assert.match(S.volatilityCheck(bars, { period: 14, minPct: 3 }).reason, /2\.00% is below the 3% minimum/);
  assert.match(S.volatilityCheck(bars, { period: 14, maxPct: 1.5 }).reason, /above the 1\.5% maximum/);
  assert.strictEqual(S.volatilityCheck(bars, null), null);
  assert.deepStrictEqual(bots.parseEntry({ logic: 'or', signals: [{ type: 'rsi-cross', period: 14, level: 30 }], volatility: { minPct: '0.5', maxPct: '' } }).volatility, { period: 14, minPct: 0.5, maxPct: null });
  assert.throws(() => bots.parseEntry({ logic: 'or', signals: [{ type: 'rsi-cross', period: 14, level: 30 }], volatility: { minPct: 3, maxPct: 2 } }), /minimum must be below/);
});

test('manual orders: market (taker) fills at the next check, limit (maker) waits; buy adds, sell reduces', async () => {
  const { Engine } = require('../engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'man-'));
  const cfg = { ...base, investment: 1000, maxAdds: 5, amountMult: 2, stepPct: 2, stepMult: 1, tpPct: 2, leverage: 2, logFile: 'bot-x.log' };
  const e = new Engine(cfg, { market: {}, executor: {} }, { dir, quiet: true });
  e.q = x => +(Math.floor(x / 0.01 + 1e-9) * 0.01).toFixed(2); e.minQty = 0.01; e.pdp = 2;
  const queue = cmds => { e.store.cmds.push(...cmds); return e.applyCommands(); };
  await queue([{ type: 'manual', ref: 'a', side: 'buy', orderType: 'market', qty: 3 }, { type: 'manual', ref: 'b', side: 'buy', orderType: 'limit', px: 90, qty: 2 },
    { type: 'manual', ref: 'c', side: 'sell', orderType: 'limit', px: 120, qty: 1 }]);
  assert.strictEqual(e.store.cmds.length, 0, 'queue consumed');
  assert.ok(e.store.saved && e.store.saved.manualOrders.length === 3, 'saved after taking them');
  e.processManual(100); // market buy fills at 100; limit buy (90) and limit sell (120) wait
  assert.deepStrictEqual(e.st.pos.orders.map(o => [o.px, o.qty, o.margin, o.orderType]), [[100, 3, 150, 'market']]);
  assert.ok(Math.abs(e.st.pos.orders[0].fee - 100 * 3 * 0.0006) < 1e-12, 'taker fee');
  assert.deepStrictEqual(e.st.manualOrders.map(o => o.ref), ['b', 'c']);
  e.processManual(89); // limit buy fills at its limit 90 (maker)
  assert.deepStrictEqual(e.st.pos.orders.map(o => o.px), [100, 90]);
  assert.ok(Math.abs(e.st.pos.orders[1].fee - 90 * 2 * 0.0002) < 1e-12, 'maker fee');
  assert.ok(Math.abs(S.levels(e.st.pos, cfg).avg - 96) < 1e-9);
  e.processManual(121); // limit sell 1 @ 120: realizes (120 - 96) x 1 - fee, average unchanged
  assert.strictEqual(e.st.pos.qty, 4);
  assert.ok(Math.abs(e.st.realizedPnl - (24 - 120 * 0.0002)) < 1e-9);
  assert.ok(Math.abs(S.levels(e.st.pos, cfg).avg - 96) < 1e-9, 'average stays after a reduce');
  await queue([{ type: 'manual', ref: 'd', side: 'sell', orderType: 'limit', px: 200, qty: 1 }, { type: 'cancel', ref: 'd' }]);
  assert.strictEqual(e.st.manualOrders.length, 0, 'cancelled');
  await queue([{ type: 'manual', ref: 'e', side: 'sell', orderType: 'market', qty: 10 }]);
  e.processManual(100); // sell everything: the cycle closes into history with all its P&L
  assert.strictEqual(e.st.pos, null);
  const h = e.st.history[e.st.history.length - 1];
  assert.ok(Math.abs(h.pnl - e.st.realizedPnl) < 1e-9, 'cycle P&L = reduces');
  assert.strictEqual(h.closedBy, 'manual');
});

test('raising max adds: the extra investment keeps every planned order at its size', () => {
  const cfg = { ...base, investment: 1000, maxAdds: 5, amountMult: 2, leverage: 2 };
  const after = (pos, to) => ({ ...cfg, maxAdds: to, investment: cfg.investment + S.extraInvestment(cfg, pos, to) });
  assert.strictEqual(S.extraInvestment(cfg, null, 5), 0, 'not an increase');
  // no cycle yet: same first order, bigger ladder
  assert.ok(Math.abs(S.firstMargin(after(null, 7)) - S.firstMargin(cfg)) < 1e-9);
  // first order filled: add #1 and #5 keep their size
  const pos = { orders: [{ n: 0, margin: S.firstMargin(cfg), px: 100, qty: 1 }], qty: 1, cost: 100 };
  const a = after(pos, 8);
  for (const k of [1, 3, 5]) assert.ok(Math.abs(S.addMargin(a, pos, k) - S.addMargin(cfg, pos, k)) < 1e-9, 'add ' + k);
  assert.ok(S.extraInvestment(cfg, pos, 8) > 0);
  // every planned order already placed: the new ones continue from the last size
  const full = { orders: Array.from({ length: 6 }, (_, n) => ({ n, margin: S.marginFor(cfg, n), px: 100 - n, qty: 1 })), qty: 6, cost: 600 };
  assert.ok(Math.abs(S.extraInvestment(cfg, full, 6) - S.marginFor(cfg, 6)) < 1e-9);
});

test('armed close / stop fire when the price reaches the level; close sells the position and ends the bot', async () => {
  const { Engine } = require('../engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-'));
  const cfg = { ...base, investment: 1000, maxAdds: 5, amountMult: 2, leverage: 2, logFile: 'bot-x.log' };
  const executor = { marketOrder: async ({ size }) => ({ px: 121, qty: size, done: true }), findOrder: async () => null };
  const e = new Engine(cfg, { market: {}, executor }, { dir, quiet: true });
  e.q = x => +x.toFixed(2); e.minQty = 0.01; e.pdp = 2;
  e.st.pos = { id: 1, openedAt: 1, orders: [{ n: 0, ts: 1, px: 100, qty: 2, margin: 100 }], qty: 2, cost: 200 };
  const queue = cmds => { e.store.cmds.push(...cmds); return e.applyCommands(); };
  await queue([{ type: 'stop', px: 90, dir: 'down' }, { type: 'close', px: 120, dir: 'up' }]);
  assert.ok(e.st.armed.stop && e.st.armed.close);
  assert.strictEqual(await e.processArmed(105), null, 'neither level reached');
  await queue([{ type: 'disarm', what: 'stop' }]);
  assert.ok(!e.st.armed.stop, 'stop cancelled');
  assert.strictEqual(await e.processArmed(121), 'close');
  assert.strictEqual(e.st.pos, null);
  assert.ok(e.st.closedAt);
  const h = e.st.history[e.st.history.length - 1];
  assert.strictEqual(h.closedBy, 'closed');
  assert.ok(Math.abs(h.pnl - 42) < 1e-9, 'sold 2 at 121 from avg 100');
  // stop at a price on the way down
  e.st.armed = null; await queue([{ type: 'stop', px: 90, dir: 'down' }]);
  assert.strictEqual(await e.processArmed(91), null);
  assert.strictEqual(await e.processArmed(89), 'stop');
});

test('minimum order margin and top-up; a too-small order is skipped with one notice', async () => {
  const rules = { step: 0.01, qdp: 2, minQty: 0.01, minValue: 5 };
  assert.ok(Math.abs(S.minOrderMargin(570, 3, rules) - 0.01 * 570 * (1.1 / 3 + 1.1 * 0.0006)) < 1e-9);
  const cfg = { ...base, investment: 100, maxAdds: 5, amountMult: 2, leverage: 1 };
  const up = S.topUpFor(cfg, null, 0, 10);
  assert.ok(Math.abs(S.firstMargin({ ...cfg, investment: cfg.investment + up }) - 10) < 1e-9, 'first order reaches the minimum');
  assert.strictEqual(S.topUpFor(cfg, null, 0, 1), 0, 'already enough');
  const { Engine } = require('../engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'short-'));
  const bus = new Bus(), seen = [];
  bus.subscribe(ev => seen.push(ev));
  const e = new Engine({ ...cfg, logFile: 'bot-x.log' }, { market: {}, executor: { marketOrder: async ({ size }) => ({ px: 100, qty: size, done: true }) }, bus }, { dir, quiet: true });
  Object.assign(e, { step: 0.01, qdp: 2, minQty: 0.01, minNotional: 5, pdp: 2 });
  e.q = x => +(Math.floor(x / 0.01 + 1e-9) * 0.01).toFixed(2);
  await e.buy('open', 0, 100);
  await e.buy('open', 0, 100);
  assert.strictEqual(e.st.pos, null, 'nothing opened');
  assert.strictEqual(seen.filter(x => x.type === 'error').length, 1, 'told once');
  assert.ok(e.st.short.topUp > 0 && e.st.short.n === 0);
  e.cfg.investment += e.st.short.topUp + 0.01; // the user adds funds
  await e.buy('open', 0, 100);
  assert.ok(e.st.pos && e.st.pos.orders.length === 1, 'opens once funded');
  assert.strictEqual(e.st.short, null);
});

test('fees: every order and the exit keep the fee the exchange reported, else the standard rate for the order type', async () => {
  const { Engine } = require('../engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fees-'));
  const cfg = { ...base, broker: 'bitget', investment: 1000, maxAdds: 5, amountMult: 1, leverage: 1, logFile: 'bot-f.log' };
  let reported = 0.123; // the exchange's fee for the next market fill; undefined = unknown
  const e = new Engine(cfg, { market: {}, executor: { marketOrder: async ({ size }) => ({ px: 100, qty: size, done: true, fee: reported }) } }, { dir, quiet: true });
  Object.assign(e, { step: 0.01, qdp: 2, minQty: 0.01, minNotional: 5, pdp: 2 });
  await e.buy('open', 0, 100);
  assert.deepStrictEqual([e.st.pos.orders[0].fee, e.st.pos.orders[0].feeEst, e.st.pos.orders[0].orderType], [0.123, undefined, 'market']);
  e.applyFill({ kind: 'add', margin: 10 }, { px: 90, qty: 1, orderType: 'limit' }); // resting add, fee not reported
  const add = e.st.pos.orders[1];
  assert.ok(Math.abs(add.fee - 90 * 0.0002) < 1e-12 && add.feeEst === true && add.orderType === 'limit', 'Bitget maker rate');
  e.applyFill({ kind: 'tp' }, { px: 110, qty: e.st.pos.qty, fee: 0.05, ts: 1000, orderType: 'limit' });
  const h = e.st.history[e.st.history.length - 1];
  assert.deepStrictEqual(h.exit, { ts: 1000, px: 110, qty: h.qty, orderType: 'limit', fee: 0.05 }, 'the exchange fill time is kept');
  assert.strictEqual(h.closedAt, 1000);
  e.cfg.broker = 'binance'; reported = undefined;
  assert.strictEqual(e.feeOf({ px: 100, qty: 1 }, 'limit').fee, 0, 'Binance maker 0%');
  assert.ok(Math.abs(e.feeOf({ px: 100, qty: 1 }, 'market').fee - 0.04) < 1e-12, 'Binance taker 0.04%');
});

test('alert-only watch: silent on the first look, one message when the indicator fires on a new candle, none twice', async () => {
  const { checkOnce } = require('../watcher');
  const watches = require('../watches');
  const w = watches.validate({ id: 'w-x', name: 'W X', symbol: 'SOXXUSDT', tf: '1H', entry: { logic: 'or', window: 3, groups: [{ logic: 'or', signals: [{ type: 'boll-revert', period: 20, mult: 2 }] }] } }, []);
  assert.strictEqual(w.enabled, true);
  const flat = n => Array.from({ length: n }, (_, i) => ({ ts: (i + 1) * 3600e3, o: 100, h: 101, l: 99, c: 100 + (i % 2 ? 0.5 : -0.5), v: 1 }));
  let bars = flat(40);
  const market = { closedBars: async () => bars, lastPrice: async () => 100 };
  const sent = [];
  const alerts = { send: async (k, text) => sent.push([k, text]) };
  const st = { lastBarTs: 0, signals: [] }, ctx = { cfg: watches.cfgFor(w), market, alerts, st, pdp: 2 };
  assert.deepStrictEqual(await checkOnce(ctx), [], 'first look only remembers the candle');
  assert.strictEqual(sent.length, 0);
  bars = [...bars, { ts: 41 * 3600e3, o: 100, h: 100, l: 90, c: 90, v: 1 }]; // closes far below the lower band
  const recs = await checkOnce(ctx);
  assert.ok(recs.length === 1 && sent.length === 1 && sent[0][0] === 'signal' && sent[0][1].includes('BOLL(20, 2)'));
  assert.strictEqual(st.signals.length, 1);
  assert.deepStrictEqual(await checkOnce(ctx), [], 'same candle: not again');
  assert.strictEqual(sent.length, 1);
});

test('a condition can use its own K-line and volatility filter; it lands on the bot candle that closes with it', () => {
  const H = 3600e3, closes4 = [10, 10, 10, 10, 9, 9, 9, 12];
  const bars4 = closes4.map((c, j) => ({ ts: j * 4 * H, o: c, h: c + 1, l: c - 1, c, v: 1 }));
  const bars1 = Array.from({ length: 32 }, (_, k) => ({ ts: k * H, o: 10, h: 11, l: 9, c: 10, v: 1 }));
  const mk = extra => ({ logic: 'or', window: 3, groups: [{ logic: 'or', signals: [{ type: 'ma-cross', ma: 'sma', fast: 2, slow: 3, tf: '4H', ...extra }] }] });
  assert.ok(S.entrySignalMulti({ '1H': bars1, '4H': bars4 }, '1H', mk({})), 'the 4H cross is seen on the 1H candle that closes with it');
  assert.ok(!S.entrySignalMulti({ '1H': bars1.slice(0, 30), '4H': bars4 }, '1H', mk({})), 'not before that 1H candle has closed');
  assert.ok(!S.entrySignalMulti({ '1H': bars1, '4H': bars4 }, '1H', mk({ volatility: { minPct: 500, maxPct: 0, period: 3 } })), 'its own volatility filter blocks it');
  assert.ok(S.entrySignalMulti({ '1H': bars1, '4H': bars4 }, '1H', mk({ volatility: { minPct: 1, maxPct: 0, period: 3 } })), 'and lets it through when met');
  assert.deepStrictEqual(S.distinctTfs(mk({}), '1H'), ['4H']);
  const p = bots.parseSignal({ type: 'rsi-cross', period: 14, level: 30, tf: '4H', volatility: { minPct: 0.5, maxPct: 3, period: 14 } });
  assert.strictEqual(p.tf, '4H');
  assert.strictEqual(p.volatility.maxPct, 3);
  assert.throws(() => bots.parseSignal({ type: 'rsi-cross', period: 14, level: 30, tf: '2H' }), /K-line/);
});

test('an alert looks once per candle of its shortest K-line', () => {
  const watches = require('../watches');
  const mk = (tf, ...sigTfs) => watches.cfgFor({ id: 'w', tf, entry: { logic: 'or', window: 3, groups: [{ logic: 'or', signals: sigTfs.map(s => ({ type: 'rsi-cross', period: 14, level: 30, ...(s ? { tf: s } : {}) })) }] } });
  assert.strictEqual(watches.watchTf(mk('1H', null)), '1H', 'default K-line only');
  assert.strictEqual(watches.watchTf(mk('1H', null, '4H')), '1H', '1H default plus a 4H condition');
  assert.strictEqual(watches.watchTf(mk('1H', '4H')), '4H', 'every condition on 4H');
  assert.strictEqual(watches.watchTf(mk('1H', null, '15m')), '15m', 'a 15m condition makes it look every 15 minutes');
  const e = watches.explicitEntry(mk('1H', null, '4H'));
  assert.deepStrictEqual(e.groups[0].signals.map(s => s.tf), ['1H', '4H']);
});

test('an alert is a flat list: one message per candle on which any indicator fires, naming the ones that fired', async () => {
  const { checkOnce } = require('../watcher');
  const watches = require('../watches');
  const { boll } = require('../indicators');
  const sig = mult => ({ type: 'boll-revert', period: 20, mult });
  // a list of conditions under one stock; groups from the editor are flattened and combined as OR
  const w = watches.validate({ id: 'w-y', name: 'W Y', symbol: 'SOXXUSDT', tf: '1H', entry: { logic: 'and', window: 3, groups: [{ logic: 'and', signals: [sig(2)] }, { logic: 'and', signals: [sig(1)] }] } }, []);
  assert.deepStrictEqual(w.entry.groups.map(g => [g.logic, g.signals.length]), [['or', 2]], 'one flat list, any can fire');
  const H = 3600e3, base = Array.from({ length: 40 }, (_, i) => ({ ts: (i + 1) * H, o: 100, h: 101, l: 99, c: 100 + (i % 2 ? 0.5 : -0.5), v: 1 }));
  // a close between the two lower bands: only the 1x band is crossed
  const lows = c => { const cl = [...base.map(b => b.c), c], b = boll(cl, 20, 1), b2 = boll(cl, 20, 2); return [b.lo[cl.length - 1], b2.lo[cl.length - 1]]; };
  let mild = null;
  for (let c = 99.9; c > 95; c -= 0.01) { const [l1, l2] = lows(c); if (c < l1 && c >= l2) { mild = c; break; } }
  assert.ok(mild !== null, 'found a close that crosses only the 1x band');
  const mk = c => ({ ts: 41 * H, o: 100, h: 100, l: c, c, v: 1 });
  const run = async last => {
    let bars = base;
    const market = { closedBars: async () => bars, lastPrice: async () => 100 }, sent = [];
    const st = { lastBarTs: 0, signals: [] }, ctx = { cfg: watches.cfgFor(w), market, alerts: { send: async (k, text) => sent.push(text) }, st, pdp: 2 };
    await checkOnce(ctx); // first look
    bars = [...base, last];
    const recs = await checkOnce(ctx);
    return { recs, sent };
  };
  const one = await run(mk(mild));
  assert.strictEqual(one.sent.length, 1);
  assert.ok(one.sent[0].includes('BOLL(20, 1)') && !one.sent[0].includes('BOLL(20, 2)'), 'only the indicator that fired is named');
  const both = await run(mk(90));
  assert.strictEqual(both.sent.length, 1, 'one message even when both fire');
  assert.ok(both.sent[0].includes('BOLL(20, 2)') && both.sent[0].includes('BOLL(20, 1)'), 'both are named');
});

test('entry modes: taker opens at once, maker once price is at the limit, indicator is unchanged', () => {
  const cfg = { ...base, entry: { mode: 'maker', limitPx: 100 } }, st = { pos: null, lastBarTs: 0 };
  const dec = (c, price, s = st) => S.decide(s, [], price, c, true);
  assert.strictEqual(dec(cfg, 101).entry, false);
  const hit = dec(cfg, 99);
  assert.ok(hit.entry && hit.entryPx === 100, 'maker fills at its limit');
  const taker = dec({ ...base, entry: { mode: 'taker' } }, 123);
  assert.ok(taker.entry && taker.entryPx === 123);
  assert.strictEqual(dec(cfg, 99, { ...st, pos: { orders: [{ px: 100, margin: 1, qty: 1 }], qty: 1, cost: 100 } }).entry, false, 'a cycle is already open');
  assert.strictEqual(S.decide(st, [], 99, cfg, false).entry, false, 'outside market hours');
  assert.match(S.describeEntry({ mode: 'maker', limitPx: 100 }), /limit/);
  assert.ok(bots.validate({ ...MG_INPUT, entry: { mode: 'taker' } }, []).entry.mode === 'taker');
  assert.throws(() => bots.validate({ ...MG_INPUT, entry: { mode: 'maker' } }, []), /price/);
  const b = bots.validate({ ...MG_INPUT, fillMode: 'manual' }, []);
  assert.ok(b.fillMode === 'manual');
  assert.strictEqual(bots.validate(MG_INPUT, []).fillMode, 'auto');
  assert.strictEqual(bots.validate({ ...MG_INPUT }, [], b).fillMode, 'manual', 'an edit keeps how orders are filled');
});

test('by hand: advice once per order, then the real fills drive the ladder', () => {
  const { Engine } = require('../engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hand-'));
  const bus = new Bus(), seen = [];
  bus.subscribe(ev => seen.push(ev));
  const cfg = { ...base, investment: 1000, maxAdds: 3, amountMult: 2, stepPct: 1, stepMult: 1, tpPct: 2, leverage: 10, fillMode: 'manual',
    entry: { mode: 'maker', limitPx: 100 }, logFile: 'bot-x.log' };
  const e = new Engine(cfg, { market: {}, executor: {}, bus }, { dir, quiet: true });
  Object.assign(e, { step: 0.01, qdp: 2, minQty: 0.01, minNotional: 5, pdp: 2 });
  e.q = x => +(Math.floor(x / 0.01 + 1e-9) * 0.01).toFixed(2);
  e.adviseBuy('open', 0, 100); e.adviseBuy('open', 0, 100);
  assert.strictEqual(seen.filter(x => x.type === 'advice').length, 1, 'advised once');
  assert.match(seen[0].message, /about 6\.02 @ 100\.00 \(66\.67 USDT margin at 10x cross 全仓\)/); // 1000 / 15 = 66.67; 66.67 / (100 x 0.11066) = 6.02
  assert.strictEqual(e.st.pos, null, 'the bot never fills it itself');
  e.applyReal({ side: 'buy', px: 99.5, qty: 6.3 }); // the real fill differs from the estimate
  const p = e.st.pos;
  assert.ok(p && p.orders[0].px === 99.5 && Math.abs(p.orders[0].margin - S.marginOf(99.5, 6.3, 10)) < 1e-9);
  const L = S.levels(p, cfg);
  assert.ok(Math.abs(L.nextAdd - 99.5 * 0.99) < 1e-9, 'next add follows the real fill');
  assert.strictEqual(S.addMargin(cfg, p, 1), S.marginFor(cfg, 1), 'add 1 is the plan, whatever the real fill used');
  e.applyReal({ side: 'buy', px: 98.5, qty: 2 });
  assert.strictEqual(e.st.pos.orders[1].n, 1, 'the second buy is add 1 of the ladder');
  e.applyReal({ side: 'sell', px: 105, qty: 1 });
  assert.ok(e.st.pos && Math.abs(e.st.pos.qty - 7.3) < 1e-9, 'a smaller sell reduces');
  e.applyReal({ side: 'sell', px: 105, qty: 7.3 });
  assert.strictEqual(e.st.pos, null, 'selling it all closes the cycle');
  assert.strictEqual(e.st.history.length, 1);
  e.applyReal({ side: 'buy', px: 0, qty: 1 });
  assert.strictEqual(seen.filter(x => x.type === 'error').length, 1, 'a bad fill is refused and reported');
});

// an in-memory exchange order book: orders rest until a test fills them
class FakeLive {
  constructor(pos) { this.live = true; this.orders = new Map(); this.pos = pos; this.placed = []; this.cancelled = []; this.sold = []; }
  async limitOrder(o) { this.placed.push(o); this.orders.set(o.clientOid, { ...o, state: 'live', filled: 0 }); }
  async cancel(cid) { const o = this.orders.get(cid); if (!o) throw new Error('not exist'); if (o.state !== 'live') throw new Error('order already filled'); o.state = 'canceled'; this.cancelled.push(cid); }
  async pendingOrders() { return [...this.orders].filter(([, o]) => o.state === 'live').map(([cid, o]) => ({ cid, side: o.side, px: +o.price, size: +o.size, filled: 0 })); }
  async orderState(cid) { const o = this.orders.get(cid); return o ? { px: +o.price, qty: o.filled } : null; }
  async positionQty() { return +this.pos.toFixed(2); }
  async marketOrder({ side, size }) { this.sold.push(size); this.pos -= size; return { px: 640, qty: +size, done: true }; }
  async findOrder() { return null; }
  fill(cid) { const o = this.orders.get(cid); o.state = 'filled'; o.filled = +o.size; this.pos += (o.side === 'buy' ? 1 : -1) * o.size; }
  open(side, reduceOnly) { return [...this.orders.values()].filter(o => o.state === 'live' && o.side === side && (reduceOnly === undefined || (o.reduceOnly === 'YES' || o.reduceOnly === true) === reduceOnly)); }
}
function restingBot(mod = {}) {
  const { Engine } = require('../engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-'));
  const cfg = { ...base, dryRun: false, fillMode: 'auto', leverage: 10, investment: 150, maxAdds: 20, stepPct: 0.85, stepMult: 1.02, amountMult: 1.12, tpPct: 2.55,
    entry: { mode: 'taker' }, logFile: 'bot-x.log', ...mod };
  const ex = new FakeLive(0.02), market = { lastPrice: async () => 633 };
  const e = new Engine(cfg, { market, executor: ex }, { dir, quiet: true });
  Object.assign(e, { step: 0.01, qdp: 2, minQty: 0.01, minNotional: 5, pdp: 2 });
  e.q = x => +(Math.floor(x / 0.01 + 1e-9) * 0.01).toFixed(2);
  e.st.seq = 1; e.st.pos = { id: 1, openedAt: 1, orders: [{ n: 0, ts: 1, px: 633.08, qty: 0.02, margin: 633.08 * 0.02 / 10 }], qty: 0.02, cost: 633.08 * 0.02 };
  return { e, ex };
}

test('resting orders: the whole ladder and one take profit are placed once, then left alone', async () => {
  const { e, ex } = restingBot();
  const r = await e.tick();
  assert.ok(r.resting, 'an open live cycle uses the resting loop');
  assert.strictEqual(ex.open('buy').length, 20, 'every add is a limit buy');
  const tp = ex.open('sell', true);
  assert.strictEqual(tp.length, 1);
  assert.ok(+tp[0].size === 0.02 && +tp[0].price === 649.22, 'take profit sells the whole position at avg x 1.0255');
  const adds = ex.open('buy').map(o => +o.price).sort((a, b) => b - a);
  assert.strictEqual(adds[0], 627.69, 'add 1 is 0.85% below the first fill, rounded down');
  assert.ok(adds.every((p, i) => i === 0 || p < adds[i - 1]), 'each add is lower than the one before');
  const spent = ex.open('buy').reduce((s, o) => s + S.marginOf(+o.price, +o.size, 10), 0) + S.marginOf(633.08, 0.02, 10);
  assert.ok(spent <= 150 + 1e-6 && spent > 140, `the ladder stays inside the investment (${spent.toFixed(2)})`);
  const n = ex.placed.length;
  await e.tick(); await e.tick();
  assert.strictEqual(ex.placed.length, n, 'nothing is re-placed');
  assert.strictEqual(ex.cancelled.length, 0);
});

test('resting orders: an add that fills moves the take profit; nothing else is touched', async () => {
  const { e, ex } = restingBot();
  await e.tick();
  const add1 = [...ex.orders].find(([cid]) => /a1r/.test(cid)), oldTp = ex.open('sell', true)[0], placed = ex.placed.length;
  ex.fill(add1[0]);
  await e.tick();
  assert.strictEqual(e.st.pos.orders.length, 2, 'the fill is booked from the exchange');
  assert.strictEqual(e.st.pos.orders[1].px, 627.69);
  const tp = ex.open('sell', true);
  assert.strictEqual(tp.length, 1, 'still exactly one take profit');
  assert.ok(tp[0].clientOid !== oldTp.clientOid && +tp[0].size === +(0.02 + +add1[1].size).toFixed(2), 'new size = whole position');
  assert.ok(+tp[0].price < 649.22, 'the new average is lower, so the take profit is too');
  assert.strictEqual(ex.placed.length, placed + 1, 'only the take profit was replaced');
  assert.strictEqual(ex.open('buy').length, 19);
});

test('resting orders: the take profit fills, the cycle closes, the leftover buys are cancelled', async () => {
  const { e, ex } = restingBot();
  await e.tick();
  ex.fill(ex.open('sell', true)[0].clientOid);
  await e.tick();
  assert.strictEqual(e.st.pos, null);
  assert.strictEqual(e.st.history.length, 1);
  assert.ok(e.st.history[0].pnl > 0 && e.st.history[0].exitPx === 649.22);
  assert.strictEqual(ex.open('buy').length, 0, 'no buy is left resting');
  assert.deepStrictEqual(e.st.live.adds, {});
  assert.strictEqual(e.st.live.tp, null);
});

test('resting orders: closing the bot cancels everything before it sells; switching off keeps only the take profit', async () => {
  const a = restingBot();
  await a.e.tick();
  assert.strictEqual(await a.e.closeBot(640), true);
  assert.strictEqual(a.ex.open('buy').length + a.ex.open('sell').length, 0, 'no order is left');
  assert.deepStrictEqual(a.ex.sold, [0.02]);
  const b = restingBot();
  await b.e.tick();
  await b.e.onStop();
  assert.strictEqual(b.ex.open('buy').length, 0, 'the ladder stops buying');
  assert.strictEqual(b.ex.open('sell', true).length, 1, 'the position keeps its take profit');
  assert.ok(b.e.st.pos, 'the open position is untouched');
});

test('resting orders: a settings change re-prices only what differs; an order that failed to place is retried once told once', async () => {
  const { e, ex } = restingBot();
  await e.tick();
  e.cfg.tpPct = 3;
  await e.tick();
  assert.strictEqual(+ex.open('sell', true)[0].price, +(633.08 * 1.03).toFixed(2));
  assert.strictEqual(ex.cancelled.length, 1, 'just the old take profit');
  e.cfg.maxAdds = 10;
  await e.tick();
  assert.strictEqual(ex.open('buy').length, 10, 'the extra adds are cancelled');
  const f = restingBot();
  let fail = true; const errors = [], real = f.ex.limitOrder.bind(f.ex);
  f.ex.limitOrder = async o => { if (fail && o.side === 'buy') throw new Error('margin not enough'); return real(o); };
  f.e.bus = { emit: (t, d) => errors.push(t) };
  await f.e.tick(); await f.e.tick();
  assert.strictEqual(errors.filter(t => t === 'error').length, 20, 'one notice per failed add, not one per pass');
  fail = false;
  await f.e.tick();
  assert.strictEqual(f.ex.open('buy').length, 20, 'retried and placed once the problem is gone');
});

test('resting orders: the adds are fixed in pos.plan when the cycle opens; new rules or steps never move them, a higher maxAdds appends', async () => {
  const { e, ex } = restingBot({ maxAdds: 10 });
  await e.tick();
  const before = ex.open('buy').map(o => [o.price, o.size]).sort();
  assert.strictEqual(e.st.pos.plan.adds.length, 10, 'the plan is stored with the cycle');
  e.cfg.stepPct = 2; e.cfg.amountMult = 1.2; // e.g. a new version of the rules
  await e.tick();
  assert.deepStrictEqual(ex.open('buy').map(o => [o.price, o.size]).sort(), before, 'the open cycle keeps its orders');
  assert.strictEqual(ex.cancelled.length, 0);
  e.cfg.maxAdds = 12;
  await e.tick();
  assert.strictEqual(ex.open('buy').length, 12, 'two adds appended');
  assert.strictEqual(ex.cancelled.length, 0, 'the first ten are untouched');
});

test('check timing: 15 s with a cycle or a limit / market entry; an indicator waits for its smallest K-line to close', () => {
  const now = Date.UTC(2026, 9, 6, 10, 20, 0), ind = bots.validate({ ...MG_INPUT, tf: '1H', dryRun: true }, []);
  assert.strictEqual(ind.tf, '1H');
  assert.strictEqual(S.checkWait(ind, false, now), 40 * 60e3 + 5e3, 'no cycle: until the 1H candle closes (11:00) + 5 s');
  assert.strictEqual(S.checkWait(ind, true, now), 15e3, 'cycle open: every 15 s');
  const mixed = { ...ind, entry: { ...ind.entry, groups: [{ logic: 'or', signals: [{ type: 'boll-revert', period: 20, mult: 2, tf: '15m' }] }] } };
  assert.strictEqual(S.signalTf(mixed), '15m');
  assert.strictEqual(S.checkWait(mixed, false, now), 10 * 60e3 + 5e3, 'a 15m condition: until 10:30 + 5 s');
  for (const entry of [{ mode: 'taker' }, { mode: 'maker', limitPx: 100 }]) {
    const b = bots.validate({ ...MG_INPUT, dryRun: true, checkTf: '5m', entry }, []);
    assert.strictEqual(b.checkTf, undefined);
    assert.strictEqual(S.checkWait(b, false, now), 15e3, `${entry.mode}: next cycle within 15 s`);
  }
  const start = (entry) => format({ type: 'start', tf: '1H', checkTf: '5m', entry, investment: 150, maxAdds: 20, stepPct: 1, stepMult: 1, amountMult: 1, tpPct: 1, pdp: 2 })[1];
  assert.ok(!/checks every/.test(start({ mode: 'taker', groups: [], logic: 'or', window: 3 })), 'no K-line / check interval for a market entry');
  assert.ok(/on 1H, checked when each 5m candle closes/.test(start({ logic: 'or', window: 3, groups: [{ logic: 'or', signals: [{ type: 'boll-revert', period: 20, mult: 2 }] }] })), 'an indicator entry still says it');
});

test('strategies: every field is optional and unlimited when saved; the limits apply when a bot is created', () => {
  const full = { investment: '150', leverage: 10, maxAdds: 20, stepPct: 0.85, stepMult: 1.02, amountMult: 1.12, tpPct: 2.55 };
  assert.deepStrictEqual(bots.parseStrategy(full), { investment: 150, leverage: 10, maxAdds: 20, stepPct: 0.85, stepMult: 1.02, amountMult: 1.12, tpPct: 2.55 });
  const { investment, ...noInv } = full;
  assert.ok(!('investment' in bots.parseStrategy(noInv)), 'a strategy can leave the investment out');
  assert.ok(!('investment' in bots.parseStrategy({ ...full, investment: '' })), 'a blank field is left out, not saved as 0');
  assert.deepStrictEqual(bots.parseStrategy({}), {}, 'even an empty one saves');
  assert.strictEqual(bots.parseStrategy({ leverage: 500, maxAdds: 99, stepPct: 99 }).leverage, 500, 'no range limit at save time');
  assert.throws(() => bots.parseStrategy({ tpPct: 'abc' }), /tpPct must be a number/, 'a field that is given must still be a number');
  // ...and the same values are refused where it matters: when a bot is created
  assert.throws(() => bots.validate({ ...MG_INPUT, dryRun: true, leverage: 500 }, []), /leverage/);
  assert.throws(() => bots.validate({ ...MG_INPUT, dryRun: true, investment: undefined }, []), /investment/);
});

test('strategies: the entry (mode, conditions, K-line) is part of a strategy; a limit price, symbol and name are not', () => {
  const ind = { logic: 'and', window: '4', groups: [{ logic: 'or', signals: [{ type: 'rsi-cross', period: 14, level: 30 }, { type: 'boll-revert', period: 20, mult: 2, tf: '4H' }] }] };
  const p = bots.parseStrategy({ leverage: 10, tf: '1H', checkTf: '5m', entry: ind, symbol: 'SMHUSDT', name: 'x' });
  assert.deepStrictEqual(p.entry, { logic: 'and', window: 4, groups: ind.groups }, 'conditions kept as they are, window as a number');
  assert.ok(p.tf === '1H' && !('checkTf' in p) && p.leverage === 10);
  assert.ok(p.symbol === 'SMHUSDT' && !('name' in p), 'the symbol is kept, the name stays per bot');
  assert.deepStrictEqual(bots.parseStrategy({ entry: { mode: 'maker', limitPx: 633.1 } }).entry, { mode: 'maker' }, 'a limit price is never saved');
  assert.deepStrictEqual(bots.parseStrategy({ entry: { mode: 'taker' } }).entry, { mode: 'taker' });
  assert.ok(!('entry' in bots.parseStrategy({ entry: { groups: [] } })) && !('tf' in bots.parseStrategy({ tf: '7H' })) && !('checkTf' in bots.parseStrategy({ checkTf: '' })), 'junk is left out, not saved');
  assert.ok(!('entry' in bots.parseStrategy({ leverage: 3 })), 'an older strategy without an entry stays valid');
  // what a saved entry becomes when a bot is created from it is still checked there
  assert.throws(() => bots.validate({ ...MG_INPUT, dryRun: true, entry: { logic: 'or', window: 3, groups: [{ logic: 'or', signals: [{ type: 'rsi-cross', period: 1, level: 30 }] }] } }, []), /period/);
});

test('strategies: the first-order mode is kept; the limit price and whether it follows the market are not (it always starts following)', () => {
  assert.deepStrictEqual(bots.parseStrategy({ entry: { mode: 'maker', track: false, limitPx: 633 } }).entry, { mode: 'maker' });
  assert.deepStrictEqual(bots.parseStrategy({ entry: { mode: 'taker', track: true } }).entry, { mode: 'taker' });
  assert.ok(!('symbol' in bots.parseStrategy({ symbol: 'not a symbol' })), 'a bad symbol is not saved');
  const o = bots.parseStrategy({ fillMode: 'live', maxCycles: '3' });
  assert.ok(o.fillMode === 'live' && o.maxCycles === 3, 'how orders are filled and max cycles are kept');
  assert.ok(!('fillMode' in bots.parseStrategy({ fillMode: 'x' })));
});

test('pause trading: every resting order is cancelled once, nothing is placed while paused, resume places the ladder again', async () => {
  const { STOP_FILE } = require('../executor');
  const { e, ex } = restingBot();
  await e.tick();
  const resting = ex.open('buy').length + ex.open('sell').length;
  assert.ok(resting > 1, 'ladder and take profit resting');
  fs.writeFileSync(STOP_FILE, 'x');
  try {
    await e.tick();
    assert.strictEqual(ex.open('buy').length + ex.open('sell').length, 0, 'all cancelled');
    const placed = ex.placed.length;
    await e.tick();
    assert.strictEqual(ex.placed.length, placed, 'nothing placed while paused');
    assert.ok(e.st.pos && e.st.pos.qty === 0.02, 'the position stays');
  } finally { fs.unlinkSync(STOP_FILE); }
  await e.tick();
  assert.strictEqual(ex.open('buy').length + ex.open('sell').length, resting, 'resumed: the same orders are back');
});

test('close bot, keep the position: every resting order is cancelled, nothing is sold, the cycle is kept as held', async () => {
  const { e, ex } = restingBot();
  await e.tick();
  e.st.armed = { close: { now: true, how: 'hold' } };
  const r = await e.tick();
  assert.strictEqual(r.action, 'close');
  assert.strictEqual(ex.open('buy').length + ex.open('sell').length, 0, 'no order left resting');
  assert.deepStrictEqual(ex.sold, [], 'nothing sold');
  assert.strictEqual(e.st.pos, null);
  const h = e.st.history[e.st.history.length - 1];
  assert.ok(h.closedBy === 'held' && h.exitPx === null && h.qty === 0.02, 'kept in the history as held');
  assert.ok(e.st.held && e.st.held.qty === 0.02 && e.st.closedAt);
});

test('close bot with a limit sell: ladder and take profit make way, one reduce-only sell rests, the bot closes when it fills', async () => {
  const { e, ex } = restingBot();
  await e.tick();
  e.st.armed = { close: { now: true, how: 'limit', limitPx: 640 } };
  let r = await e.tick();
  assert.ok(!r.action, 'still on while the sell rests');
  const sells = ex.open('sell', true);
  assert.ok(sells.length === 1 && +sells[0].price === 640 && +sells[0].size === 0.02, 'one limit sell for the whole position');
  assert.strictEqual(ex.open('buy').length, 0, 'the buys are cancelled');
  const placed = ex.placed.length;
  r = await e.tick();
  assert.ok(!r.action && ex.placed.length === placed, 'waiting: nothing re-placed');
  ex.fill(sells[0].clientOid);
  r = await e.tick();
  assert.strictEqual(r.action, 'close');
  assert.ok(e.st.pos === null && e.st.closedAt && e.st.history[e.st.history.length - 1].exitPx === 640);
});

test('close bot with a limit sell, then cancelled on the dashboard: the sell is taken back and the ladder returns', async () => {
  const { e, ex } = restingBot();
  await e.tick();
  e.st.armed = { close: { now: true, how: 'limit', limitPx: 640 } };
  await e.tick();
  delete e.st.armed.close; // the "Cancel" on the banner (disarm)
  const r = await e.tick();
  assert.ok(!r.action && e.st.pos && !e.st.closing);
  assert.strictEqual(ex.open('buy').length, 20, 'the buys are back');
  const tp = ex.open('sell', true);
  assert.ok(tp.length === 1 && +tp[0].price === 649.22, 'and the take profit, not the limit sell');
});

test('close bot at market: if the sell fails, the cancelled orders are not put back while it retries', async () => {
  const { e, ex } = restingBot();
  await e.tick();
  ex.marketOrder = async () => { throw new Error('exchange busy'); };
  e.st.armed = { close: { now: true } };
  await e.tick(); await e.tick();
  assert.ok(e.st.pos && !e.st.closedAt, 'not closed: retried');
  assert.strictEqual(ex.open('buy').length + ex.open('sell').length, 0, 'nothing re-placed in between');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok  ', name); }
    catch (e) { failed++; console.log('  FAIL', name, '\n       ', e.message); }
  }
  console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
