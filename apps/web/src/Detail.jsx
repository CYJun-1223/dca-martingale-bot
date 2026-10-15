// #/bot/<id>/<tab> : one bot, laid out like the exchange apps' bot details
import { Fragment, useEffect, useRef } from 'react';
import { useData, useUi, usePanels, post, TABS, useNow } from './core.jsx';
import { fx, money, dir, ago, when, heldFor, feeFx, coinOf } from './lib/format.js';
import { entryOf, entryText, sigLabel, usesAnd } from './lib/entry.js';
import { botNumbers, cycleRows, cycleTx, txFees, cycleNet, restState, restTip } from './lib/cycle.js';
import { firstMargin, planRows } from '../../server/dca.mjs';
import { brokerName } from './List.jsx';

const Kv = ({ label, value, sub, cls = '' }) => <div className="kv"><div className="l">{label}</div><div className={`v ${cls}`}>{value}</div>{sub ? <div className="s">{sub}</div> : null}</div>;

// ---------- header ----------
function Head({ v }) {
  const { S, load } = useData(), { toast } = useUi(), { open } = usePanels(), b = v.bot, created = Date.parse(b.createdAt);
  useNow(60e3);
  const tags = [brokerName(S, b), 'Martingale', 'Long', `${b.leverage}x`, b.dryRun ? '' : 'LIVE'].filter(Boolean);
  const st = v.state && v.state.halted ? ['warn', 'Paused'] : { running: ['run', 'Running'], starting: ['warn', 'Starting…'], down: ['warn', 'Not responding'], closed: ['stop', 'Closed'] }[v.status] || ['stop', 'Stopped'];
  const disarm = async what => {
    try { await post(`/api/bots/${b.id}/action`, { action: 'disarm', what }); toast(`${what === 'stop' ? 'Stop' : 'Close'} cancelled`); load(); } catch (e) { toast(e.message, true); }
  };
  const e = entryOf(b);
  return <div className="bd-head">
    <div className="bd-title"><h1>{b.name}</h1><span className={`st ${st[0]}`}>{st[1]}</span></div>
    <div className="tags">{tags.map(t => <span key={t} className={`tag ${t === 'Long' ? 'long' : t === 'LIVE' ? 'live' : ''}`}>{t}</span>)}</div>
    <div className="faint meta">{b.symbol} · {entryText(e)}{e.mode ? '' : ` · ${b.tf}`}</div>
    <div className="faint meta">Created {when(created)}, running {heldFor(Date.now() - created)}</div>
    {/* a stop / close waiting for its price (or for the bot's next check) */}
    {['stop', 'close'].filter(k => v.armed && v.armed[k]).map(k => {
      const a = v.armed[k], at = a.now ? 'at the next check' : `when the price ${a.dir === 'up' ? 'rises to' : 'falls to'} ${fx(a.px)}`;
      const text = k === 'close' && a.how === 'limit' ? `Closing with a limit sell at ${fx(a.limitPx)}${a.queued ? ' (sending…)' : v.closing ? ': it rests on Bitget and the bot ends when it fills' : ''}`
        : k === 'close' && a.how === 'hold' ? `Closing the bot and keeping the position${a.queued ? ' (sending…)' : ''}`
        : `${k === 'stop' ? 'Stop' : 'Close'} set ${at}${a.queued ? ' (sending…)' : ''}`;
      return <div key={k} className="banner armed">{text}. <button className="link" onClick={() => disarm(k)}>Cancel</button></div>;
    })}
    {v.short && <div className="banner">Order #{v.short.n} can't open: the exchange minimum needs at least {fx(v.short.need)} USDT margin. Add about {fx(v.short.topUp)} USDT to place it. Until then it is skipped and the bot keeps running. <button className="link" onClick={() => open('funds', b.id)}>Add funds</button></div>}
    {v.status === 'closed' && <div className="banner">This bot was closed{b.closedAt ? ` on ${when(Date.parse(b.closedAt))}` : ''}. It cannot be started again.</div>}
    {v.status === 'down' && <div className="banner">No check since {ago(v.lastSeen)}. The computer running the bots may be asleep or offline.</div>}
    {v.state && v.state.halted && <div className="banner">The exchange position doesn't match the bot's records. New entries are paused until they match.</div>}
  </div>;
}

// ---------- overview tab ----------
function PnlChart({ v, n }) {
  const pts = [[Date.parse(n.b.createdAt) || (v.history.length ? v.history[v.history.length - 1].openedAt : Date.now() - 864e5), 0]];
  let cum = 0;
  for (const h of v.history.slice().reverse()) { cum += cycleNet(h); pts.push([h.closedAt, cum]); }
  pts.push([Date.now(), n.total]);
  const W = 600, H = 150, L = 44, B = 20, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys), pad = (yMax - yMin || 1) * 0.1;
  const X = t => L + (t - x0) / ((x1 - x0) || 1) * (W - L - 6), Y = y => 6 + (yMax + pad - y) / ((yMax - yMin) + 2 * pad || 1) * (H - B - 6);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const day = t => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Profit and loss over time">
    <line x1={L} x2={W} y1={Y(0)} y2={Y(0)} className="zero" />
    <text x={L - 6} y={Y(yMax + pad) + 4} textAnchor="end">{fx(yMax, 2)}</text>
    <text x={L - 6} y={Y(yMin - pad)} textAnchor="end">{fx(yMin, 2)}</text>
    <text x={L} y={H - 4}>{day(x0)}</text><text x={W - 6} y={H - 4} textAnchor="end">{day(x1)}</text>
    <path d={d} className="line" />
    {pts.map((p, i) => <circle key={i} cx={X(p[0]).toFixed(1)} cy={Y(p[1]).toFixed(1)} r="6" className="hit"><title>{day(p[0])}: {money(p[1])} USDT</title></circle>)}
  </svg>;
}
function RestTile({ v }) {
  const R = v.resting, list = [R.tp, ...Object.values(R.adds)].filter(Boolean), open = list.filter(o => o.onExchange === true).length, bad = list.length - open;
  return <Kv label="Orders on Bitget" value={<>{open} <small>pending</small></>} cls={R.error || bad ? 'down' : 'up'}
    sub={R.error ? `can't read Bitget: ${R.error}` : `${Object.keys(R.adds).length} buys + ${R.tp ? '1 take profit' : 'no take profit'}${bad ? ` · ${bad} not found` : ''} · checked ${ago(R.checkedAt)}`} />;
}
function OverviewPane({ v }) {
  const n = botNumbers(v), p = n.p, sym = coinOf(n.b.symbol);
  return <>
    <div className="kvgrid">
      <Kv label="Total P&L" value={<>{money(n.total, 4)} <small>USDT</small></>} cls={dir(n.total)} />
      <Kv label="Return" value={`${money(n.capital ? n.total / n.capital * 100 : 0, 2)}%`} sub={`on ${fx(n.capital, 2)} USDT`} cls={dir(n.total)} />
      <Kv label="Unrealized" value={<>{money(v.upnl, 4)} <small>USDT</small></>} sub={p && p.pnlPct != null ? `${money(p.pnlPct, 1)}% on margin` : ''} cls={dir(v.upnl)} />
      <Kv label="Average price" value={p ? <>{fx(p.avg)} <small>USDT</small></> : '–'} />
      <Kv label="Margin used" value={<>{fx(p ? p.margin : 0, 4)} <small>USDT</small></>} sub={`investment ${fx(n.mg.investment, 0)}${n.manual ? ` + manual ${fx(n.manual)}` : ''}`} />
      <Kv label="Position" value={p ? <>{p.qty} <small>{sym}</small></> : '–'} />
      <Kv label="Add orders" value={`${Math.max(0, n.planN - 1)} | ${n.b.maxAdds}`} sub={n.manual ? '+ manual order' : ''} />
      <Kv label="Cycles closed" value={`${v.history.length}`} sub={`realized ${money(n.realized, 4)} USDT`} />
      <Kv label="Take profit" value={p ? fx(p.tp) : '–'} sub={n.toTp !== null ? `+${fx(n.toTp, 2)}% away` : `${n.b.tpPct}% above average`} />
      <Kv label="Next add" value={p ? (p.nextAdd ? fx(p.nextAdd) : 'none left') : '–'} sub={n.toAdd !== null ? `−${fx(n.toAdd, 2)}% away` : ''} />
      {v.resting && <RestTile v={v} />}
      <Kv label="Funding rate" value={v.funding ? `${fx(v.funding.rate * 100, 4)}%` : '–'}
        sub={v.funding ? `every ${v.funding.hours}h · next ${new Date(v.funding.next).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${p ? ` · ${v.funding.rate ? `≈ ${money(-v.funding.rate * p.qty * v.price, 4)} USDT` : 'no cost'}` : ''}` : ''} />
      <Kv label="Price" value={fx(v.price)} sub={`checked ${ago(v.lastCheck ? v.lastCheck.ts : v.lastSeen)}`} />
      <Kv label="Est. liquidation" value="–" sub="needs the exchange account" />
    </div>
    <h3 className="sec">P&amp;L</h3>
    <PnlChart v={v} n={n} />
  </>;
}

