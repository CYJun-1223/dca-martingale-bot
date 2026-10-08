// The drawer that creates / edits a bot or an alert-only watch.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useData, useUi, usePanels, post, del, getJSON, Sheet, go } from './core.jsx';
import { fx } from './lib/format.js';
import { TFS, TF_MIN, IND_DEFAULT, indOf, entryOf, sigShort, sigSentence, volText } from './lib/entry.js';
import { mgOf, tooSmall } from './lib/cycle.js';
import { planRows, firstMargin, qtyFactor, minInvestment } from '../../dca.mjs';

const STRAT_KEYS = ['investment', 'leverage', 'maxAdds', 'stepPct', 'stepMult', 'amountMult', 'tpPct', 'maxCycles'];
const SYM = /^[A-Z0-9]+USDT$/;
const clone = x => JSON.parse(JSON.stringify(x));
const s2 = v => v === undefined || v === null ? '' : String(v);

// ---------- orders table (the preview) ----------
export function OrdersTable({ rows, inv, c, cap = inv }) {
  const R = { textAlign: 'right' };
  return <div className="tablewrap"><table className="hist num orders"><tbody>
    <tr><th>Order</th><th>Price</th><th className="opt">Drop</th><th style={R}>Qty</th><th style={R} className="opt">Value</th><th style={R}>Margin</th><th style={R}>Used</th><th style={R} className="opt">Avg</th><th style={R}>TP</th></tr>
    {rows.map((r, i) => {
      const small = tooSmall(r, c);
      return <tr key={i} className={r.filled ? '' : 'faint'}>
        <td>{r.manual ? 'Manual' : r.n ? `Add ${r.n}` : 'First'}{r.filled ? ' ✓' : ''}</td>
        <td>{r.filled ? '' : '≤ '}{fx(r.px)}{r.n ? <div className="faint only-phone" style={{ fontSize: 11 }}>−{fx(r.drop, 1)}%</div> : null}</td>
        <td className="opt">{r.n ? `−${fx(r.drop, 1)}%` : '–'}</td>
        <td style={R} className={small ? 'down' : ''} title={small ? `below the exchange minimum (${c.minQty} / ${c.minValue} USDT)` : undefined}>{r.qty}{small ? ' ⚠' : ''}</td>
        <td style={R} className="opt">{fx(r.qty * r.px)}</td>
        <td style={R}>{fx(r.m)}<div className="faint" style={{ fontSize: 11 }}>{fx(r.m / inv * 100, 1)}%</div></td>
        <td style={R} className={r.used > cap + 0.01 ? 'down' : ''}>{fx(r.used)}</td><td style={R} className="opt">{fx(r.avg)}</td><td style={R}>{fx(r.tp)}</td></tr>;
    })}</tbody></table></div>;
}

