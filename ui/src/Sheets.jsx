// The bot's management actions as bottom sheets, like the exchange apps: "More" lists them, each opens its own sheet.
import { useEffect, useRef, useState } from 'react';
import { useData, useUi, usePanels, post, del, getJSON } from './core.jsx';
import { fx, money, coinOf } from './lib/format.js';
import { floorStep } from '../../dca.mjs';

const Head = ({ b }) => <div className="mo-bot"><b>{b.name}</b></div>;
const Kv = ({ label, value, sub }) => <div className="kv"><div className="l">{label}</div><div className="v">{value}</div>{sub ? <div className="s">{sub}</div> : null}</div>;
// focus the first field once the sheet has slid up
const useFocus = () => { const r = useRef(null); useEffect(() => { const t = setTimeout(() => r.current && r.current.focus(), 220); return () => clearTimeout(t); }, []); return r; };
// a save button: disabled while sending, the error shown under the form
function useSend() {
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const send = async fn => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); setBusy(false); } };
  return { busy, err, setErr, send };
}

// ---------- "More" ----------
export function ManageBody({ v }) {
  const { open, close, startStop } = usePanels(), { ask, toast } = useUi(), { load } = useData(), b = v.bot, id = b.id;
  const closed = !!b.closedAt, isClosed = closed ? 'This bot is closed' : '', canDelete = !v.enabled && !v.pos;
  const remove = async () => {
    if (!await ask('Delete bot?', 'It is removed from the list. Its trade history is kept on the computer.', 'Delete')) return;
    try { await del(`/api/bots/${id}`); toast(`Deleted ${id}`); location.hash = '#/'; } catch (e) { toast(e.message, true); }
    load();
  };
  const Act = ({ icon, label, run, disabled = '' }) => <button className="sheet-act" disabled={!!disabled} title={disabled || undefined} onClick={() => { close(); run(); }}>
    <span className="ic">{icon}</span><span className="lbl">{label}</span>{disabled && <small className="why">{disabled}</small>}</button>;
  return <div className="sheet-grid">
    {b.fillMode === 'manual' && <Act icon="✔" label="Enter fill" run={() => open('fill', id)} disabled={isClosed} />}
    <Act icon="✎" label="Edit indicator" run={() => open('form', id, { formKind: 'bot' })} disabled={isClosed} />
    <Act icon="◎" label="Take profit" run={() => open('tp', id)} disabled={isClosed} />
    <Act icon="⊕" label="Max add orders" run={() => open('max', id)} disabled={isClosed || (+b.maxAdds >= 20 ? 'Already at the maximum of 20' : '')} />
    <Act icon="↻" label="Max cycles" run={() => open('cycles', id)} disabled={isClosed} />
    <Act icon="⊞" label="Add funds" run={() => open('funds', id)} disabled={isClosed} />
    <Act icon="＋" label="Manual order" run={() => open('manual', id)} disabled={isClosed || (b.dryRun ? '' : 'A live bot records real Bitget fills only')} />
    {!closed && (v.enabled ? <Act icon="■" label="Stop bot" run={() => open('when', id, { what: 'stop' })} /> : <Act icon="▶" label="Start bot" run={() => startStop(id, true)} />)}
    <Act icon="⊗" label="Close bot" run={() => open('when', id, { what: 'close' })} disabled={isClosed || (v.running ? '' : 'Start the bot first')} />
    <Act icon="⤓" label="Download trades" run={() => { location.href = `/api/bots/${id}/trades.csv`; }} />
    <Act icon="✕" label="Delete bot" run={remove} disabled={canDelete ? '' : v.enabled ? 'Stop the bot first' : 'Wait until the open cycle closes'} />
  </div>;
}