// ---------- parameters tab ----------
function ParamsPane({ v }) {
  const { S } = useData(), b = v.bot, e = entryOf(b), mg = botNumbers(v).mg;
  const G = ({ t, rows }) => <div><h4>{t}</h4><dl>{rows.map(([k, x]) => <Fragment key={k}><dt>{k}</dt><dd className="num">{x}</dd></Fragment>)}</dl></div>;
  return <>
    <div className="params">
      <G t="Market" rows={[['Broker', brokerName(S, b)], ['Symbol', b.symbol], ...(e.mode ? [] : [['K-line', b.tf]]), ['Hours', b.usMarketHoursOnly ? 'US market only' : '24/7']]} />
      <G t="Entry" rows={e.mode ? [['First order', entryText(e)], ['K-line / check', 'not used']] : [
        ...e.groups.map((gr, i) => [`Group ${i + 1}${gr.signals.length > 1 ? ` (${gr.logic === 'and' ? 'all' : 'any'})` : ''}`, gr.signals.map(sigLabel).join(gr.logic === 'and' ? ' AND ' : ' OR ')]),
        ...(e.groups.length > 1 ? [['Groups combine', e.logic === 'and' ? 'All (AND)' : 'Any (OR)']] : []), ...(usesAnd(e) ? [['AND window', `${e.window} bars`]] : [])]} />
      <G t="Martingale" rows={[['Investment', `${fx(mg.investment, 0)} USDT`], ['Leverage', `${mg.leverage}x ${b.marginMode === 'isolated' ? 'isolated' : 'cross'}`], ['First order', `${fx(firstMargin(mg))} USDT`],
        ['Max add orders', mg.maxAdds], ['Price step', `${mg.stepPct}% × ${mg.stepMult}`], ['Amount multiple', `× ${mg.amountMult}`], ['Take profit', `${mg.tpPct}% above average`], ['Stop loss', 'None']]} />
    </div>
    <p className="faint" style={{ fontSize: 12, margin: '14px 0 0' }}>Created {when(b.createdAt)}{b.updatedAt ? ` · edited ${when(b.updatedAt)}` : ''}</p>
  </>;
}

