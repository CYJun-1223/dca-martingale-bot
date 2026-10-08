// Subscriber: records every open / add / take profit / close / reduce of a bot as one row of the trade ledger (database table
// trades). The dashboard's "Download CSV" turns the rows back into the CSV it always gave (toCsv).
const db = require('./db');

const localTime = ts => new Date(ts).toLocaleString('sv-SE').slice(0, 16);
const duration = ms => { const m = Math.round(ms / 60e3), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`; };

const HEADER = 'time,symbol,cycle,action,order,qty,price,margin,avg_price,pnl,opened_at,held,mode\n';

class Recorder {
  // add = where a row goes (the database; tests pass their own)
  constructor(botId, add = db.addTrade) { this.botId = botId; this.add = add; }
  static forBot(cfg) { return new Recorder(cfg.id); }

  attach(bus) {
    return bus.subscribe(ev => {
      if (ev.type === 'open' || ev.type === 'add') return this.row(ev, ev.type, ev.n, ev.margin, null, ev.ts, '');
      if (ev.type === 'close') return this.row(ev, ev.kind, ev.orders, null, ev.pnl, ev.openedAt, duration(ev.heldMs));
      if (ev.type === 'reduce') return this.row(ev, 'reduce', null, null, ev.pnl, ev.ts, '');
    });
  }

  // a failed write is reported (the bus logs a subscriber's error) but never stops the bot: the state already has the trade
  row(ev, action, order, margin, pnl, openedAt, held) {
    const r = (v, d) => v === null || v === undefined || v === '' ? null : +(+v).toFixed(d);
    return this.add({ bot_id: this.botId, ts: new Date(ev.ts), symbol: ev.symbol, cycle: ev.id, action, ord: order === '' ? null : order,
      qty: ev.qty, price: r(ev.px, ev.pdp ?? 2), margin: r(margin, 2), avg_price: r(ev.avg, ev.pdp ?? 2), pnl: r(pnl, 2),
      opened_at: openedAt ? new Date(openedAt) : null, held, mode: ev.mode });
  }
}

// the rows of one bot as the CSV it always downloaded (opens directly in Excel)
function toCsv(rows) {
  const t = v => v ? localTime(new Date(v).getTime()) : '', n = v => v === null || v === undefined ? '' : String(+v);
  return HEADER + rows.map(x => [t(x.ts), x.symbol, x.cycle ?? '', x.action, x.ord ?? '', n(x.qty), n(x.price), n(x.margin), n(x.avg_price), n(x.pnl),
    t(x.opened_at), x.held || '', x.mode || ''].join(',')).join('\n') + (rows.length ? '\n' : '');
}

module.exports = { Recorder, toCsv, duration, localTime, HEADER };
