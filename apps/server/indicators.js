// Same formulas as TradingView: ta.sma, ta.ema (SMA seed), ta.bb (population stdev)
function sma(v, n) {
  const out = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function ema(v, n) {
  const out = new Array(v.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = n - 1; i < v.length; i++) {
    if (prev === null) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += v[j];
      prev = s / n;
    } else prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function boll(v, n, mult) {
  const mid = sma(v, n), up = [], lo = [];
  for (let i = 0; i < v.length; i++) {
    if (mid[i] === null) { up.push(null); lo.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    up.push(mid[i] + mult * sd);
    lo.push(mid[i] - mult * sd);
  }
  return { mid, up, lo };
}

// ta.macd: MACD = EMA(fast) - EMA(slow); signal = EMA(MACD, signal); hist = MACD - signal
function macd(v, fast, slow, signal) {
  const f = ema(v, fast), s = ema(v, slow);
  const line = v.map((_, i) => f[i] === null || s[i] === null ? null : f[i] - s[i]);
  const start = line.findIndex(x => x !== null);
  const sig = new Array(v.length).fill(null);
  if (start >= 0) ema(line.slice(start), signal).forEach((x, j) => { sig[start + j] = x; });
  return { line, signal: sig, hist: line.map((x, i) => x === null || sig[i] === null ? null : x - sig[i]) };
}

// ta.rsi: Wilder's smoothing (RMA seeded with the SMA of the first n changes)
function rsi(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length <= n) return out;
  let up = 0, dn = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; up += Math.max(d, 0); dn += Math.max(-d, 0); }
  up /= n; dn /= n;
  const val = () => dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
  out[n] = val();
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    up = (up * (n - 1) + Math.max(d, 0)) / n;
    dn = (dn * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

// ta.atr: Wilder's smoothing (RMA) of the true range, seeded with the SMA of the first n ranges.
// bars: [{ h, l, c }]
function atr(bars, n) {
  const out = new Array(bars.length).fill(null);
  const tr = bars.map((b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l);
  if (bars.length < n) return out;
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  out[n - 1] = a;
  for (let i = n; i < bars.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}

module.exports = { sma, ema, boll, macd, rsi, atr };