// ---------- orders tab: one timeline sorted by price, like an exchange app ----------
const BOMB = <svg className="bomb" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="14" r="7.5" fill="currentColor" stroke="none" /><path d="M16 8.5l2.5-2.5" /><path d="M20 2.5v3M18.5 4h3" /></svg>;
function RestBar({ v }) {
  const R = v.resting;
  if (!R || !v.pos) return null;
  const ck = ` · checked ${ago(R.checkedAt)}`;
  if (R.error) return <div className="restbar unk">Can't read Bitget right now ({R.error}). Orders may still be resting there.</div>;
  const tracked = [['Take profit', R.tp], ...Object.entries(R.adds).map(([k, o]) => [`Add ${k}`, o])].filter(([, o]) => o);
  const gone = tracked.filter(([, o]) => o.onExchange === false).map(([n]) => n), buys = Object.keys(R.adds).length, pend = tracked.length - gone.length;
  if (!v.enabled) return <div className="restbar unk">Bot stopped. {R.tp && R.tp.onExchange ? 'The take profit is still pending on Bitget; the buys were cancelled.' : 'Nothing is pending on Bitget for this position.'}{ck}</div>;
  if (gone.length || !R.tp) {
    const why = gone.length ? `${gone.slice(0, 4).join(', ')}${gone.length > 4 ? ` and ${gone.length - 4} more` : ''} not on Bitget` : 'No take profit is pending';
    return <div className="restbar bad"><b>{why}.</b> The bot places missing orders again within about 15 seconds; if this stays, check the Activity log.{ck}</div>;
  }
  return <div className="restbar ok"><span className="rest pend">●</span> <b>{pend} orders pending on Bitget</b> · {buys} buys + 1 take profit. They fill on the exchange; the bot only moves the take profit after a buy fills.{ck}</div>;
}
function OrdersPane({ v }) {
  const n = botNumbers(v), p = n.p, px = v.price;
  const rows = p ? cycleRows(p, n.mg, v.contract) : px ? planRows(n.mg, px, v.contract) : [];
  const pct = (a, b, d = 2) => b ? `(${money((a / b - 1) * 100, d)}%)` : '';
  const Ln = ({ l, r, cls = '' }) => <div className={`tl-ln ${cls}`}><span>{l}</span><span>{r}</span></div>;
  const Pc = ({ a }) => px ? <> <span className="pc">{pct(a, px)}</span></> : null;
  const liq = (avg, used, qty) => qty ? avg - used / qty : null;
  const liqTxt = l => <>{BOMB}{fx(l)} {px ? pct(l, px) : ''}</>;
  const share = amt => `${money(amt)} USDT (${money(n.capital ? amt / n.capital * 100 : 0, 2)}%)`;
  const items = []; // { px, pr, key, el }
  const item = (key, dot, cls, lines, st = '', tip = '') => <li key={key} className={`tl-item ${cls}${st ? ` st-${st}` : ''}`}>
    {dot ? <span className="dot" title={tip || undefined}>{dot}</span> : <span />}<div className="tl-body">{lines}</div></li>;
  if (p) {
    const tpSt = restState(v, v.resting && v.resting.tp);
    items.push({ px: p.tp, pr: 0, el: item('tp', '◎', 'tp', <Ln l={<><b>TP {p.qty}@{fx(p.tp)}</b><Pc a={p.tp} /></>} r={share((p.tp - p.avg) * p.qty)} />, tpSt, restTip(tpSt, v.resting && v.resting.tp)) });
    if (px) items.push({ px, pr: 1, el: item('now', ' ', 'now', <Ln l={<b>Now {fx(px)}</b>} r={<b>{money(v.upnl)}{n.capital ? ` (${money(v.upnl / n.capital * 100, 2)}%)` : ''}</b>} />) });
    items.push({ px: p.avg, pr: 2, el: item('avg', '', 'avg', <Ln l={<b>AVG {p.qty}@{fx(p.avg)}</b>} r={<span className="down">{liqTxt(liq(p.avg, p.margin, p.qty))}</span>} />) });
  } else if (px) items.push({ px, pr: 1, el: item('now', ' ', 'now', <Ln l={<b>Now {fx(px)}</b>} />) });
  let cq = 0;
  rows.forEach((r, i) => {
    cq = +(cq + r.qty).toFixed(8);
    const label = r.manual ? 'M' : `#${r.n}`;
    if (r.filled) { items.push({ px: r.px, pr: 3, el: item(`f${i}`, '✓', 'done', <><Ln l={<><b>{label} {r.qty}@{fx(r.px)}</b><Pc a={r.px} /></>} r={when(r.ts).slice(5)} /><Ln l={`${cq}@${fx(r.avg)}`} /></>, 'fill', restTip('fill')) }); return; }
    const addSt = restState(v, v.resting && v.resting.adds[r.n]), l = liq(r.avg, r.used, cq);
    items.push({ px: r.px, pr: 3, el: item(`a${i}`, ' ', 'todo', <>
      <Ln l={<><b>{label} {r.qty}@{fx(r.px)}</b><Pc a={r.px} /></>} r={<span className="up">{share((r.tp - r.avg) * cq)}</span>} />
      <Ln l={`${cq}@${fx(r.avg)}`} r={l === null ? '' : liqTxt(l)} /></>, addSt, restTip(addSt, v.resting && v.resting.adds[r.n])) });
  });
  items.sort((a, b) => b.px - a.px || a.pr - b.pr);
  return <>
    {!p && <p className="faint note" style={{ margin: '0 0 10px' }}>No open cycle. Plan if one opened now:</p>}
    <RestBar v={v} />
    <ol className="timeline">{items.map(i => i.el)}</ol>
  </>;
}

