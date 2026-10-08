// Martingale strategy: pure decision logic, no I/O.
//   entry  : a group of indicator conditions combined with AND / OR opens the first order
//   adds   : add #n opens at the entry price minus drop n = stepPct x (1 + stepMult + ... + stepMult^(n-1)) %;
//            add #n's margin = base x amountMult^n, up to maxAdds
//   exit   : one take profit for the whole position at tpPct % above the average entry price
const { sma, ema, boll, macd, rsi, atr } = require('./indicators');
const { TF_MS, nextCheckAt } = require('./market');

// ---------- entry indicators ----------
// one indicator as a per-bar "crossed on this bar" test (an event, so it fires once per cross)
function crossTest(closes, sig) {
  const at = (a, b, i) => a[i - 1] !== null && b[i - 1] !== null && a[i - 1] <= b[i - 1] && a[i] > b[i];
  switch (sig.type) {
    case 'ma-cross': {
      const f = (sig.ma === 'ema' ? ema : sma)(closes, sig.fast), s = (sig.ma === 'ema' ? ema : sma)(closes, sig.slow);
      return i => at(f, s, i);
    }
    case 'macd-cross': { // MACD line crosses above its signal line
      const m = macd(closes, sig.fast, sig.slow, sig.signal);
      return i => at(m.line, m.signal, i);
    }
    case 'rsi-cross': { // RSI crosses up through the level (leaves oversold)
      const r = rsi(closes, sig.period), lvl = closes.map(() => sig.level);
      return i => at(r, lvl, i);
    }
    case 'boll-revert': case 'boll-break': {
      const b = boll(closes, sig.period, sig.mult);
      return sig.type === 'boll-revert'
        ? i => b.lo[i - 1] !== null && closes[i - 1] >= b.lo[i - 1] && closes[i] < b.lo[i] // close crosses below lower band
        : i => b.up[i - 1] !== null && closes[i - 1] <= b.up[i - 1] && closes[i] > b.up[i]; // close crosses above upper band
    }
    default: throw new Error('Unknown signal type: ' + sig.type);
  }
}

// The entry is groups of conditions, two levels:
//   { logic: 'or' | 'and',  window,  groups: [{ logic: 'and' | 'or', signals: [...] }, ...] }
//   each group combines its own conditions with its own logic; `logic` combines the groups.
//   e.g. (RSI up through 30 AND MACD golden cross) OR (BOLL below lower band)
// Older shapes are read as one group: { logic, signals } or a single `signal`.
// mode: 'indicator' (default) | 'maker' (buy limit at limitPx) | 'taker' (market buy right away); maker / taker have no conditions
function entryOf(cfg) {
  const e = cfg.entry;
  if (e && (e.mode === 'maker' || e.mode === 'taker')) return { mode: e.mode, limitPx: e.limitPx || null, logic: 'or', window: 3, groups: [], volatility: null };
  if (e && e.groups && e.groups.length) return { logic: e.logic === 'and' ? 'and' : 'or', window: e.window || 3, groups: e.groups, volatility: e.volatility || null };
  if (e && e.signals && e.signals.length) return { logic: 'or', window: e.window || 3, groups: [{ logic: e.logic === 'and' ? 'and' : 'or', signals: e.signals }] };
  return { logic: 'or', window: 3, groups: [{ logic: 'or', signals: [cfg.signal] }] };
}
const entrySignals = entry => entryOf({ entry }).groups.flatMap(g => g.signals);

// Combine per-bar tests with AND / OR, evaluated on bar i:
//   OR : any test fires on bar i
//   AND: every test fires within the last `window` bars, at least one of them on bar i
//        (two indicators rarely cross on exactly the same candle)
function combine(tests, logic, w) {
  const within = t => i => { for (let j = i; j > i - w && j >= 1; j--) if (t(j)) return true; return false; };
  return i => {
    if (!tests.some(t => t(i))) return false;
    return logic !== 'and' || tests.every(t => within(t)(i));
  };
}

// entry on the LAST closed bar: each group, then the groups together, with the same rule
function entrySignal(closes, entry) {
  const i = closes.length - 1;
  if (i < 1) return false;
  const e = entryOf({ entry }), w = Math.max(1, e.window || 3);
  const groups = e.groups.map(g => combine(g.signals.map(s => crossTest(closes, s)), g.logic, w));
  return combine(groups, e.logic, w)(i);
}

