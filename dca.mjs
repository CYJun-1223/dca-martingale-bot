// The DCA order rules: pure math, no I/O. The ONE copy used by the bot (strategy.js requires it) and by the dashboard
// (ui/ imports it), so a preview can never show different orders from the ones the bot places.
//   order #n margin = A x amountMult^n (n = 0 is the first order), A = investment / sum of amountMult^n  (no reserve)
//   add #n price    = entry x (1 - drop n), drop n = stepPct% x (1 + stepMult + ... + stepMult^(n-1)), every add from the entry
//   qty             = margin / (price x (1.1 / leverage + 1.1 x fee)), the 10% and the fee are headroom
// cfg = { investment, maxAdds, stepPct, stepMult, amountMult, leverage, tpPct }

export const FEE = 0.0006;
// drop (fraction of the entry price) of add #n
export const dropAt = (cfg, n) => cfg.stepPct / 100 * Array.from({ length: n }, (_, j) => Math.pow(cfg.stepMult, j)).reduce((a, b) => a + b, 0);
export const weight = (cfg, n) => Math.pow(cfg.amountMult, n);
export const weightSum = cfg => Array.from({ length: cfg.maxAdds + 1 }, (_, n) => weight(cfg, n)).reduce((a, b) => a + b, 0);
export const addBase = cfg => cfg.investment / weightSum(cfg);
// margin (USDT) of order #k (0 = first order)
export const marginFor = (cfg, k) => addBase(cfg) * weight(cfg, k);
export const firstMargin = cfg => marginFor(cfg, 0);
export const qtyFactor = lev => 1.1 / lev + 1.1 * FEE;
export const qtyFor = (margin, px, lev) => margin / (px * qtyFactor(lev));
// the margin an order of qty at px used up, by the same rule
export const marginOf = (px, qty, lev) => px * qty * qtyFactor(lev);
// round down to the exchange's steps
export const floorTo = (x, dp) => { const f = Math.pow(10, dp); return Math.floor(x * f + 1e-9) / f; };
export const floorStep = (q, step, dp) => +(Math.floor(q / step + 1e-9) * step).toFixed(dp);

// the whole cycle if every add fills exactly at its trigger, unrounded: for checks and the server's preview
export function plan(cfg, firstPx) {
  const rows = [];
  let qty = 0, cost = 0, margin = 0;
  for (let k = 0; k <= cfg.maxAdds; k++) {
    const px = firstPx * (1 - dropAt(cfg, k));
    const m = marginFor(cfg, k), q = qtyFor(m, px, cfg.leverage);
    qty += q; cost += q * px; margin += m;
    rows.push({ n: k, px, dropPct: dropAt(cfg, k) * 100, margin, orderMargin: m, notional: q * px,
      avg: cost / qty, tp: cost / qty * (1 + cfg.tpPct / 100) });
  }
  return rows;
}

// Orders #fromN..maxAdds of a cycle whose entry is `first`, as the bot places them: price rounded down to the price
// decimals, qty rounded down to the qty step (c = { step, qdp, pdp }; no c = unrounded qty, 2 price decimals).
// qty / cost / used carry on from orders already filled. Rows: { n, px, drop, qty, m, used, avg, tp, filled: false }
export function planFrom(cfg, c, fromN, first, qty = 0, cost = 0, used = 0) {
  const rows = [], pdp = c && c.pdp >= 0 ? c.pdp : 2;
  for (let k = fromN; k <= cfg.maxAdds; k++) {
    const exact = first * (1 - dropAt(cfg, k)), px = floorTo(exact, pdp);
    const m = marginFor(cfg, k), raw = qtyFor(m, exact, cfg.leverage), q = c ? floorStep(raw, c.step, c.qdp) : raw;
    qty += q; cost += q * px; used += m;
    rows.push({ n: k, px, drop: (1 - px / first) * 100, qty: q, m, used, avg: qty ? cost / qty : px, tp: (qty ? cost / qty : px) * (1 + cfg.tpPct / 100), filled: false });
  }
  return rows;
}
export const planRows = (cfg, firstPx, c) => planFrom(cfg, c, 0, firstPx);

// smallest margin (USDT) whose order passes the exchange minimums at this price; c = { step, qdp, minQty, minValue }
export function minOrderMargin(price, leverage, c) {
  const q = +Math.max(c.minQty, Math.ceil((c.minValue || 0) / price / c.step - 1e-9) * c.step).toFixed(c.qdp);
  return marginOf(price, q, leverage);
}
// smallest investment whose first order (the smallest) passes the exchange minimums at this price
export const minInvestment = (cfg, price, c) => Math.ceil(minOrderMargin(price, cfg.leverage, c) * weightSum(cfg) / weight(cfg, 0) * 100) / 100;