// ---------- history tab ----------
function HistoryPane({ v }) {
  const { S } = useData(), { open } = usePanels();
  const csv = <a className="btn small" href={`/api/bots/${v.bot.id}/trades.csv`} download>Download CSV</a>;
  const alerts = !v.alerts.length
    ? <div className="empty" style={{ padding: 24 }}>No alerts yet.{!S.telegram && <><br /><span className="faint">Telegram is not set up, so alerts only appear here.</span></>}</div>
    : <pre className="log">{v.alerts.slice().reverse().map((l, i) => {
      const k = (l.split(/\s+/)[2] || '');
      const cls = /^(OPEN|ADD|TP)$/.test(k) ? 'TRADE' : /^(ERROR|ALERTERR)$/.test(k) ? 'ERROR' : k === 'MISMATCH' ? 'WARN' : '';
      return <span key={i}>{i ? '\n' : ''}<span className={cls}>{l}</span></span>;
    })}</pre>;
  if (!v.history.length && !v.pos) return <><div className="empty" style={{ padding: 24 }}>No cycles yet.<br /><br />{csv}</div><h3 className="sec">Activity</h3>{alerts}</>;
  const total = v.history.reduce((s, h) => s + cycleNet(h), 0);
  const Row = ({ c, title, sub, pnl, cls }) => <li onClick={() => open('cycle', v.bot.id, { cycleId: c.id })} role="button" tabIndex={0}>
    <div><div className="t">{title}</div><div className="s">{sub}</div></div><div className={`r ${cls}`}>{pnl}</div><span className="go">›</span></li>;
  return <>
    <div className="row" style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4, fontSize: 13 }}>
      <span>{v.history.length} closed · <b className={dir(total)}>{money(total, 4)}</b> <span className="faint">USDT</span></span><span className="sp" />{csv}</div>
    <ul className="cyl">
      {v.pos && <Row c={v.pos} title={`#${v.pos.id} · Open`} sub={`${v.pos.orders.length} order${v.pos.orders.length > 1 ? 's' : ''} · since ${when(v.pos.openedAt)}`} pnl="--" cls="" />}
      {v.history.map(h => {
        const fees = txFees(cycleTx(h)), net = cycleNet(h);
        return <Row key={h.id} c={h} title={`#${h.id} · ${when(h.closedAt)}`} sub={`${h.orders.length} order${h.orders.length > 1 ? 's' : ''} · held ${heldFor(h.closedAt - h.openedAt)}`}
          pnl={<>{money(net, 4)}<div className="s">{fees === null ? '' : `fees ${feeFx(fees)}`}</div></>} cls={dir(net)} />;
      })}
    </ul>
    <h3 className="sec">Activity</h3>{alerts}
  </>;
}