// ---------- indicators with their own K-line / volatility filter ----------
// A condition may carry `tf` (its own K-line; default = the bot's) and `volatility` { minPct, maxPct, period }
// (ATR as % of price on its own candles). Each condition is evaluated on its own candles; a firing is placed on the
// bot's candle that closes at or right after it, so AND windows are always counted in bot candles.
const distinctTfs = (entry, baseTf) => [...new Set(entrySignals(entry).map(s => s.tf || baseTf))];

function signalTest(sig, barsBy, baseBars, baseTf) {
  const tf = sig.tf || baseTf, bars = barsBy[tf];
  if (!bars || !bars.length) return () => false;
  const test = crossTest(bars.map(b => b.c), sig), v = sig.volatility;
  const a = v && (v.minPct > 0 || v.maxPct > 0) ? atr(bars, v.period || 14) : null;
  const volOk = j => {
    if (!a) return true;
    if (a[j] === null) return false;
    const pct = a[j] / bars[j].c * 100;
    return !(v.minPct > 0 && pct < v.minPct) && !(v.maxPct > 0 && pct > v.maxPct);
  };
  if (tf === baseTf) return i => i >= 1 && test(i) && volOk(i);
  const ms = TF_MS[tf], bms = TF_MS[baseTf], fires = new Set();
  for (let j = 1; j < bars.length; j++) {
    if (!(test(j) && volOk(j))) continue;
    const closeAt = bars[j].ts + ms;
    let lo = 0, hi = baseBars.length; // first base candle that closes at or after this firing
    while (lo < hi) { const mid = (lo + hi) >> 1; if (baseBars[mid].ts + bms >= closeAt) hi = mid; else lo = mid + 1; }
    if (lo < baseBars.length) fires.add(lo);
  }
  return i => fires.has(i);
}

// entry on the last closed bot candle; barsBy = { [tf]: closed bars } for every K-line the conditions use
function entrySignalMulti(barsBy, baseTf, entry) {
  const base = barsBy[baseTf] || [], i = base.length - 1;
  if (i < 1) return false;
  const e = entryOf({ entry }), w = Math.max(1, e.window || 3);
  const groups = e.groups.map(g => combine(g.signals.map(s => signalTest(s, barsBy, base, baseTf)), g.logic, w));
  return combine(groups, e.logic, w)(i);
}

// ---------- order plan ----------
// The order math (margins, drops from the entry, qty) lives in dca.mjs, shared with the dashboard. See the rules there.
const D = require('./dca.mjs');
const { dropAt, weight, addBase, marginFor, firstMargin, qtyFor, marginOf, minOrderMargin, plan } = D;
const usable = cfg => cfg.investment; // no reserve: all of the investment goes into the orders

// Manual orders are extra money on top of the investment: they move the average price, but the planned
// ladder (first order + adds, their sizes and price steps) ignores them. The ladder = the non-manual orders;
// a cycle that started with a manual order uses that one as its first order.
function planned(pos) {
  const p = pos.orders.filter(o => !o.manual);
  return p.length ? p : pos.orders.slice(0, 1);
}

// margin of planned add #k: always the plan (A x amountMult^k), whatever earlier orders really used
function addMargin(cfg, pos, k) {
  return marginFor(cfg, k);
}

// Extra investment (USDT) needed so raising maxAdds to newMax keeps the add-on base A, so every order keeps its size
function extraInvestment(cfg, pos, newMax) {
  let extra = 0;
  for (let j = cfg.maxAdds + 1; j <= newMax; j++) extra += addBase(cfg) * weight(cfg, j);
  return extra;
}


// extra investment (USDT) so that order n reaches margin `need`: margin n = investment x weight n / sum of weights
function topUpFor(cfg, pos, n, need) {
  const sum = Array.from({ length: cfg.maxAdds + 1 }, (_, j) => weight(cfg, j)).reduce((a, b) => a + b, 0);
  return Math.max(0, need * sum / weight(cfg, n) - usable(cfg));
}

