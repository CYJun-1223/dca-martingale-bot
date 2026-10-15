// Parity: the dashboard (ui/) shows orders computed by dca.mjs; the bot places orders from strategy.js (which uses
// dca.mjs too, plus its own live ladder). Check the preview equals what the bot places, across many settings and prices.
// Run: node test/parity.js
const assert = require('assert');
const S = require('../apps/server/strategy');
const D = require('../apps/server/dca.mjs'); // what the dashboard imports

const down = (x, d) => Math.floor(x * 10 ** d + 1e-9) / 10 ** d;
const c = { step: 0.01, qdp: 2, pdp: 2, minQty: 0.01, minValue: 5 };
let n = 0;
for (const investment of [150, 1000, 5000])
  for (const leverage of [3, 10, 20])
    for (const [stepPct, stepMult] of [[0.85, 1.02], [2, 1.5], [1, 1]])
      for (const [maxAdds, amountMult] of [[20, 1.12], [5, 2], [10, 1]])
        for (const entry of [639.4, 100, 25.37]) {
          const cfg = { investment, leverage, stepPct, stepMult, maxAdds, amountMult, tpPct: 2.55 };
          const tag = JSON.stringify({ ...cfg, entry });
          const ui = D.planRows(cfg, entry, c), bot = S.plan(cfg, entry);
          assert.strictEqual(ui.length, bot.length, `order count ${tag}`);
          bot.forEach((r, k) => {
            assert.strictEqual(ui[k].px, down(r.px, 2), `price #${k} ${tag}`);
            assert.ok(Math.abs(ui[k].m - r.orderMargin) < 1e-9, `margin #${k} ${tag}`);
            assert.strictEqual(ui[k].qty, down(S.qtyFor(r.orderMargin, r.px, leverage), 2), `qty #${k} ${tag}`);
          });
          // the live ladder after the first fill places the same prices and sizes as the preview shows
          const pos = { orders: [{ n: 0, px: entry, qty: ui[0].qty, margin: S.firstMargin(cfg) }], qty: ui[0].qty, cost: entry * ui[0].qty };
          const lad = S.ladder(pos, cfg, { q: x => down(x, 2), pdp: 2, minQty: 0, minNotional: 0 }).adds;
          lad.forEach(a => assert.deepStrictEqual([a.px, a.qty], [ui[a.k].px, ui[a.k].qty], `ladder #${a.k} ${tag}`));
          n++;
        }
// the fixed reference table (T 150, 20 adds, 10x, entry 639.4, step 0.85% x 1.02, amount x 1.12)
const ref = D.planRows({ investment: 150, maxAdds: 20, leverage: 10, stepPct: 0.85, stepMult: 1.02, amountMult: 1.12, tpPct: 2.55 }, 639.4, c);
assert.deepStrictEqual([ref[0].px, ref[0].qty, ref[20].px, ref[20].qty], [639.4, 0.02, 507.34, 0.31]);
assert.strictEqual(+ref.reduce((s, r) => s + r.px * r.qty, 0).toFixed(2), 1282.95);
console.log(`parity: dashboard (dca.mjs) and the bot (strategy.js) agree on ${n} settings x every order`);