// ---------- one condition ----------
function Cond({ s, set, def, onRemove }) {
  const num = (k, label, extra = {}) => <div className="field"><label className="l">{label}</label><input type="number" required value={s2(s[k])} onChange={e => set({ ...s, [k]: e.target.value })} {...extra} /></div>;
  const fields = s.type === 'ma-cross' ? <>{num('fast', 'Fast', { step: 1, min: 1 })}{num('slow', 'Slow', { step: 1, min: 2 })}
    <div className="field"><label className="l">Type</label><select value={s.ma} onChange={e => set({ ...s, ma: e.target.value })}><option value="sma">SMA</option><option value="ema">EMA</option></select></div></>
    : s.type === 'macd-cross' ? <>{num('fast', 'Fast', { step: 1, min: 1 })}{num('slow', 'Slow', { step: 1, min: 2 })}{num('signal', 'Sig', { step: 1, min: 1 })}</>
    : s.type === 'rsi-cross' ? <>{num('period', 'K', { step: 1, min: 2 })}{num('level', 'Buy threshold', { step: 'any', min: 1, max: 99 })}</>
    : <>{num('period', 'K', { step: 1, min: 2 })}{num('mult', 'N', { step: 0.1, min: 0.1 })}
      <div className="field"><label className="l">Signal</label><select value={s.type} onChange={e => set({ ...s, type: e.target.value })}><option value="boll-revert">Below lower band</option><option value="boll-break">Above upper band</option></select></div></>;
  const v = s.volatility || {}, ownTf = s.tf && s.tf !== def, ownVol = !!volText(v);
  const setVol = (k, val) => set({ ...s, volatility: { ...v, [k]: val } }); // empty limits are dropped by the server
  return <div className={`cond ind-${indOf(s.type)}`}>
    <div className="cond-head">
      <div className="seg ind" role="radiogroup" aria-label="Indicator">{['ma', 'boll', 'macd', 'rsi'].map(k =>
        <label key={k}><input type="radio" checked={indOf(s.type) === k} onChange={() => set({ ...IND_DEFAULT[k] })} />{k.toUpperCase()}</label>)}</div>
      {onRemove && <button type="button" className="x" onClick={onRemove} aria-label="Remove condition">×</button>}</div>
    <div className="fgrid three">{fields}</div>
    {/* the closed line shows what is set, so there is no need to open it; overridden values are highlighted */}
    <details className="cadv"><summary>Advanced <span className="adv-val"><span className={ownTf ? 'on' : ''}>K-line {ownTf ? s.tf : def}{ownTf ? '' : ' (default)'}</span> · <span className={ownVol ? 'on' : ''}>{ownVol ? volText(v) : 'volatility off'}</span></span></summary>
      <div className="fgrid">
        <div className="field full"><label className="l">K-line</label><select value={s.tf || ''} onChange={e => { const c = { ...s }; if (e.target.value) c.tf = e.target.value; else delete c.tf; set(c); }}>
          <option value="">Default ({def})</option>{TFS.map(x => <option key={x}>{x}</option>)}</select></div>
        <div className="field full"><label className="l">Volatility filter <span className="faint" style={{ fontWeight: 400 }}>ATR as % of price · empty = off</span></label>
          <div className="volrow">
            <div className="unit"><input type="number" step="any" min="0" placeholder="Min" value={s2(v.minPct)} onChange={e => setVol('minPct', e.target.value)} /><span>%</span></div>
            <div className="unit"><input type="number" step="any" min="0" placeholder="Max" value={s2(v.maxPct)} onChange={e => setVol('maxPct', e.target.value)} /><span>%</span></div>
            <div className="unit"><input type="number" step="1" min="2" placeholder="14" value={s2(v.period)} onChange={e => setVol('period', e.target.value)} /><span>ATR</span></div>
          </div></div>
      </div></details>
  </div>;
}
// the chip between two conditions / groups is the AND / OR; tap it to switch
const Chip = ({ logic, onClick, small }) => <div className={`joiner ${small ? 'small' : ''}`}><button type="button" className={`logic ${logic}`} onClick={onClick} title="Tap to switch AND / OR">{logic === 'and' ? 'AND' : 'OR'}</button></div>;

