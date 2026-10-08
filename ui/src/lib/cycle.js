// Numbers about a bot's cycles, shared by the list and the bot page. The order math itself comes from dca.mjs.
import { planFrom, qtyFactor } from '../../../dca.mjs';

export const mgOf = b => ({ investment: +b.investment, maxAdds: +b.maxAdds, stepPct: +b.stepPct, stepMult: +b.stepMult, amountMult: +b.amountMult, tpPct: +b.tpPct, leverage: +b.leverage });

// every transaction of a cycle, newest first: { side, cls, ts, px, qty, fee, feeEst, orderType }; fee null = not recorded
export function cycleTx(c) {
  const tx = (c.orders || []).map(o => ({ side: o.manual ? 'Manual buy' : o.n === 0 ? 'Open long' : `Add #${o.n}`, cls: 'up', ts: o.ts, px: o.px, qty: o.qty,
    fee: o.fee ?? null, feeEst: !!o.feeEst, orderType: o.orderType || (o.n === 0 ? 'market' : null) }));
  for (const r of c.reductions || []) tx.push({ side: 'Reduce', cls: 'down', ts: r.ts, px: r.px, qty: r.qty, fee: r.fee ?? null, orderType: r.orderType });
  const x = c.exit || (c.exitPx != null ? { ts: c.closedAt, px: c.exitPx, qty: c.qty } : null);
  if (x) tx.push({ side: c.closedBy === 'closed' ? 'Close' : c.closedBy === 'reset' ? 'Reset' : 'Take profit', cls: 'down', ts: x.ts, px: x.px, qty: x.qty,
    fee: x.fee ?? null, feeEst: !!x.feeEst, orderType: x.orderType || null });
  return tx.sort((a, b) => b.ts - a.ts);
}
export const txFees = tx => tx.some(t => t.fee === null) ? null : tx.reduce((s, t) => s + t.fee, 0);
// a closed cycle's profit after fees (gross when its fees were never recorded)
export const cycleNet = h => { const f = txFees(cycleTx(h)); return f === null ? h.pnl : h.pnl - f; };

export function botNumbers(v) {
  const b = v.bot, p = v.pos, st = v.state, mg = mgOf(b);
  const manual = p ? p.orders.filter(o => o.manual).reduce((s, o) => s + (o.margin || 0), 0) : 0;
  // realized = closed cycles after their fees (the page gets the last 100 cycles; older bots without history use the saved total)
  const realized = v.history && v.history.length ? v.history.reduce((s, h) => s + cycleNet(h), 0) : st ? st.realizedPnl : 0;
  const total = realized + (v.upnl || 0), capital = mg.investment + manual;
  return { b, p, st, mg, manual, realized, total, capital, planN: p ? p.orders.filter(o => !o.manual).length : 0, max: (+b.maxAdds || 0) + 1,
    toTp: p && v.price ? (p.tp / v.price - 1) * 100 : null, toAdd: p && v.price && p.nextAdd ? (1 - p.nextAdd / v.price) * 100 : null };
}

// the adds still to come: the cycle's fixed list (pos.plan, a live bot) or else the rules applied now (preview)
export function remainingAdds(p) {
  const done = p.orders.filter(o => !o.manual).length || 1;
  return p.plan ? p.plan.adds.filter(a => a.k >= done) : p.preview.slice(done);
}
// an open cycle: its filled orders, then the adds still to come
export function cycleRows(p, mg, c) {
  const rows = [], first = p.orders[0].px;
  let qty = 0, cost = 0, used = 0;
  for (const o of p.orders) {
    qty += o.qty; cost += o.qty * o.px; used += o.margin || 0;
    rows.push({ n: o.n, ts: o.ts, manual: o.manual, px: o.px, drop: (1 - o.px / first) * 100, qty: o.qty, m: o.margin || 0, used, avg: cost / qty, tp: cost / qty * (1 + mg.tpPct / 100), filled: true });
  }
  // a live cycle shows exactly the adds fixed when it opened (what rests on the exchange), never a recalculation
  if (p.plan) {
    for (const a of remainingAdds(p)) {
      const m = a.px * a.qty * qtyFactor(mg.leverage);
      qty += a.qty; cost += a.qty * a.px; used += m;
      rows.push({ n: a.k, px: a.px, drop: (1 - a.px / first) * 100, qty: a.qty, m, used, avg: cost / qty, tp: cost / qty * (1 + mg.tpPct / 100), filled: false });
    }
    return rows;
  }
  // the ladder continues after the planned (non-manual) orders, every add measured from the first of them
  const plan = p.orders.filter(o => !o.manual), ladder = plan.length ? plan : p.orders.slice(0, 1);
  return rows.concat(planFrom(mg, c, ladder.length, ladder[0].px, qty, cost, used));
}

// A resting order's state on the exchange: pending there (green), missing (red), not asked / bot stopped (grey).
// '' = a simulated bot: no exchange to ask.
export const restState = (v, o) => {
  if (v.bot.dryRun || !v.pos) return '';
  if (!o) return v.enabled ? 'miss' : 'unk';
  return o.onExchange === true ? 'pend' : o.onExchange === false ? 'miss' : 'unk';
};
export const restTip = (st, o) => ({ pend: 'Pending on Bitget', miss: o ? 'Not pending: not on Bitget' : 'Not pending: not placed yet',
  unk: o ? "Can't read Bitget" : 'Not pending: the bot is stopped', fill: 'Filled' })[st] || '';
export const tooSmall = (r, c) => c && (r.qty < c.minQty || r.qty * r.px < c.minValue);