// ---------- manual order: margin + price, the quantity follows. Manual orders are on top of the investment. ----------
export function ManualBody({ v }) {
  const { close } = usePanels(), { toast } = useUi(), b = v.bot, lev = +b.leverage, c = v.contract, coin = coinOf(b.symbol), first = useFocus();
  const [m, setM] = useState(''), [px, setPx] = useState(v.price || ''), { busy, err, send } = useSend();
  const minMargin = c && v.price ? Math.max(c.minQty * v.price, c.minValue) / lev : 0;
  const q = +m > 0 && +px > 0 ? (c ? floorStep(+m * lev / +px, c.step, c.qdp) : +m * lev / +px) : 0;
  const small = c && q > 0 && (q < c.minQty || q * +px < c.minValue);
  return <>
    <div className="mo-bot"><b>{b.name}</b>
      <div className="tags"><span className="tag">Martingale</span><span className="tag long">Long</span><span className="tag">{lev}x</span><span className="tag">{v.pos ? `cycle #${v.pos.id}` : 'new cycle'}</span></div></div>
    <label className="l" htmlFor="mo-m">Amount (margin)</label>
    <div className="mo-input"><input ref={first} id="mo-m" type="number" inputMode="decimal" step="any" min="0" placeholder={minMargin ? `≥ ${fx(minMargin, 2)}` : '0'} value={m} onChange={e => setM(e.target.value)} />
      <div className="mo-unit">USDT<small>≈ {q} {coin}</small></div></div>
    <label className="l" htmlFor="mo-px" style={{ marginTop: 12 }}>Price</label>
    <div className="mo-input"><input id="mo-px" type="number" inputMode="decimal" step="any" min="0" value={px} onChange={e => setPx(e.target.value)} /><div className="mo-unit">USDT</div></div>
    <p className="hint" style={{ margin: '10px 0 0' }}>{v.pos ? `Added to cycle #${v.pos.id}.` : 'Starts a new cycle with this as the first order.'} Manual orders are on top of the {fx(b.investment, 0)} USDT investment.</p>
    <p className="err">{small ? `Below the exchange minimum (${c.minQty} ${coin} / ${c.minValue} USDT).` : err}</p>
    <button className="btn primary mo-ok" disabled={!(q > 0) || small || busy}
      onClick={() => send(async () => { await post(`/api/bots/${b.id}/manual`, { px, qty: q }); close(); toast('Order added. It shows up after the next check.'); })}>Confirm</button>
  </>;
}

// ---------- the real fill from the exchange (bots that run "by hand") ----------
export function FillBody({ v }) {
  const { close } = usePanels(), { toast } = useUi(), b = v.bot, coin = coinOf(b.symbol), first = useFocus();
  const next = v.pos ? `add ${v.pos.orders.filter(o => !o.manual).length}` : 'the first order';
  const [side, setSide] = useState('buy'), [px, setPx] = useState(''), [qty, setQty] = useState(''), { busy, err, send } = useSend();
  return <>
    <Head b={b} />
    <div className="seg"><button type="button" className={side === 'buy' ? 'on' : ''} onClick={() => setSide('buy')}>Buy · {next}</button><button type="button" className={side === 'sell' ? 'on' : ''} onClick={() => setSide('sell')}>Sell</button></div>
    <label className="l" htmlFor="fl-px" style={{ marginTop: 12 }}>Fill price</label>
    <div className="mo-input"><input ref={first} id="fl-px" type="number" inputMode="decimal" step="any" min="0" value={px} onChange={e => setPx(e.target.value)} /><div className="mo-unit">USDT</div></div>
    <label className="l" htmlFor="fl-q" style={{ marginTop: 12 }}>Size</label>
    <div className="mo-input"><input id="fl-q" type="number" inputMode="decimal" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)} /><div className="mo-unit">{coin}</div></div>
    <p className="hint" style={{ margin: '10px 0 0' }}>Copy both from the order on Bitget. The next add price and the take profit are worked out from them.</p>
    <p className="err">{err}</p>
    <button className="btn primary mo-ok" disabled={busy} onClick={() => send(async () => { await post(`/api/bots/${b.id}/manual`, { fill: true, side, px, qty }); close(); toast('Fill saved. It shows up after the next check.'); })}>Confirm</button>
  </>;
}

// ---------- one number, saved on the bot: max cycles, take profit ----------
export function CyclesBody({ v }) {
  const { close } = usePanels(), { toast } = useUi(), { load } = useData(), b = v.bot, cur = +b.maxCycles || 0, first = useFocus();
  const [val, setVal] = useState(String(cur)), { busy, err, send } = useSend();
  const x = val === '' ? NaN : +val, ok = Number.isInteger(x) && x >= 0 && x <= 1000 && (cur === 0 || x === 0 || x > cur);
  return <>
    <Head b={b} />
    <label className="l" htmlFor="cy-v">Stop opening new cycles after</label>
    <div className="mo-input"><input ref={first} id="cy-v" type="number" inputMode="numeric" step="1" min="0" max="1000" value={val} onChange={e => setVal(e.target.value)} /><div className="mo-unit">cycles</div></div>
    <p className="hint" style={{ margin: '10px 0 0' }}>{cur ? `Now ${cur}: it can only go up (or 0 for no limit). ` : 'Now no limit. '}0 = no limit. Applies on the next check.</p>
    <p className="err">{err}</p>
    <button className="btn primary mo-ok" disabled={!ok || x === cur || busy} onClick={() => send(async () => { await post(`/api/bots/${b.id}/cycles`, { maxCycles: val }); close(); toast('Max cycles saved'); load(); })}>Save</button>
  </>;
}
export function TpBody({ v }) {
  const { close } = usePanels(), { toast } = useUi(), { load } = useData(), b = v.bot, p = v.pos, first = useFocus();
  const [val, setVal] = useState(String(b.tpPct)), { busy, err, send } = useSend();
  const x = +val, ok = x >= 0.01 && x <= 100;
  return <>
    <Head b={b} />
    <label className="l" htmlFor="tp-v">Take profit above the average price</label>
    <div className="mo-input"><input ref={first} id="tp-v" type="number" inputMode="decimal" step="any" min="0.01" max="100" value={val} onChange={e => setVal(e.target.value)} /><div className="mo-unit">%</div></div>
    <p className="hint" style={{ margin: '10px 0 0' }}>{ok && p ? `Take profit price ${fx(p.avg * (1 + x / 100))} (now ${fx(p.tp)}). ` : ''}Applies on the next check.</p>
    <p className="err">{err}</p>
    <button className="btn primary mo-ok" disabled={!ok || x === +b.tpPct || busy} onClick={() => send(async () => { await post(`/api/bots/${b.id}/tp`, { tpPct: val }); close(); toast('Take profit saved'); load(); })}>Save</button>
  </>;
}

