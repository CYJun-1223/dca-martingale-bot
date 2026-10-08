// #/ : account and P&L tiles, then one row per bot (or per alert-only watch)
import { useData, useUi, post } from './core.jsx';
import { fx, money, dir, ago } from './lib/format.js';
import { entryOf, sigLabel } from './lib/entry.js';
import { botNumbers } from './lib/cycle.js';

export const brokerName = (S, b) => (S.brokers && S.brokers[b.broker || 'bitget'] || {}).label || b.broker || 'Bitget';

export function Status({ v }) {
  if (v.state && v.state.halted) return <span className="status warn">⚠ Paused</span>;
  return { running: <span className="status run"><i />Running</span>, starting: <span className="status warn"><i className="pulse" />Starting…</span>,
    down: <span className="status warn">⚠ Not responding</span>, closed: <span className="status stop"><i />Closed</span> }[v.status] || <span className="status stop"><i />Stopped</span>;
}
const WatchStatus = ({ v }) => ({ running: <span className="status run"><i />Watching</span>, starting: <span className="status warn"><i className="pulse" />Starting…</span>,
  down: <span className="status warn">⚠ Not responding</span> }[v.status] || <span className="status stop"><i />Off</span>);

// Pause trading: live bots send no orders and take their resting orders off the exchange; resume places them again
function PauseCtl({ live }) {
  const { S, load } = useData(), { ask, toast } = useUi();
  const set = async on => {
    if (on && !await ask('Pause trading?', 'Live bots stop sending orders and cancel their resting orders (adds and take profit) on the exchange. Open positions stay open, without a take-profit order, until you resume. Resume places the orders again.', 'Pause')) return;
    try { await post('/api/stop-all', { on }); toast(on ? 'Trading paused' : 'Trading resumed'); } catch (e) { toast(e.message, true); }
    load();
  };
  if (S.stopAll) return <div className="paused">⏸ Trading paused{S.editable && <> <button className="btn small" onClick={() => set(false)}>Resume</button></>}</div>;
  return live && S.editable ? <button className="btn small pause-btn" onClick={() => set(true)} title="Pause trading on all live bots">⏸ Pause</button> : null;
}

function Overview() {
  const { S } = useData(), b = S.bots;
  const up = b.reduce((s, v) => s + (v.upnl || 0), 0), re = b.reduce((s, v) => s + botNumbers(v).realized, 0);
  const tot = up + re, capital = b.reduce((s, v) => s + (+v.bot.investment || 0), 0), live = b.some(x => !x.bot.dryRun);
  return <section className="overview" id="overview">
    {Object.entries(S.accounts || {}).map(([k, a], i) => <div key={k} className="tile hero">
      <div className="acct-head"><div className="label">{(S.brokers && S.brokers[k] && S.brokers[k].label) || k} futures account</div>{i ? null : <PauseCtl live={live} />}</div>
      {a.error ? <div className="sub">Couldn't read the balance: {a.error}</div> : <>
        <div className="value">{fx(a.equity, 4)} <small className="faint" style={{ fontSize: 14 }}>USDT</small></div>
        <div className="acct-bar" title={`In orders ${fx(a.locked, 2)} of ${fx(a.equity, 2)} USDT`}><i style={{ width: `${a.equity > 0 ? Math.min(100, a.locked / a.equity * 100).toFixed(1) : 0}%` }} /></div>
        <div className="acct-row">
          <div><div className="l"><i className="sw lk" />In orders</div><div className="v">{fx(a.locked, 4)}</div></div>
          <div><div className="l"><i className="sw fr" />Free</div><div className="v">{fx(a.free, 4)}</div></div>
          <div><div className="l">Unrealized</div><div className={`v ${dir(a.upl)}`}>{money(a.upl)}</div></div>
        </div></>}
    </div>)}
    <div className="tile hero"><div className="acct-head"><div className="label">Bots P&amp;L</div>{capital ? <span className={`pct ${dir(tot)}`}>{money(tot / capital * 100, 2)}%</span> : null}</div>
      <div className={`value ${dir(tot)}`}>{money(tot)} <small className="faint" style={{ fontSize: 14 }}>USDT</small></div>
      <div className="acct-row" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 12 }}>
        <div><div className="l">Unrealized</div><div className={`v ${dir(up)}`}>{money(up)}</div></div>
        <div><div className="l">Realized</div><div className={`v ${dir(re)}`}>{money(re)}</div></div>
        <div><div className="l">Invested</div><div className="v">{fx(capital, 0)}</div></div>
      </div></div>
  </section>;
}

