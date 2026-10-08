// Stage 3 - alerts: tells Jun what the bot saw and did.
// Always appends to alerts-<id>.log (shown on the dashboard). Also sends to Telegram when
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set in .env. Never throws: a failed alert
// must not stop the bot.
const fs = require('fs');
const path = require('path');

const ICON = { reset: '🔁', signal: '📶', open: '🟢', add: '➕', reduce: '➖', tp: '💰', mismatch: '⚠️', error: '❌', start: '▶️', stop: '⏹', test: '🔔' };

class Alerts {
  constructor(cfg, { dir = '.', botId = 'bot', now = () => Date.now(), send = null } = {}) {
    this.cfg = cfg; this.botId = botId; this.now = now;
    this.file = path.join(dir, cfg.alertsFile || `alerts-${botId}.log`);
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.chat = process.env.TELEGRAM_CHAT_ID;
    this.sendFn = send || (this.token && this.chat ? t => this.telegram(t) : null);
    this.sent = []; // kept in memory for tests
  }

  get channels() { return ['log', ...(this.sendFn ? ['telegram'] : [])]; }

  async send(kind, text) {
    const ts = new Date(this.now()).toLocaleString('sv-SE').slice(0, 16);
    const mode = this.cfg.dryRun ? 'SIM' : 'LIVE';
    const line = `${ts} ${kind.toUpperCase().padEnd(8)} ${text}`;
    this.sent.push({ kind, text });
    try { fs.appendFileSync(this.file, line + '\n'); } catch { /* disk full etc: keep going */ }
    if (!this.sendFn) return;
    if ((kind === 'start' || kind === 'stop') && !this.cfg.notifyStartStop) return; // startup / shutdown stay in the log, not on Telegram
    const broker = { bitget: 'Bitget', binance: 'Binance' }[this.cfg.broker || 'bitget'] || this.cfg.broker;
    const msg = `${ICON[kind] || (/^tp\d+$/.test(kind) ? '💰' : '•')} ${this.cfg.symbol} · ${broker} · ${this.botId}${mode === 'LIVE' ? ' · LIVE' : ''}\n${text}`;
    try { await this.sendFn(msg); }
    catch (e) { try { fs.appendFileSync(this.file, `${ts} ALERTERR telegram: ${e.message}\n`); } catch { /* ignore */ } }
  }

  // subscribe to the engine's events and turn each into a message
  attach(bus) { return bus.subscribe(ev => { const m = format(ev); if (m) return this.send(m[0], m[1]); }); }

  async telegram(text) {
    const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10e3),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`);
  }
}

const t = ts => new Date(ts).toLocaleString('sv-SE').slice(0, 16);
const sgn = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const { describeEntry } = require('./strategy');
const { duration } = require('./recorder');

// event -> [kind, text], or null for events that don't alert
function format(ev) {
  const p = v => v.toFixed(ev.pdp ?? 2);
  switch (ev.type) {
    // K-line and check interval belong to an indicator entry only
    case 'start': return ['start', `Bot started. Entry: ${describeEntry(ev.entry)}${ev.entry && ev.entry.mode ? '' : ` on ${ev.tf}, checked when each ${ev.checkTf} candle closes`}.\n` +
      `Martingale: ${ev.investment} USDT, ${ev.maxAdds} adds, step ${ev.stepPct}% ×${ev.stepMult}, amount ×${ev.amountMult}, TP ${ev.tpPct}%. ${ev.open ? `Cycle #${ev.open} is open.` : 'Waiting for a signal.'}`];
    case 'stop': return ['stop', 'Bot stopped.'];
    case 'advice': return ['signal', ev.message];
    case 'signal': return ['signal', `Entry signal (${describeEntry(ev.entry)}, ${ev.tf}) on bar ${t(ev.barTs)}, close ${p(ev.close)}\n→ ${
      ev.action === 'open' ? 'opening a new cycle' : `no action: ${ev.reason}`}`];
    case 'open': case 'add': {
      const kind = t => t === 'limit' ? 'limit / maker' : 'market / taker';
      const head = ev.manual ? `Cycle #${ev.id} manual buy (${kind(ev.orderType)})` : ev.type === 'open' ? `Cycle #${ev.id} opened` : `Cycle #${ev.id} add ${ev.n}/${ev.maxAdds}`;
      return [ev.type, `${head} at ${t(ev.ts)}: ${ev.qty} @ ${p(ev.px)} (${ev.margin.toFixed(2)} USDT margin)\n` +
        `avg ${p(ev.avg)} · TP ${p(ev.tp)} · ${ev.nextAdd ? `next add ${p(ev.nextAdd)}` : 'no adds left'} · margin used ${ev.totalMargin.toFixed(2)} USDT`];
    }
    case 'halt': return ['stop', ev.message];
    case 'close': return [ev.kind === 'close' ? 'stop' : ev.kind === 'reset' ? 'reset' : 'tp', `Cycle #${ev.id} ${ev.kind === 'close' ? 'closed' : ev.kind === 'reset' ? 'reset (sold on request)' : 'take profit'} at ${t(ev.ts)}: ${ev.qty} @ ${p(ev.px)} (avg ${p(ev.avg)}, ${ev.orders} orders)\n` +
      `P&L ${sgn(ev.pnl)} USDT (${sgn(ev.pnlPct)}% on margin) · opened ${t(ev.openedAt)}, held ${duration(ev.heldMs)} · total ${ev.realized.toFixed(2)} USDT`];
    case 'reduce': return ['reduce', `Cycle #${ev.id} manual sell (${ev.orderType === 'limit' ? 'limit / maker' : 'market / taker'}) at ${t(ev.ts)}: ${ev.qty} @ ${p(ev.px)}, avg ${p(ev.avg)}\n` +
      `P&L ${sgn(ev.pnl)} USDT (fee ${ev.fee.toFixed(4)}) · ${ev.left ? `${ev.left} left` : 'position closed'} · total ${ev.realized.toFixed(2)} USDT`];
    case 'error': return ['error', ev.message];
    case 'mismatch': return ['mismatch', ev.resolved ? 'Position back in sync. Entries resumed.'
      : `Bitget position ${ev.exchangeQty} ≠ bot ${ev.botQty}. New entries paused until they match.`];
    default: return null;
  }
}

module.exports = { Alerts, format };
