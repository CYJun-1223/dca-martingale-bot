// Cross-check the bot's indicators on REAL candles against independent textbook implementations.
//   node test/verify-indicators.js
// Needs internet (public Bitget / Binance candles). Exits 1 if any value differs.
const I = require('../indicators');
const { Bitget } = require('../bitget');
const { createMarket } = require('../market');

// ---- reference implementations, written separately from indicators.js ----
const refSma = (v, n, i) => i < n - 1 ? null : v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
function refEma(v, n) { // TradingView-style: first value = SMA of the first n closes, then alpha = 2/(n+1)
  const a = 2 / (n + 1), out = v.map(() => null);
  out[n - 1] = refSma(v, n, n - 1);
  for (let i = n; i < v.length; i++) out[i] = a * v[i] + (1 - a) * out[i - 1];
  return out;
}
function refBoll(v, n, k, i) { // population standard deviation, like TradingView ta.stdev
  const m = refSma(v, n, i); if (m === null) return null;
  const sd = Math.sqrt(v.slice(i - n + 1, i + 1).map(x => (x - m) ** 2).reduce((a, b) => a + b, 0) / n);
  return { mid: m, up: m + k * sd, lo: m - k * sd };
}
function refRsi(v, n) { // Wilder: RMA of gains / losses, seeded with their simple average
  const g = [0], l = [0];
  for (let i = 1; i < v.length; i++) { g.push(Math.max(v[i] - v[i - 1], 0)); l.push(Math.max(v[i - 1] - v[i], 0)); }
  const out = v.map(() => null);
  let ag = g.slice(1, n + 1).reduce((a, b) => a + b, 0) / n, al = l.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < v.length; i++) {
    if (i > n) { ag = (ag * (n - 1) + g[i]) / n; al = (al * (n - 1) + l[i]) / n; }
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function refMacd(v, f, s, sig) {
  const ef = refEma(v, f), es = refEma(v, s);
  const line = v.map((_, i) => es[i] === null ? null : ef[i] - es[i]);
  const first = s - 1, sl = refEma(line.slice(first), sig), signal = v.map((_, i) => i < first ? null : sl[i - first]);
  return { line, signal };
}

// ---- compare ----
let bad = 0;
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
function cmp(label, ours, ref, from) {
  let worst = 0;
  for (let i = from; i < ref.length; i++) if (ref[i] !== null) worst = Math.max(worst, rel(ours[i], ref[i]));
  const ok = worst < 1e-9;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'DIFF'} ${label.padEnd(22)} max relative difference ${worst.toExponential(1)}`);
}

(async () => {
  const api = new Bitget({});
  const feeds = [['bitget', 'SOXXUSDT', '1H'], ['bitget', 'SOXXUSDT', '4H'], ['binance', 'NVDAUSDT', '4H'], ['binance', 'BTCUSDT', '1D']];
  for (const [broker, symbol, tf] of feeds) {
    const bars = await createMarket({ ...require('../config'), broker, symbol }, api).closedBars(tf, 300);
    const c = bars.map(b => b.c), last = c.length - 1;
    console.log(`\n${symbol} ${tf} on ${broker}: ${c.length} closed bars, last close ${c[last]}`);
    const b = I.boll(c, 20, 2);
    cmp('BOLL(20,2) upper', b.up, c.map((_, i) => refBoll(c, 20, 2, i)?.up ?? null), 0);
    cmp('BOLL(20,2) lower', b.lo, c.map((_, i) => refBoll(c, 20, 2, i)?.lo ?? null), 0);
    cmp('SMA(50)', I.sma(c, 50), c.map((_, i) => refSma(c, 50, i)), 0);
    cmp('EMA(20)', I.ema(c, 20), refEma(c, 20), 0);
    const m = I.macd(c, 12, 26, 9), rm = refMacd(c, 12, 26, 9);
    cmp('MACD(12,26,9) line', m.line, rm.line, 0);
    cmp('MACD(12,26,9) signal', m.signal, rm.signal, 0);
    cmp('RSI(14)', I.rsi(c, 14), refRsi(c, 14), 0);
    // the seed: TradingView starts EMA from an SMA. How much would a first-close seed change today's value?
    const alt = [c[0]]; for (let i = 1; i < c.length; i++) alt.push(2 / 51 * c[i] + (1 - 2 / 51) * alt[i - 1]);
    console.log(`       EMA(50) seed effect on the last bar: ${(rel(alt[last], I.ema(c, 50)[last]) * 100).toFixed(4)}%`);
    console.log(`       now: BOLL ${b.lo[last].toFixed(2)} / ${b.up[last].toFixed(2)}, RSI ${I.rsi(c, 14)[last].toFixed(2)}, MACD ${m.line[last].toFixed(4)} vs signal ${m.signal[last].toFixed(4)}`);
  }
  console.log(bad ? `\n${bad} mismatches` : '\nall indicators match the reference implementations');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