// average entry price (all orders, manual included) and TP; the next add is measured from the first planned order (the entry)
function levels(pos, cfg) {
  const avg = pos.cost / pos.qty;
  const plan = planned(pos);
  const adds = plan.length - 1;
  return {
    avg,
    tp: avg * (1 + cfg.tpPct / 100),
    nextAdd: adds < cfg.maxAdds ? plan[0].px * (1 - dropAt(cfg, adds + 1)) : null,
  };
}

// The orders a live cycle keeps resting on the exchange: a limit buy for every add still to come (each below the
// one before it, sized like addMargin does for a ladder that fills in order) and ONE take profit for the whole
// position. Prices round down to pdp. rules = { q: round a size down to the exchange step, pdp: price decimals, minQty, minNotional }.
// The ladder stops at the first add that is below the exchange minimum.
function ladder(pos, cfg, rules) {
  const plan = planned(pos), sim = { orders: plan.slice() }, adds = [];
  const p0 = plan[0].px, f = Math.pow(10, rules.pdp);
  for (let k = plan.length; k <= cfg.maxAdds; k++) {
    const exact = p0 * (1 - dropAt(cfg, k)), px = +(Math.floor(exact * f + 1e-9) / f).toFixed(rules.pdp);
    const margin = addMargin(cfg, sim, k), qty = rules.q(qtyFor(margin, exact, cfg.leverage));
    if (!(margin > 0) || qty < rules.minQty || qty * px < rules.minNotional) break;
    adds.push({ k, px, qty, margin: marginOf(px, qty, cfg.leverage) });
    sim.orders.push({ px, qty, margin: marginOf(px, qty, cfg.leverage) });
  }
  return { adds, tp: { px: +levels(pos, cfg).tp.toFixed(rules.pdp), qty: pos.qty } };
}


// ---------- when the bot looks next ----------
// An open cycle (or a limit / market entry, which has no candle to wait for) is looked at every 15 s. An indicator
// entry is judged once per candle, so with no cycle the bot sleeps until its smallest K-line closes (+5 s).
const CYCLE_CHECK_MS = 15e3;
const signalTf = cfg => distinctTfs(entryOf(cfg), cfg.tf).reduce((m, x) => TF_MS[x] < TF_MS[m] ? x : m, cfg.tf);
const checkWait = (cfg, hasPos, now) => hasPos || entryOf(cfg).mode ? CYCLE_CHECK_MS : nextCheckAt(now, signalTf(cfg)) - now;
// how often that is, for people: "15s" or the K-line
const checkEvery = (cfg, hasPos) => hasPos || entryOf(cfg).mode ? '15s' : signalTf(cfg);

// maxCycles cycles have been started and none is open: no new first order (0 / unset = no limit)
const cyclesDone = (st, cfg) => cfg.maxCycles > 0 && st.seq >= cfg.maxCycles && !st.pos;

// ---------- the decision for one tick ----------
//   exit    : { kind: 'tp', qty } when price reached the take profit
//   add     : { n, margin } when price fell to the next add trigger
//   newBar  : a bar closed since the last decision -> entry considered
//   signal  : the entry group fired on that bar
//   entry   : true -> open the first order
//   ignored : why a signal did not open a cycle
// extra = { [tf]: closed bars } for conditions that use their own K-line
function decide(st, bars, price, cfg, marketOpen, extra = {}) {
  const pos = st.pos;
  let exit = null, add = null;
  if (pos) {
    const L = levels(pos, cfg);
    if (price >= L.tp) exit = { kind: 'tp', qty: pos.qty };
    else if (L.nextAdd !== null && price <= L.nextAdd) {
      const n = planned(pos).length, m = addMargin(cfg, pos, n);
      if (m > 0) add = { n, margin: m };
    }
  }
  const last = bars[bars.length - 1];
  const newBar = !!last && last.ts > st.lastBarTs;
  const base = { exit, add, newBar, signal: false, entry: false, ignored: null, bar: last };
  if (cyclesDone(st, cfg)) return { ...base, ignored: 'cycle limit reached' };
  const e = entryOf(cfg);
  if (e.mode) { // maker / taker: no indicator, the first order is due as soon as there is no cycle (maker: once price is at the limit)
    const due = !pos && !st.halted && marketOpen && (e.mode === 'taker' || (e.limitPx > 0 && price <= e.limitPx));
    return { ...base, entry: due, entryPx: e.mode === 'maker' ? e.limitPx : price };
  }
  if (!newBar) return base;
  const signal = entrySignalMulti({ ...extra, [cfg.tf]: bars }, cfg.tf, entryOf(cfg));
  const openNow = pos && !exit; // after a TP on this tick the position is gone
  const vol = signal ? volatilityCheck(bars, entryOf(cfg).volatility) : null;
  const why = !signal ? null : st.halted ? 'entries paused (position mismatch)' : !marketOpen ? 'outside US market hours'
    : openNow ? 'a cycle is already open' : vol && !vol.ok ? vol.reason : null;
  return { ...base, signal, entry: signal && !why, ignored: why };
}