// one cycle's transactions in a bottom sheet (like the exchange's 成交明细)
export function CycleBody({ v, cycleId }) {
  const open = v.pos && v.pos.id === cycleId, c = open ? v.pos : v.history.find(h => h.id === cycleId);
  if (!c) return null;
  const tx = cycleTx(c), fees = txFees(tx), coin = coinOf(v.bot.symbol);
  const invested = c.orders.reduce((s, o) => s + o.px * o.qty, 0), adds = c.orders.filter(o => !o.manual && o.n > 0).length;
  const pnl = open ? v.upnl : c.pnl, head = fees === null ? pnl : pnl - fees;
  const F = ({ l, children }) => <div><div className="l">{l}</div><div className="v">{children}</div></div>;
  return <>
    <div className="cy-sum">
      <div><div className="l faint">Cycle profit</div><div className={`big ${open ? '' : dir(head)}`}>{open ? '--' : `${money(head, 6)} USDT`}</div>
        <div className="faint" style={{ fontSize: 12 }}>Fees {fees === null ? '–' : feeFx(fees)} USDT</div></div>
      <div style={{ textAlign: 'right' }}><div className="l faint">Invested | adds</div><div className="big">{fx(invested, 4)} <span className="faint">|</span> {adds}</div>
        <div className="faint" style={{ fontSize: 12 }}>{open ? `since ${when(c.openedAt)}` : `held ${heldFor(c.closedAt - c.openedAt)}`}</div></div>
    </div>
    {tx.map((t, i) => <div key={i} className="tx">
      <F l="Direction"><span className={`side ${t.cls}`}>{t.side}</span>{t.orderType && <> <span className="chip">{t.orderType}</span></>}</F>
      <F l="Time">{new Date(t.ts).toLocaleString('sv-SE')}</F>
      <F l="Price">{fx(t.px)} USDT</F>
      <F l="Value">{fx(t.px * t.qty, 4)} USDT</F>
      <F l="Fee">{t.fee === null ? '–' : <>−{feeFx(t.fee)} USDT{t.feeEst && <> <span className="est">est.</span></>}</>}</F>
      <F l="Quantity">{t.qty} {coin}</F>
    </div>)}
    <p className="faint note">Fees marked est. use the standard rate; the others are what the exchange charged.</p>
  </>;
}