// ---------- the form ----------
export default function FormBody({ id, kind }) {
  const { S, load, setStrategies } = useData(), { toast, ask } = useUi(), { close } = usePanels();
  const isAlert = kind === 'alert';
  const v = id ? (isAlert ? S.watches.find(x => x.watch.id === id) : S.bots.find(x => x.bot.id === id)) : null;
  const editing = v ? id : null, live0 = !isAlert && v && !v.bot.dryRun;
  const brokerLabel = k => (S.brokers && S.brokers[k] || {}).label || k;

  // ---- initial values: the bot / alert being edited, else (a new alert) the first bot's indicators, else the defaults ----
  const init = useMemo(() => {
    const d = v ? (isAlert ? v.watch : v.bot) : isAlert && S.bots.length ? S.bots[0].bot : S.defaults || {};
    const e = entryOf(d);
    let groups = e.groups.map(g => ({ logic: g.logic, signals: g.signals.map(s => ({ ...s, ...(e.volatility && !s.volatility ? { volatility: { ...e.volatility } } : {}) })) }));
    if (!groups.length) groups = [{ logic: 'or', signals: [{ ...IND_DEFAULT.boll }] }]; // a limit / market bot has no conditions yet
    if (isAlert) groups = [{ logic: 'or', signals: groups.flatMap(g => g.signals).slice(0, 5) }]; // one flat list: any can fire
    const f = { name: v ? d.name : '', broker: d.broker || 'bitget', symbol: v || isAlert ? s2(d.symbol) : '', tf: d.tf || '1H', logic: e.logic, window: s2(e.window || 3),
      usMarketHoursOnly: !!d.usMarketHoursOnly, entryMode: isAlert ? 'indicator' : e.mode || 'indicator', limitPx: s2(e.limitPx),
      fillMode: d.dryRun === false ? 'live' : v ? d.fillMode || 'auto' : 'manual', marginMode: (v && d.marginMode) || 'crossed' };
    for (const k of STRAT_KEYS) f[k] = s2(d[k]);
    f.maxCycles = s2(d.maxCycles || 0);
    return { f, groups, strat: null };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState(init.f);
  const [groups, setGroups] = useState(init.groups);
  const [stratId, setStratId] = useState('');
  const [part, setPart] = useState(isAlert ? null : 'entry');
  const [identEdit, setIdentEdit] = useState(false);
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [pv, setPv] = useState(false);
  const [px, setPx] = useState({ price: v ? v.price : null, contract: null });
  const [trackPref, setTrackPref] = useState(true), [limitNow, setLimitNow] = useState('');
  const [ck, setCk] = useState({ cls: 'hint', text: 'Checks the symbol exists on the broker and allows your leverage.', busy: false });
  const formRef = useRef(null), limitRef = useRef(null);
  const set = patch => setF(x => ({ ...x, ...patch }));

  // ---- strategies: picking one fills the form so only the symbol and name are left to set ----
  const strategies = S.strategies || [];
  const entryParams = () => f.entryMode !== 'indicator' ? { mode: f.entryMode }
    : { logic: f.logic, window: +f.window || 3, groups: groups.map(g => ({ ...g, signals: g.signals.map(s => { const c = { ...s }; if (c.tf === f.tf) delete c.tf; return c; }) })) };
  const applyStrategy = sid => {
    const s = strategies.find(x => x.id === sid); setStratId(sid);
    if (!s) return;
    localStorage.setItem('strategy', sid);
    const p = s.params, patch = {};
    for (const k of STRAT_KEYS) patch[k] = s2(p[k]); // a number it leaves out is left blank (so a default can't sneak in)
    if (p.symbol) patch.symbol = p.symbol;
    if (p.fillMode && !editing) patch.fillMode = p.fillMode;
    if (p.tf) patch.tf = p.tf;
    if (p.marginMode) patch.marginMode = p.marginMode;
    if (p.entry) {
      patch.entryMode = p.entry.mode || 'indicator';
      if (p.entry.mode === 'maker') setTrackPref(true); // a limit price always starts following the market
      if (p.entry.groups) { setGroups(clone(p.entry.groups)); patch.logic = p.entry.logic || 'or'; patch.window = s2(p.entry.window || 3); }
    }
    set(patch);
  };
  useEffect(() => { // a new bot starts from the last strategy used
    if (v || isAlert) return;
    const sel = strategies.find(x => x.id === localStorage.getItem('strategy')) || strategies[0];
    if (sel) applyStrategy(sel.id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // editing a value turns the strategy back into "Custom"
  const cs = strategies.find(x => x.id === stratId);
  const same = (a, b) => a === '' || b === '' ? a === b : +a === +b;
  const stratShown = cs && !(STRAT_KEYS.some(k => !same(f[k], s2(cs.params[k]))) || (cs.params.symbol && f.symbol.trim().toUpperCase() !== cs.params.symbol)
    || (cs.params.fillMode && f.fillMode !== cs.params.fillMode) || (cs.params.tf && f.tf !== cs.params.tf) || (cs.params.marginMode && f.marginMode !== cs.params.marginMode)
    || (cs.params.entry && JSON.stringify({ ...cs.params.entry, track: undefined }) !== JSON.stringify({ ...entryParams(), track: undefined }))) ? stratId : '';
  const saveStrategy = async () => {
    const name = prompt('Strategy name (the same name replaces it)', cs ? cs.name : '');
    if (!name || !name.trim()) return;
    try {
      const j = await post('/api/strategies', { name, params: { ...Object.fromEntries(STRAT_KEYS.map(k => [k, f[k]])), symbol: f.symbol, fillMode: f.fillMode, tf: f.tf, marginMode: f.marginMode, entry: entryParams() } });
      setStrategies(j.strategies); setStratId(j.id); localStorage.setItem('strategy', j.id); toast('Strategy saved');
    } catch (e) { toast(e.message, true); }
  };
  const deleteStrategy = async () => {
    if (!stratShown || !await ask('Delete this strategy?', 'Bots already created from it are not affected.', 'Delete')) return;
    try { const j = await del(`/api/strategies/${stratShown}`); setStrategies(j.strategies); setStratId(''); toast('Strategy deleted'); } catch (e) { toast(e.message, true); }
  };

  // ---- the price and contract of the symbol (debounced): preview, minimum investment, limit price ----
  const sym = f.symbol.trim().toUpperCase();
  useEffect(() => {
    if (!SYM.test(sym)) { setPx(p => ({ ...p, price: v ? p.price : null })); return; }
    const t = setTimeout(async () => {
      try { const j = await getJSON(`/api/price/${sym}?broker=${f.broker}`); setPx({ price: j.price, contract: j.contract }); } catch { setPx({ price: null, contract: null }); }
    }, 300);
    return () => clearTimeout(t);
  }, [sym, f.broker]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the limit price follows the market (refreshed every 5 s) until you type one or press the target ----
  const tracking = !isAlert && f.entryMode === 'maker' && trackPref;
  const readPx = async () => {
    if (!SYM.test(sym)) throw new Error('Enter the symbol first.');
    const j = await getJSON(`/api/price/${sym}?broker=${f.broker}`);
    if (!(j.price > 0)) throw new Error('Could not read the price.');
    set({ limitPx: String(j.price) }); setPx(p => ({ ...p, price: j.price }));
    setLimitNow(`Following the market price, updated ${new Date().toLocaleTimeString('sv-SE')}. The price when you press Create / Save becomes the limit price.`);
    return j.price;
  };
  useEffect(() => {
    if (!tracking) { setLimitNow(''); return; }
    const run = () => readPx().catch(e => { if (/symbol/.test(e.message)) setTrackPref(false); setLimitNow(e.message); });
    run(); const t = setInterval(run, 5000);
    return () => clearInterval(t);
  }, [tracking, sym, f.broker]); // eslint-disable-line react-hooks/exhaustive-deps
  // an empty limit price is filled with the market price, but never while you are typing in it
  const refill = () => { if (f.entryMode === 'maker' && !f.limitPx && px.price && document.activeElement !== limitRef.current) set({ limitPx: String(px.price) }); };
  useEffect(refill, [f.entryMode, px.price]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- name / id: follow the settings until you type your own ----
  const autoName = () => {
    const base = sym.replace(/USDT$/, '') || '?', j = l => l === 'and' ? ' + ' : ' / ';
    const gs = groups.map(g => g.signals.map(sigShort).join(j(g.logic))), ind = gs.length === 1 ? gs[0] : gs.map(g => `(${g})`).join(j(f.logic));
    const how = f.entryMode === 'maker' ? `Limit ${f.limitPx || '?'}` : f.entryMode === 'taker' ? 'Market' : null, run = !isAlert && f.fillMode === 'live' ? ' · LIVE' : '';
    return how ? `${base} · ${brokerLabel(f.broker)} · ${how}${run}` : `${base} · ${brokerLabel(f.broker)} · ${ind} · ${f.tf}${run}`;
  };
  const autoId = () => {
    const ind = [...new Set(groups.flatMap(g => g.signals).map(s => ({ 'ma-cross': s.ma, 'macd-cross': 'macd', 'rsi-cross': 'rsi', 'boll-break': 'bollbreak' })[s.type] || 'boll'))].join('-');
    const base = `${f.symbol.replace(/USDT$/i, '')}-${f.broker}-${f.entryMode === 'maker' ? 'limit' : f.entryMode === 'taker' ? 'market' : `${ind}-${f.tf}`}${!isAlert && f.fillMode === 'live' ? '-live' : ''}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 28);
    const taken = new Set(isAlert ? S.watches.map(x => x.watch.id) : S.bots.map(x => x.bot.id));
    let n = 2, out = base;
    while (taken.has(out)) out = `${base}-${n++}`;
    return out;
  };
  const [identAuto, setIdentAuto] = useState(!v);
  useEffect(() => { if (v) setIdentAuto(init.f.name === autoName()); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const name = identAuto ? autoName() : f.name;

  // ---- what the form says ----
  const andUsed = (f.logic === 'and' && groups.length > 1) || groups.some(g => g.logic === 'and' && g.signals.length > 1);
  const j = l => l === 'and' ? ' AND ' : ' OR ';
  const tfOf = s => s.tf || f.tf, shortest = list => list.map(tfOf).reduce((m, x) => TF_MIN[x] < TF_MIN[m] ? x : m);
  const all = groups.flatMap(g => g.signals);
  const trigger = isAlert && groups[0].signals.length > 1
    ? `Sends you a Telegram message whenever any of these happens: ${groups[0].signals.map(sigSentence).join('; ')}. Checked each time a ${shortest(groups[0].signals)} candle closes.`
    : `${isAlert ? 'Sends you a Telegram message when' : 'Opens a cycle when'} ${(gs => gs.length === 1 ? gs[0] : gs.map(g => `(${g})`).join(j(f.logic)))(groups.map(g => g.signals.map(sigSentence).join(j(g.logic))))}. Checked each time a ${isAlert ? shortest(all) : f.tf} candle closes.${andUsed ? ` AND = within ${f.window || 3} candles of each other.` : ''}`;
  const modeHint = { indicator: 'Opens the first order when the indicator fires, checked each time a K-line candle closes.',
    maker: 'Buys when the price falls to the limit price. The bot looks at the price every 15 seconds and then buys at market. K-line and check interval are not used.',
    taker: 'Buys at market as soon as the bot starts. K-line and check interval are not used.' }[f.entryMode];
  // the order plan at the current price (a limit entry fills at the limit price)
  const mg = mgOf(f), ok = Object.values(mg).every(x => Number.isFinite(x)) && mg.investment > 0 && mg.maxAdds >= 0 && mg.maxAdds <= 20;
  const minInv = ok && px.price && px.contract ? minInvestment(mg, px.price, px.contract) : null, low = minInv !== null && mg.investment < minInv;
  const lim = f.entryMode === 'maker' && +f.limitPx > 0 ? +f.limitPx : 0, startPx = lim || px.price || 100;
  const rows = ok ? planRows(mg, startPx, px.contract) : [], last = rows[rows.length - 1];

  // ---- groups ----
  const setGroup = (gi, g) => setGroups(gs => gs.map((x, i) => i === gi ? g : x));
  const setSig = (gi, i, s) => setGroups(gs => gs.map((g, k) => k === gi ? { ...g, signals: g.signals.map((x, n) => n === i ? s : x) } : g));
  const addCond = gi => setGroups(gs => gs.map((g, k) => k !== gi ? g : { logic: g.signals.length === 1 && !isAlert ? 'and' : g.logic, signals: [...g.signals, { ...IND_DEFAULT[g.signals.length % 2 ? 'rsi' : 'macd'] }] }));

  // ---- symbol check (fresh broker read) ----
  const checkSym = async () => {
    if (!SYM.test(sym)) return setCk({ cls: 'hint down', text: 'Symbol must look like SMHUSDT.' });
    setCk({ cls: 'hint', text: 'Checking...', busy: true });
    try { const r = await getJSON(`/api/check/${sym}?broker=${f.broker || 'bitget'}&leverage=${Math.round(+f.leverage) || ''}`); setCk({ cls: 'hint' + (r.ok ? '' : ' down'), text: (r.ok ? '✓ ' : '✗ ') + r.message }); }
    catch (e) { setCk({ cls: 'hint down', text: 'Check failed: ' + e.message }); }
  };

  // ---- save ----
  const submit = async () => {
    const form = formRef.current, hidden = [...form.querySelectorAll('fieldset.hidden')];
    hidden.forEach(x => x.classList.remove('hidden')); // show every part so validation can reach all fields
    const valid = form.reportValidity();
    hidden.forEach(x => x.classList.add('hidden'));
    if (!valid) return;
    let limitPx = f.limitPx;
    if (tracking) { try { limitPx = String(await readPx()); } catch (e) { setErr(e.message); return; } setTrackPref(false); } // following: the limit is the price at this second
    const body = { name, tf: f.tf, usMarketHoursOnly: f.usMarketHoursOnly, entryMode: f.entryMode, limitPx };
    if (!editing) Object.assign(body, { id: autoId(), broker: f.broker, symbol: f.symbol });
    if (!isAlert) {
      for (const k of STRAT_KEYS) if (k !== 'leverage' || !editing) body[k] = f[k];
      if (!editing) Object.assign(body, { marginMode: f.marginMode, fillMode: f.fillMode });
    }
    const cleaned = groups.map(g => ({ ...g, signals: g.signals.map(s => { const c = { ...s }; if (c.tf === f.tf) delete c.tf; return c; }) })); // a K-line equal to the default follows the default
    body.entry = !isAlert && f.entryMode !== 'indicator' ? { mode: f.entryMode, limitPx } : { logic: f.logic, window: f.window || 3, groups: cleaned };
    // new bots: "live" sends real orders; every other choice is alert mode. Edits keep the bot's current mode
    if (!isAlert && !editing) {
      const live = body.fillMode === 'live';
      body.dryRun = !live; if (live) body.fillMode = 'auto';
      if (live && !await ask('Create a LIVE bot?', <><b>{body.symbol}</b> will send real market orders to Bitget with up to <b>{body.investment} USDT</b> margin at <b>{body.leverage}x</b>, starting as soon as it is created. Use <b>⏸ Pause</b> on the list page to stop all orders at once.</>, 'Create live bot')) return;
    }
    if (live0 && !await ask('Save changes to a live bot?', <><b>{name || editing}</b> trades real money. A running bot applies the change on its next check.</>, 'Save')) return;
    setBusy(true); setErr('');
    const base = isAlert ? '/api/watches' : '/api/bots';
    try {
      const j = await post(editing ? `${base}/${editing}` : base, body, editing ? 'PUT' : 'POST');
      close();
      const minInvAtSave = editing || isAlert ? null : minInv;
      toast(editing ? 'Changes saved' : isAlert ? 'Alert created. You get a Telegram message when it fires.' : minInvAtSave !== null && +body.investment < minInvAtSave ? `Bot created. Add funds (minimum ${fx(minInvAtSave)} USDT) so the first order can open.` : 'Bot created and started');
      await load(); // the new item has to be in the list before its page opens
      if (!editing && isAlert) { localStorage.setItem('listTab', 'alerts'); window.dispatchEvent(new Event('listtab')); go('#/'); }
      else if (!editing) go(`#/bot/${j.id}`);
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const testAlert = async () => { try { await post(`/api/watches/${editing}/test`); toast('Test message sent to Telegram'); } catch (e) { toast(e.message, true); } };
  const delAlert = async () => {
    if (!await ask('Delete this alert?', 'It stops and is removed from the list.', 'Delete')) return;
    try { await del(`/api/watches/${editing}`); toast('Alert deleted'); close(); } catch (e) { toast(e.message, true); }
    load();
  };

  const showPart = p => !part || p === part ? '' : 'hidden';
  const lockedKey = k => !!editing && ['broker', 'symbol', 'leverage', 'marginMode'].includes(k);
  const martDisabled = k => isAlert || (k === 'leverage' && !!editing);
  const numField = ({ k, label, unit, hint, extra }) => <div className="field"><label className="l" htmlFor={`f-${k}`}>{label}</label>
    {unit ? <div className="unit"><input id={`f-${k}`} type="number" required value={f[k]} disabled={martDisabled(k)} onChange={e => set({ [k]: e.target.value })} {...extra} /><span>{unit}</span></div>
      : <input id={`f-${k}`} type="number" required value={f[k]} disabled={martDisabled(k)} onChange={e => set({ [k]: e.target.value })} {...extra} />}
    {hint}</div>;

  return <>
    <div className="d-head"><h2>{isAlert ? (v ? 'Edit alert' : 'New alert') : v ? 'Edit indicator' : 'New bot'}</h2><button className="x" onClick={close} aria-label="Close">×</button></div>
    {!v && !isAlert && <div className="strat"><label className="l" htmlFor="stratSel">Strategy</label>
      <select id="stratSel" value={stratShown} onChange={e => applyStrategy(e.target.value)}><option value="">Custom</option>{strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <button type="button" className="btn small" onClick={saveStrategy}>Save</button><button type="button" className="btn small" onClick={deleteStrategy}>Delete</button></div>}
    {!v && !isAlert && <div className="seg"><button type="button" className={part === 'entry' ? 'on' : ''} onClick={() => setPart('entry')}>Entry condition</button>
      <button type="button" className={part === 'rest' ? 'on' : ''} onClick={() => setPart('rest')}>Settings</button></div>}
    <form id="form" ref={formRef} className={`d-body ${isAlert ? 'alert-mode' : ''}`} autoComplete="off" onSubmit={e => { e.preventDefault(); submit(); }}>
      <fieldset className={showPart('rest')}>
        <legend>{isAlert ? 'Stock' : 'Basics'}</legend>
        {v && <p className="hint" style={{ margin: '0 0 8px' }}>Broker, symbol and leverage can't change after creation.</p>}
        <div className="fgrid">
          <div className="field full"><label className="l">Name</label>
            {!identEdit ? <div className="ident"><div><div className="ident-name">{name}</div><div className="faint" style={{ fontSize: 12 }}>{identAuto ? 'Named from its settings' : 'Custom name'}</div></div>
              <button type="button" className="btn small" onClick={() => { if (identAuto) set({ name }); setIdentEdit(true); }}>Edit</button></div>
              : <div className="fgrid">
                <div className="field"><label className="l" htmlFor="f-name">Name</label><input id="f-name" autoFocus maxLength={60} value={identAuto ? name : f.name} onChange={e => { set({ name: e.target.value }); setIdentAuto(e.target.value === autoName()); }} /></div>
                <div className="full"><button type="button" className="btn small" disabled={identAuto} onClick={() => setIdentAuto(true)}>Auto</button> <button type="button" className="btn small" onClick={() => setIdentEdit(false)}>Done</button></div>
              </div>}</div>
          <div className="field"><label className="l" htmlFor="f-broker">Broker</label><select id="f-broker" value={f.broker} disabled={lockedKey('broker')} onChange={e => set({ broker: e.target.value })}>
            {Object.entries(S.brokers || { bitget: { label: 'Bitget' } }).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}</select></div>
          <div className="field"><label className="l" htmlFor="f-symbol">Symbol</label><div className="unit ck">
            <input id="f-symbol" required placeholder="SMHUSDT" autoFocus={!v} value={f.symbol} disabled={lockedKey('symbol')} onChange={e => set({ symbol: e.target.value })} />
            <button type="button" className="btn small" disabled={ck.busy} onClick={checkSym}>Check</button></div><div className={ck.cls}>{ck.text}</div></div>
        </div>
      </fieldset>
      <fieldset className={showPart('entry')}>
        <legend>{isAlert ? 'Alert · tell me when' : 'Entry · open a cycle when'}</legend>
        {!isAlert && <div className="fgrid" style={{ marginBottom: 10 }}>
          <div className="field"><label className="l" htmlFor="f-emode">First order</label><select id="f-emode" value={f.entryMode} onChange={e => set({ entryMode: e.target.value })}>
            <option value="indicator">Indicator signal</option><option value="maker">Limit price (maker)</option><option value="taker">Market now (taker)</option></select>
            <div className="hint">{modeHint}</div></div>
          {f.entryMode === 'maker' && <div className="field"><label className="l" htmlFor="f-limit">Limit price</label><div className="unit has-track">
            <input ref={limitRef} id="f-limit" type="number" step="any" min="0" required value={f.limitPx} onChange={e => { setTrackPref(false); set({ limitPx: e.target.value }); }} onBlur={refill} />
            <button type="button" className="track" aria-pressed={tracking} onClick={() => setTrackPref(t => !t)} title="Follow the current price (refreshes every 5 seconds)" aria-label="Follow the current price">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" /><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" /></svg></button><span>USDT</span></div>
            <div className="hint">{limitNow || 'The target follows the current price (refreshes every 5 seconds); type a price to turn it off.'}</div></div>}
        </div>}
        {f.entryMode === 'indicator' && <>
          <div className="kline-row"><label className="l" htmlFor="f-tf">Default K-line</label><select id="f-tf" value={f.tf} onChange={e => set({ tf: e.target.value })}>{TFS.map(x => <option key={x}>{x}</option>)}</select>
            <span className="hint">The candle size the indicators are calculated on (1H = one reading per hour). Each indicator can have its own K-line under its Advanced.</span></div>
          <div>{groups.map((g, gi) => <div key={gi}>
            {gi > 0 && <Chip logic={f.logic} onClick={() => set({ logic: f.logic === 'and' ? 'or' : 'and' })} />}
            <div className={isAlert ? 'flat' : 'group'}>
              {groups.length > 1 && <div className="group-head"><b>#{gi + 1}</b><span className="sp" />
                <button type="button" className="x" onClick={() => setGroups(gs => gs.filter((_, i) => i !== gi))} title="Remove group" aria-label={`Remove group ${gi + 1}`}>×</button></div>}
              {g.signals.map((s, i) => <div key={i}>
                {i > 0 && !isAlert && <Chip small logic={g.logic} onClick={() => setGroup(gi, { ...g, logic: g.logic === 'and' ? 'or' : 'and' })} />}
                <Cond s={s} def={f.tf} set={x => setSig(gi, i, x)} onRemove={g.signals.length > 1 ? () => setGroup(gi, { ...g, signals: g.signals.filter((_, n) => n !== i) }) : null} />
              </div>)}
              {g.signals.length < 5 && <button type="button" className="addlink" onClick={() => addCond(gi)}>+ Add condition</button>}
            </div></div>)}</div>
          {!isAlert && groups.length < 5 && <button type="button" className="addlink" onClick={() => setGroups(gs => [...gs, { logic: 'and', signals: [{ ...IND_DEFAULT.boll }] }])}>+ Add group</button>}
          <p className="trigger">{trigger}</p>
        </>}
        <details className="adv" open={!!init.f.usMarketHoursOnly || undefined}>
          <summary>Advanced <span className="faint" style={{ fontWeight: 400 }}>· {f.entryMode === 'indicator' ? 'AND window' : ''}{!isAlert ? `${f.entryMode === 'indicator' ? ', ' : ''}hours` : ''}</span></summary>
          <div className="fgrid">
            {andUsed && f.entryMode === 'indicator' && <div className="field"><label className="l" htmlFor="f-win">AND window</label><div className="unit"><input id="f-win" type="number" step="1" min="1" max="50" value={f.window} onChange={e => set({ window: e.target.value })} /><span>bars</span></div><div className="hint">AND conditions must fire within this many candles.</div></div>}
            {!isAlert && <div className="field full"><label className="switch"><input type="checkbox" checked={f.usMarketHoursOnly} onChange={e => set({ usMarketHoursOnly: e.target.checked })} /> Open only during US market hours (09:30–16:00 NY)</label></div>}
          </div>
        </details>
      </fieldset>
      {!isAlert && <fieldset className={showPart('rest')} id="martFs">
        <legend>Martingale</legend>
        <div className="fgrid">
          {numField({ k: 'investment', label: 'Investment', unit: 'USDT', extra: { step: 'any', min: 1 },
            hint: <div className={`hint ${low ? 'down' : ''}`}>{minInv === null ? 'Split over all orders automatically.' : `Minimum ${fx(minInv)} USDT at ${fx(px.price)}. ${low ? 'Below it the bot is still created and asks you to add funds when an order cannot open.' : 'Split over all orders automatically.'}`}</div> })}
          {numField({ k: 'leverage', label: 'Leverage', unit: 'x', extra: { step: 1, min: 1 } })}
          <div className="field"><label className="l" htmlFor="f-mm">Margin mode</label><select id="f-mm" value={f.marginMode} disabled={lockedKey('marginMode')} onChange={e => set({ marginMode: e.target.value })}><option value="crossed">Cross 全仓</option><option value="isolated">Isolated 逐仓</option></select></div>
          {numField({ k: 'stepPct', label: 'Price step', unit: '%', extra: { step: 'any', min: 0.01 }, hint: <div className="hint">Every add is measured from the entry price.</div> })}
          {numField({ k: 'stepMult', label: 'Price step multiple', unit: '×', extra: { step: 'any', min: 1 } })}
          {numField({ k: 'maxAdds', label: 'Max add orders', extra: { step: 1, min: 0, max: 20 } })}
          {numField({ k: 'amountMult', label: 'Amount multiple', unit: '×', extra: { step: 'any', min: 1 } })}
          {numField({ k: 'tpPct', label: 'Take profit', unit: '%', extra: { step: 'any', min: 0.01 }, hint: <div className="hint">Above the average price.</div> })}
          <div className="field"><label className="l" htmlFor="f-fill">Orders</label><select id="f-fill" value={f.fillMode} disabled={!!editing} onChange={e => set({ fillMode: e.target.value })}>
            <option value="auto" hidden>Automatic (simulated)</option><option value="manual">Manual</option><option value="live">Automatic</option></select>
            <div className="hint">Manual: you place each order and enter its real fill. Automatic: the bot places the orders on Bitget (real money).</div></div>
          <div className="field"><label className="l" htmlFor="f-cyc">Max cycles</label><input id="f-cyc" type="number" step="1" min="0" max="1000" value={f.maxCycles} onChange={e => set({ maxCycles: e.target.value })} />
            <div className="hint">0 = no limit. After this many cycles the bot opens no new one.</div></div>
        </div>
        <div className="preview"><button type="button" className="btn" disabled={!ok} onClick={() => setPv(true)}>Preview orders</button>
          <p className="faint" style={{ margin: '8px 0 0' }}>{ok ? `${rows.length} orders · adds cover a drop to −${fx(last.drop, 1)}%` : 'Fill in the martingale fields to preview the order plan.'}</p></div>
      </fieldset>}
      <p className="err">{err}</p>
    </form>
    <div className="d-foot">
      <button className="btn primary" disabled={busy} onClick={submit}>{v ? 'Save changes' : isAlert ? 'Create alert' : 'Create bot'}</button>
      <button className="btn" onClick={close}>Cancel</button>
      {isAlert && v && S.editable && <><button type="button" className="btn small" onClick={testAlert}>Test</button><button type="button" className="btn small danger" onClick={delAlert}>Delete</button></>}
      <span className="sp" />
      <span className="faint" style={{ fontSize: 12 }} id="footNote">{v && v.running ? 'Applies on the next check' : ''}</span>
    </div>
    <Sheet open={pv && ok} onClose={() => setPv(false)} title="Order preview">
      <b>{lim ? `If the first order fills at the limit price ${fx(startPx)}` : px.price ? `If a cycle opened now at ${fx(startPx)}` : 'Order plan (example price 100)'}</b>
      <div style={{ marginTop: 6 }}><OrdersTable rows={rows} inv={mg.investment} c={px.contract} /></div>
      {ok && <p className="faint" style={{ margin: '8px 0 0' }}>First order {fx(firstMargin(mg))} USDT margin (≈ {fx(firstMargin(mg) / qtyFactor(mg.leverage), 0)} USDT position).
        Adds cover a drop to −{fx(last.drop, 1)}%{last.px <= 0 ? ' (steps too large!)' : ''}; below that no more adds and no stop loss.</p>}
    </Sheet>
  </>;
}
