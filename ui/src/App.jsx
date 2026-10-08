import { useCallback, useEffect, useRef, useState } from 'react';
import { DataProvider, UiProvider, PanelsCtx, useData, useUi, useRoute, go, post, Sheet, Drawer, LiveDot } from './core.jsx';
import ListPage from './List.jsx';
import DetailPage, { CycleBody } from './Detail.jsx';
import FormBody from './Form.jsx';
import { ManageBody, ManualBody, FillBody, CyclesBody, TpBody, MaxBody, FundsBody, WhenBody } from './Sheets.jsx';

const ICON = {
  bot: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 8V4.5M9 13v1.5M15 13v1.5" /><circle cx="12" cy="3.5" r="1" /></svg>,
  back: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 5l-7 7 7 7" /></svg>,
};
// the bottom sheets that take one bot: title and body
const MO = { manual: ['Manual order', ManualBody], fill: ['Enter fill', FillBody], cycles: ['Max cycles', CyclesBody], tp: ['Take profit', TpBody],
  max: ['Max add orders', MaxBody], funds: ['Add funds', FundsBody] };

function Shell() {
  const { S, load } = useData(), { toast, ask } = useUi(), r = useRoute();
  const [panel, setPanel] = useState(null); // { kind, id, ...extra }: the one sheet / drawer on top of the page
  const [listTab, setListTabState] = useState(() => localStorage.getItem('listTab') === 'alerts' ? 'alerts' : 'bots');
  const setListTab = t => { setListTabState(t); localStorage.setItem('listTab', t); };
  useEffect(() => { const f = () => setListTabState(localStorage.getItem('listTab') === 'alerts' ? 'alerts' : 'bots'); window.addEventListener('listtab', f); return () => window.removeEventListener('listtab', f); }, []);

  const open = useCallback((kind, id, extra = {}) => setPanel({ ...extra, kind, id, key: Date.now() }), []);
  const close = useCallback(() => setPanel(null), []);
  const startStop = useCallback(async (id, on) => {
    if (!on && !await ask('Stop this bot?', 'It stops checking prices and sending alerts. An open cycle stays as it is and continues when you start the bot again.', 'Stop')) return;
    try { await post(`/api/bots/${id}/${on ? 'start' : 'stop'}`); toast(on ? 'Starting…' : 'Stopped'); } catch (e) { toast(e.message, true); }
    load();
  }, [ask, toast, load]);
  const openForm = (id, formKind) => open('form', id, { formKind });

  // the page slides in from the right when you open a bot, from the left when you go back
  const page = r ? `bot:${r.id}` : 'list', prev = useRef(null), slide = useRef('');
  if (prev.current !== page) { slide.current = prev.current === null ? '' : r ? 'go-in' : 'go-back'; prev.current = page; }
  useEffect(() => { window.scrollTo(0, 0); }, [page]);

  const v = r && S.bots.find(x => x.bot.id === r.id);
  useEffect(() => { if (r && !v && S.lastOk) go('#/'); }, [r, v, S.lastOk]); // bot gone (deleted)
  const pv = panel && panel.id ? S.bots.find(x => x.bot.id === panel.id) : null; // the bot a sheet is about
  const kind = panel && panel.kind, mo = MO[kind];

  return <PanelsCtx.Provider value={{ open, close, startStop }}>
    <div className="top"><div className="top-in">
      <a className="nav-ic" href="#/" aria-label={r ? 'All bots' : 'Bots'} style={{ color: r ? undefined : 'var(--accent)' }}>{r ? ICON.back : ICON.bot}</a>
      <span className="brand">Bots</span>
      <LiveDot />
      <span className="chip" id="tg" title="Where alerts go">{S.lastOk ? S.telegram ? 'Telegram alerts on' : 'Telegram alerts off' : ''}</span>
      <span className="sp" />
      {S.editable && !r && <button className="btn primary" onClick={() => openForm(null, listTab === 'alerts' ? 'alert' : 'bot')}>{listTab === 'alerts' ? '+ New alert' : '+ New bot'}</button>}
    </div></div>
    <main>
      {!S.lastOk ? <div id="bots"><div className="tile empty">{S.error ? <>Couldn't load the bots ({S.error}).<br />Reload the page; if it keeps happening, sign in again.</> : 'Loading…'}</div></div>
        : v ? <DetailPage key={v.bot.id} v={v} tab={r.tab} slide={slide.current} />
        : <ListPage tab={listTab} setTab={setListTab} openForm={openForm} slide={slide.current} />}
    </main>
    <Drawer open={kind === 'form'} onClose={close}>{kind === 'form' && <FormBody key={panel.key} id={panel.id} kind={panel.formKind} />}</Drawer>
    <Sheet open={kind === 'manage' && !!pv} onClose={close} title="Bot management" className="" head={false}>{pv && <ManageBody v={pv} />}</Sheet>
    <Sheet open={kind === 'cycle' && !!pv} onClose={close} title={pv && panel.cycleId != null ? `Cycle #${panel.cycleId}${pv.pos && pv.pos.id === panel.cycleId ? ' · open' : ''}` : 'Cycle'}>{pv && <CycleBody v={pv} cycleId={panel.cycleId} />}</Sheet>
    <Sheet open={(!!mo || kind === 'when') && !!pv} onClose={close} title={kind === 'when' ? (panel.what === 'close' ? 'Close bot' : 'Stop bot') : mo ? mo[0] : ''}>
      {pv && (kind === 'when' ? <WhenBody key={panel.key} v={pv} kind={panel.what} /> : mo && (() => { const B = mo[1]; return <B key={panel.key} v={pv} />; })())}
    </Sheet>
  </PanelsCtx.Provider>;
}

export default function App() {
  return <UiProvider><DataProvider><Shell /></DataProvider></UiProvider>;
}
