// Event bus: the engine announces what happened; subscribers react on their own.
// Today's subscribers: alerts.js (Telegram + alerts log) and recorder.js (trades CSV).
// Later: a live executor subscribes to `open` / `close` to place the real orders.
//
// Every event carries: type, ts, bot, symbol, tf, mode ('SIM' | 'LIVE'), pdp (price decimals)
//   start    { checkTf, portions, parts }
//   stop     {}
//   signal   { barTs, close, action: 'open' | 'none', reason, portions, parts, signal }
//   open     { id, why: 'signal', px, qty, levels: { tps: [price per TP], lock }, portions, parts }
//   close    { kind: 'tp1' .. 'tpN' | 'lock', id, px, qty, pnl, roe, realized, done, openedAt, heldMs, portionPnl, pct, last }
//   error    { message, recovered? }
//   mismatch { exchangeQty, botQty, resolved }
class Bus {
  constructor({ onError = (e, ev) => console.error(`subscriber failed on ${ev.type}: ${e.message}`) } = {}) {
    this.subs = []; this.onError = onError;
  }

  // fn(event) is called for every event; filter on event.type inside
  subscribe(fn) { this.subs.push(fn); return () => { this.subs = this.subs.filter(x => x !== fn); }; }

  // Subscribers run in order. Their synchronous part runs immediately; async work
  // (e.g. a Telegram request) continues in the background so a slow subscriber
  // never delays the next price check. Errors are reported, never thrown.
  emit(type, data = {}) {
    const ev = { type, ...data };
    for (const fn of this.subs) {
      try {
        const r = fn(ev);
        if (r && typeof r.catch === 'function') r.catch(e => this.onError(e, ev));
      } catch (e) { this.onError(e, ev); }
    }
    return ev;
  }
}

module.exports = { Bus };