// ---------- max add orders: can only go up; the investment grows by what the new orders need ----------
export function MaxBody({ v }) {
  const { close } = usePanels(), { toast } = useUi(), { load } = useData(), b = v.bot, cur = +b.maxAdds, first = useFocus();
  const [val, setVal] = useState(String(Math.min(20, cur + 1))), [quote, setQuote] = useState(null), { busy, err, setErr, send } = useSend();
  const n = +val, valid = Number.isInteger(n) && n > cur && n <= 20;
  useEffect(() => {
    setQuote(null);
    if (!valid) { setErr(n > 0 ? `Choose ${cur + 1} to 20.` : ''); return; }
    let live = true;
    const t = setTimeout(async () => {
      try { const j = await getJSON(`/api/bots/${b.id}/maxadds?to=${n}`); if (!live) return; if (j.error) setErr(j.error); else { setErr(''); setQuote(j); } }
      catch (e) { if (live) setErr(e.message); }
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [val]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <Head b={b} />
    <label className="l" htmlFor="mx-v">Max add orders <span className="faint" style={{ fontWeight: 400 }}>(now {cur}, can only increase, up to 20)</span></label>
    <div className="mo-input"><input ref={first} id="mx-v" type="number" inputMode="numeric" step="1" min={cur + 1} max="20" value={val} onChange={e => setVal(e.target.value)} /><div className="mo-unit">orders</div></div>
    <div className="kvgrid compact" style={{ marginTop: 14 }}>
      <Kv label="Extra investment" value={<>{quote ? fx(quote.extra, 2) : '–'} <small>USDT</small></>} />
      <Kv label="New investment" value={<>{quote ? fx(quote.investmentAfter, 2) : '–'} <small>USDT</small></>} sub={`now ${fx(b.investment, 2)}`} /></div>
    <p className="hint" style={{ margin: '10px 0 0' }}>Orders already planned keep their size. The extra money only pays for the new orders.</p>
    <p className="err">{err}</p>
    <button className="btn primary mo-ok" disabled={!quote || busy} onClick={() => send(async () => {
      const j = await post(`/api/bots/${b.id}/maxadds`, { maxAdds: val }); close(); toast(`Max add orders ${j.current} → ${j.to}; investment ${fx(j.investmentAfter, 2)} USDT`); load();
    })}>{quote ? `Add ${n - cur} order${n - cur > 1 ? 's' : ''} for ${fx(quote.extra, 2)} USDT` : 'Add orders'}</button>
  </>;
}

// ---------- add funds: raise the investment (the orders still to place get bigger) ----------
export function FundsBody({ v }) {
  const { close } = usePanels(), { toast } = useUi(), { load } = useData(), b = v.bot, sg = v.short, first = useFocus();
  const [val, setVal] = useState(sg ? String(sg.topUp) : ''), { busy, err, send } = useSend(), x = +val;
  return <>
    <Head b={b} />
    <label className="l" htmlFor="fd-v">Add to the investment</label>
    <div className="mo-input"><input ref={first} id="fd-v" type="number" inputMode="decimal" step="any" min="0" placeholder="0" value={val} onChange={e => setVal(e.target.value)} /><div className="mo-unit">USDT</div></div>
    <div className="kvgrid compact" style={{ marginTop: 14 }}><Kv label="New investment" value={<>{x > 0 ? fx(+b.investment + x, 2) : '–'} <small>USDT</small></>} sub={`now ${fx(b.investment, 2)}`} /></div>
    <p className="hint" style={{ margin: '10px 0 0' }}>{sg ? `Order #${sg.n} needs at least ${fx(sg.need)} USDT margin; ${fx(sg.topUp)} USDT covers it. ` : ''}The orders still to place get bigger; orders already filled stay as they are.</p>
    <p className="err">{err}</p>
    <button className="btn primary mo-ok" disabled={!(x > 0) || busy} onClick={() => send(async () => { const j = await post(`/api/bots/${b.id}/invest`, { add: val }); close(); toast(`Investment is now ${fx(j.investment, 2)} USDT`); load(); })}>Add funds</button>
  </>;
}

// ---------- stop or close the bot: now, or when the price reaches a level ----------
// close: sell at market (now or at a price), sell with one limit order (the bot ends when it fills), or keep the position
export function WhenBody({ v, kind }) {
  const { close: closeSheet } = usePanels(), { toast, ask } = useUi(), { load } = useData();
  const b = v.bot, p = v.pos, px = v.price, isClose = kind === 'close', sym = coinOf(b.symbol), pxRef = useRef(null);
  const [at, setAt] = useState(false), [how, setHow] = useState('market'), [val, setVal] = useState(px ? String(px) : ''), { busy, err, send } = useSend();
  const lim = how === 'limit', hold = how === 'hold', usePx = lim || (at && !hold), x = usePx ? +val : px;
  const pick = (fn, select) => { fn(); if (select) setTimeout(() => pxRef.current && pxRef.current.select(), 50); };
  const lines = [];
  if (at && how === 'market') lines.push(x > 0 && px ? `Runs when the price ${x > px ? 'rises to' : 'falls to'} ${fx(x)}, checked every ${v.checkTf}.` : 'Enter a price.');
  if (isClose && p) {
    const pnl = !hold && x > 0 ? (x - p.avg) * p.qty : null;
    lines.push(hold ? `Keeps ${p.qty} ${sym} (average ${fx(p.avg)}) on Bitget.` : `Sells ${p.qty} ${sym} (average ${fx(p.avg)})${pnl !== null ? `; about ${money(pnl)} USDT at ${fx(x)}` : ''}.`);
    if (lim && x > 0 && px && x < px) lines.push(`That is below the market price (${fx(px)}): it sells right away, like a market order.`);
  } else if (isClose) lines.push('No open position: the bot just ends.');
  const go = () => send(async () => {
    const price = hold ? null : lim || at ? val : null;
    if (isClose && !await ask('Close this bot?', hold ? `It cancels all its orders and ends for good.${p ? ` Your ${p.qty} ${sym} stay open on Bitget, no longer managed.` : ''}`
      : `${p ? `It sells ${p.qty} ${sym} ${lim ? `with a limit order at ${fx(+price)}` : at ? `at market when the price reaches ${fx(+price)}` : 'now at market'} and ` : ''}the bot ends for good.`, 'Close bot')) throw new Error('');
    await post(`/api/bots/${b.id}/action`, { action: kind, ...(isClose ? { how } : {}), px: price });
    closeSheet();
    toast(!isClose ? (at ? `Stop set at ${fx(+price)}` : 'Stopped') : hold ? 'Closing the bot, keeping the position…' : lim ? `Placing the limit sell at ${fx(+price)}…` : at ? `Close set at ${fx(+price)}` : 'Closing the bot…');
    load();
  });
  return <>
    <Head b={b} />
    {isClose && <><label className="l">The position</label>
      <div className="seg2">{[['market', 'Sell at market'], ['limit', 'Sell at limit'], ['hold', 'Keep it']].map(([h, l]) =>
        <button key={h} type="button" className={how === h ? 'on' : ''} onClick={() => pick(() => { setHow(h); setAt(false); }, h === 'limit')}>{l}</button>)}</div></>}
    <p className="hint" style={{ margin: '0 0 12px' }}>{!isClose ? 'Stops the bot. An open cycle stays as it is, and you can start the bot again.'
      : hold ? 'Ends this bot for good and cancels all its orders. The position stays open on Bitget and is no longer managed.'
      : lim ? 'Cancels the buys and the take profit, then places one limit sell (maker) for the whole position. The bot ends when it fills; until then you can cancel.'
      : 'Sells the whole position at market (taker) and ends this bot for good.'}</p>
    {!(isClose && how !== 'market') && <div className="seg2"><button type="button" className={!at ? 'on' : ''} onClick={() => setAt(false)}>Now</button>
      <button type="button" className={at ? 'on' : ''} onClick={() => pick(() => setAt(true), true)}>At price</button></div>}
    {usePx && <div><label className="l" htmlFor="w-px">{lim ? 'Limit price' : 'Price'}</label>
      <div className="mo-input"><input ref={pxRef} id="w-px" type="number" inputMode="decimal" step="any" min="0" value={val} onChange={e => setVal(e.target.value)} /><div className="mo-unit">USDT</div></div></div>}
    <p className="hint" style={{ margin: '10px 0 0' }}>{lines.join(' ')}</p>
    <p className="err">{err}</p>
    <button className={`btn mo-ok ${isClose ? 'danger' : 'primary'}`} disabled={(usePx && !(x > 0)) || busy} onClick={go}>{isClose ? 'Close bot' : 'Stop bot'}</button>
  </>;
}