// Volatility filter ("fluctuation" in Bitget's advanced settings): ATR(period) as % of the close on the
// signal bar must be within [minPct, maxPct]; either limit may be left out. null = no filter.
function volatilityCheck(bars, f) {
  if (!f || (!(f.minPct > 0) && !(f.maxPct > 0))) return null;
  const a = atr(bars, f.period || 14), i = bars.length - 1;
  if (a[i] === null) return { ok: false, pct: null, reason: 'not enough candles for the volatility filter' };
  const pct = a[i] / bars[i].c * 100;
  if (f.minPct > 0 && pct < f.minPct) return { ok: false, pct, reason: `volatility ${pct.toFixed(2)}% is below the ${f.minPct}% minimum` };
  if (f.maxPct > 0 && pct > f.maxPct) return { ok: false, pct, reason: `volatility ${pct.toFixed(2)}% is above the ${f.maxPct}% maximum` };
  return { ok: true, pct };
}

// human-readable name of one indicator condition
// the condition's own K-line / volatility filter, when it has them
const describeExtra = s => {
  const v = s.volatility, vol = v && (v.minPct > 0 || v.maxPct > 0) ? `ATR ${v.minPct > 0 ? v.minPct : ''}${v.minPct > 0 && v.maxPct > 0 ? '–' : v.minPct > 0 ? '+' : '≤'}${v.maxPct > 0 ? v.maxPct : ''}%` : '';
  const bits = [s.tf, vol].filter(Boolean);
  return bits.length ? ` (${bits.join(', ')})` : '';
};
function describe(s) { return describeBase(s) + describeExtra(s); }
function describeBase(s) {
  switch (s.type) {
    case 'ma-cross': return `${s.ma.toUpperCase()} ${s.fast}/${s.slow} golden cross`;
    case 'macd-cross': return `MACD(${s.fast}, ${s.slow}, ${s.signal}) golden cross`;
    case 'rsi-cross': return `RSI(${s.period}) crosses up through ${s.level}`;
    case 'boll-break': return `BOLL(${s.period}, ${s.mult}) close above upper band`;
    default: return `BOLL(${s.period}, ${s.mult}) close below lower band`;
  }
}
function describeEntry(entry) {
  const e = entryOf({ entry });
  if (e.mode) return e.mode === 'taker' ? 'market (taker) order right away' : `limit (maker) order at ${e.limitPx}`;
  const join = l => l === 'and' ? ' AND ' : ' OR ';
  const groups = e.groups.map(g => g.signals.map(describe).join(join(g.logic)));
  const text = groups.length === 1 ? groups[0] : groups.map(g => `(${g})`).join(join(e.logic));
  const anyAnd = e.logic === 'and' && e.groups.length > 1 || e.groups.some(g => g.logic === 'and' && g.signals.length > 1);
  return anyAnd ? `${text} [AND within ${e.window} bars]` : text;
}

module.exports = { cyclesDone, CYCLE_CHECK_MS, signalTf, checkWait, checkEvery, ladder, usable, crossTest, entryOf, entrySignals, entrySignal, entrySignalMulti, signalTest, distinctTfs, dropAt, qtyFor, marginOf, firstMargin, marginFor, addMargin, extraInvestment, minOrderMargin, topUpFor, planned, levels, plan, decide, volatilityCheck, describe, describeEntry };