// ---------- page ----------
const PANES = { overview: OverviewPane, settings: ParamsPane, orders: OrdersPane, history: HistoryPane };
export default function DetailPage({ v, tab, slide }) {
  const { S } = useData(), { open, startStop } = usePanels(), pane = useRef(null), tabs = useRef(null);
  const Pane = PANES[tab] || OverviewPane;
  useEffect(() => { const on = tabs.current && tabs.current.querySelector('.tab.on'); if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [tab]);
  useSwipeTabs(pane, v.bot.id, tab);
  return <div id="bots" className={slide}>
    <section className="bd">
      <Head v={v} />
      <nav ref={tabs} id="dTabs" className="tabs bd-tabs">{TABS.map(([k, l]) =>
        // a tab is not a page: replace, so back leaves the bot instead of stepping through its tabs
        <a key={k} className={`tab ${tab === k ? 'on' : ''}`} href={`#/bot/${v.bot.id}/${k}`} onClick={e => { e.preventDefault(); location.replace(`#/bot/${v.bot.id}/${k}`); }}>
          {l}{k === 'history' && v.history.length ? ` (${v.history.length})` : ''}</a>)}</nav>
      <div ref={pane} id="dPane" className="pane"><Pane v={v} /></div>
    </section>
    <div className="actionbar">{S.editable && <>
      <button className="btn" onClick={() => open('manage', v.bot.id)}>More</button>
      {v.bot.closedAt ? null : v.enabled ? <button className="btn" onClick={() => open('when', v.bot.id, { what: 'stop' })}>Stop</button>
        : <button className="btn primary" onClick={() => startStop(v.bot.id, true)}>Start</button>}
    </>}</div>
  </div>;
}

// Swipe left / right on a bot page to move between the tabs. The content follows the finger; let go past a quarter of the
// width (or flick) and it slides off while the next tab slides in; otherwise it springs back. Past the ends it only stretches.
function useSwipeTabs(paneRef, id, tab) {
  const tabRef = useRef(tab); tabRef.current = tab;
  useEffect(() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const move = (el, x, ms) => { el.style.transition = ms ? `transform ${ms}ms ease-out, opacity ${ms}ms ease-out` : 'none'; el.style.transform = x ? `translateX(${x}px)` : ''; el.style.opacity = x ? String(1 - Math.min(Math.abs(x) / el.offsetWidth, 1) * 0.5) : ''; };
    let s = null;
    const start = e => {
      const t = e.touches[0];
      s = !e.target.closest('.tablewrap, .chart, input, select, textarea, .sheet, .drawer, dialog, #dTabs')
        ? { x: t.clientX, y: t.clientY, at: Date.now(), axis: null, dx: 0, i: TABS.findIndex(([k]) => k === tabRef.current) } : null;
    };
    const mv = e => {
      if (!s) return;
      const t = e.touches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (!s.axis) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; s.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'; }
      if (s.axis !== 'x') return;
      const next = s.i + (dx < 0 ? 1 : -1);
      s.dx = next < 0 || next >= TABS.length ? dx * 0.25 : dx;
      if (paneRef.current) move(paneRef.current, s.dx, 0);
    };
    const end = () => {
      const g = s; s = null;
      const pane = paneRef.current;
      if (!g || g.axis !== 'x' || !pane) return;
      const w = pane.offsetWidth, j = g.i + (g.dx < 0 ? 1 : -1), flick = Math.abs(g.dx) > 40 && Math.abs(g.dx) / (Date.now() - g.at) > 0.5;
      if (j < 0 || j >= TABS.length || !(Math.abs(g.dx) > w / 4 || flick)) return move(pane, 0, 200);
      const d = g.dx < 0 ? -1 : 1, swap = () => {
        location.replace(`#/bot/${id}/${TABS[j][0]}`);
        requestAnimationFrame(() => { move(pane, -d * w * 0.6, 0); void pane.offsetWidth; move(pane, 0, reduce ? 0 : 220); });
      };
      if (reduce) return swap();
      move(pane, d * w, 160); setTimeout(swap, 160);
    };
    const cancel = () => { if (s && s.axis === 'x' && paneRef.current) move(paneRef.current, 0, 200); s = null; };
    const o = { passive: true };
    document.addEventListener('touchstart', start, o); document.addEventListener('touchmove', mv, o);
    document.addEventListener('touchend', end, o); document.addEventListener('touchcancel', cancel, o);
    return () => { document.removeEventListener('touchstart', start); document.removeEventListener('touchmove', mv); document.removeEventListener('touchend', end); document.removeEventListener('touchcancel', cancel); };
  }, [paneRef, id]);
}