function BotRow({ v }) {
  const { S } = useData(), b = v.bot, N = botNumbers(v), n = v.pos ? v.pos.orders.filter(o => !o.manual).length : 0;
  return <a className="botrow" href={`#/bot/${b.id}`}>
    <div className="br-main">
      <div className="title-row"><span className="bot-name">{b.name}</span><Status v={v} /></div>
      <div className="strategy">{b.symbol} · {brokerName(S, b)} · Martingale · {b.leverage}x</div>
      <div className="br-pnl"><span className="l">P&amp;L</span><b className={dir(N.total)}>{money(N.total)}</b><small className="faint">USDT</small>
        {N.capital ? <span className={`pct ${dir(N.total)}`}>{money(N.total / N.capital * 100, 2)}%</span> : null}</div>
    </div>
    <div className="kpis">
      <div className="kpi"><div className="l">Price</div><div className="v">{fx(v.price)}</div></div>
      <div className="kpi"><div className="l">{v.pos ? `Cycle #${v.pos.id}` : 'No cycle'}</div><div className="v">{n} | {N.max}</div></div>
      <div className="kpi"><div className="l">Unrealized</div><div className={`v ${dir(v.upnl)}`}>{money(v.upnl)}</div></div>
      <div className="kpi"><div className="l">Realized</div><div className={`v ${dir(N.realized)}`}>{money(N.realized)}</div></div>
      <svg className="chev" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </div>
  </a>;
}

function WatchRow({ v, onOpen }) {
  const { S, load } = useData(), { toast } = useUi(), w = v.watch, last = v.signals[0];
  const toggle = async on => {
    try { await post(`/api/watches/${w.id}/${on ? 'start' : 'stop'}`); toast(on ? 'Alert on' : 'Alert off'); } catch (e) { toast(e.message, true); }
    load();
  };
  return <div className="botrow" role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}>
    <div className="br-main">
      <div className="title-row"><span className="bot-name">{w.name}</span><WatchStatus v={v} /></div>
      <div className="strategy">{w.symbol} · {brokerName(S, w)} · {entryOf(w).groups.flatMap(g => g.signals).map(sigLabel).join(' · ')}</div>
    </div>
    <div className="kpis">
      <div className="kpi"><div className="l">Price</div><div className="v">{fx(v.price)}</div></div>
      <div className="kpi"><div className="l">Last alert</div><div className="v">{last ? ago(last.ts) : 'none yet'}</div></div>
      {S.editable && <label className="tgl" onClick={e => e.stopPropagation()} title={v.enabled ? 'On: tap to turn off' : 'Off: tap to turn on'}>
        <input type="checkbox" checked={!!v.enabled} onChange={e => toggle(e.target.checked)} /><i /></label>}
    </div>
  </div>;
}

export default function ListPage({ tab, setTab, openForm, slide }) {
  const { S } = useData(), live = S.bots.some(x => !x.bot.dryRun);
  return <>
    <div id="listTop" style={{ display: 'grid', gap: 10 }}>
      <div className="seg2" id="listTabs">{[['bots', `Bots (${S.bots.length})`], ['alerts', `Alerts (${S.watches.length})`]].map(([k, l]) =>
        <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div id="listNote">{tab === 'alerts'
        ? !S.telegram && <div className="banner">Telegram is not set up, so alerts cannot reach you. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env and restart the runner.</div>
        : !Object.keys(S.accounts || {}).length && <PauseCtl live={live} />}</div>
    </div>
    {tab === 'bots' && <Overview />}
    <div id="bots" className={slide} style={{ display: 'grid', gap: 14 }}><div className="list">
      {tab === 'alerts'
        ? S.watches.length ? S.watches.map(v => <WatchRow key={v.watch.id} v={v} onOpen={() => openForm(v.watch.id, 'alert')} />)
          : <div className="tile empty">No alerts yet. An alert follows indicators on a stock and sends you a Telegram message when they fire. You place the trades yourself.
            {S.editable && <><br /><br /><button className="btn primary" onClick={() => openForm(null, 'alert')}>Create your first alert</button></>}</div>
        : S.bots.length ? S.bots.map(v => <BotRow key={v.bot.id} v={v} />)
          : <div className="tile empty">No bots yet.{S.editable && <><br /><br /><button className="btn primary" onClick={() => openForm(null, 'bot')}>Create your first bot</button></>}</div>}
    </div></div>
  </>;
}
