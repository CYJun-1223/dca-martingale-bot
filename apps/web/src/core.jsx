// App-wide pieces: server data (polled every 15 s), hash routes, toasts, the confirm dialog, and bottom sheets / drawers
// that the phone's back gesture closes.
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ago } from './lib/format.js';

// ---------- server data ----------
export async function post(url, body, method = 'POST') {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
export const del = url => post(url, null, 'DELETE');
export const getJSON = async url => (await fetch(url)).json();

const Data = createContext(null);
export const useData = () => useContext(Data);
export function DataProvider({ children }) {
  const [S, setS] = useState({ bots: [], watches: [], strategies: [], accounts: {}, editable: false, lastOk: 0, error: null });
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/bots');
      if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) throw new Error(r.redirected || r.status === 401 || r.status === 403 ? 'signed out' : `server answered ${r.status}`);
      const d = await r.json();
      setS(s => ({ ...s, ...d, accounts: d.accounts || {}, strategies: d.strategies || [], watches: d.watches || [], lastOk: Date.now(), error: null }));
    } catch (e) { setS(s => ({ ...s, error: e.message === 'Failed to fetch' ? 'no connection' : e.message })); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const setStrategies = useCallback(strategies => setS(s => ({ ...s, strategies })), []);
  return <Data.Provider value={{ S, load, setStrategies }}>{children}</Data.Provider>;
}
// re-render every few seconds so "2m ago" and the live dot stay true between loads
export function useNow(ms = 5000) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), ms); return () => clearInterval(t); }, [ms]);
  return Date.now();
}
export function LiveDot() {
  const { S } = useData(); useNow();
  const stale = Date.now() - S.lastOk > 45e3;
  return <span className={`live-dot ${stale ? 'stale' : ''}`} id="live"><i /><span id="updated">{!S.lastOk ? 'connecting…' : stale ? `offline · last update ${ago(S.lastOk)}` : 'live'}</span></span>;
}

// ---------- panels: which sheet / drawer is open (App provides it) ----------
export const PanelsCtx = createContext(null);
export const usePanels = () => useContext(PanelsCtx);

// ---------- routes: #/ = all bots, #/bot/<id>/<tab> = one bot ----------
export const TABS = [['overview', 'Overview'], ['settings', 'Parameters'], ['orders', 'Orders'], ['history', 'History']];
const subscribeHash = cb => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); };
export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const m = /^#\/bot\/([a-z0-9-]+)(?:\/([a-z]+))?/.exec(hash);
  return m ? { id: m[1], tab: TABS.some(([k]) => k === m[2]) ? m[2] : 'overview' } : null;
}
export const go = hash => { location.hash = hash; };

// ---------- toasts + confirm dialog ----------
const Ui = createContext(null);
export const useUi = () => useContext(Ui);
export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dlg, setDlg] = useState(null); // { title, body, yes, resolve }
  const ref = useRef(null);
  const toast = useCallback((msg, err = false) => {
    const id = Math.random();
    setToasts(t => [...t, { id, msg, err }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  }, []);
  const ask = useCallback((title, body, yes = 'OK') => new Promise(resolve => setDlg({ title, body, yes, resolve })), []);
  useEffect(() => { if (dlg && ref.current && !ref.current.open) ref.current.showModal(); }, [dlg]);
  const done = v => { ref.current && ref.current.close(); dlg && dlg.resolve(v); setDlg(null); };
  return <Ui.Provider value={{ toast, ask }}>
    {children}
    <dialog ref={ref} onCancel={e => { e.preventDefault(); done(false); }}>
      <div className="dc"><h3>{dlg && dlg.title}</h3><div className="muted">{dlg && dlg.body}</div></div>
      <div className="df"><button className="btn" onClick={() => done(false)}>Cancel</button><button className="btn primary" onClick={() => done(true)}>{dlg && dlg.yes}</button></div>
    </dialog>
    <div className="toasts">{toasts.map(t => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>{t.msg}</div>)}</div>
  </Ui.Provider>;
}

// ---------- back gesture closes the panel on top ----------
// Each open panel owns one history entry (same URL, so no hashchange). Back pops it and closes the top panel; closing a
// panel on the page (x, scrim, Escape, saving) drops its entry again. Opening one panel as another closes keeps the count.
const stack = []; // close functions of the open panels, bottom to top
let ignorePop = 0, pending = 0, flushing = false;
const flush = () => { // one history change per batch of opens / closes
  flushing = false;
  if (pending > 0) for (let n = 0; n < pending; n++) history.pushState({ panel: true }, '');
  else if (pending < 0) { ignorePop++; history.go(pending); }
  pending = 0;
};
const change = d => { pending += d; if (!flushing) { flushing = true; queueMicrotask(flush); } };
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop--; return; }
  const top = stack[stack.length - 1];
  if (top) top.byBack();
});
function useBackClose(open, onClose) {
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const me = { popped: false, byBack: () => { me.popped = true; onCloseRef.current(); } };
    stack.push(me); change(+1);
    return () => { const i = stack.indexOf(me); if (i >= 0) stack.splice(i, 1); if (!me.popped) change(-1); };
  }, [open]);
}
// Escape closes the top panel too
window.addEventListener('keydown', e => { if (e.key === 'Escape' && stack.length && !document.querySelector('dialog[open]')) history.back(); });

export function Sheet({ open, onClose, title, className = 'mo', children, head = true, label }) {
  useBackClose(open, onClose);
  return <>
    <div className={`scrim ${open ? 'on' : ''}`} style={{ zIndex: 24 }} onClick={onClose} />
    <div className={`sheet ${className} ${open ? 'on' : ''}`} role="dialog" aria-label={label || title}><div className="grab" />
      {head ? <div className="mo-head"><h3>{title}</h3><button className="x" onClick={onClose} aria-label="Close">×</button></div> : <h3>{title}</h3>}
      {open && children}
    </div>
  </>;
}
export function Drawer({ open, onClose, children }) {
  useBackClose(open, onClose);
  return <>
    <div className={`scrim ${open ? 'on' : ''}`} onClick={onClose} />
    <aside className={`drawer ${open ? 'on' : ''}`}>{open && children}</aside>
  </>;
}

// Keep bottom sheets above the on-screen keyboard (only while a field is focused; a height over 60% of the screen is not a keyboard).
if (window.visualViewport) {
  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
  const kb = () => {
    const h = Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop);
    document.documentElement.style.setProperty('--kb', `${typing() && h < window.innerHeight * 0.6 ? h : 0}px`);
  };
  visualViewport.addEventListener('resize', kb); visualViewport.addEventListener('scroll', kb);
  document.addEventListener('focusin', kb); document.addEventListener('focusout', () => setTimeout(kb, 50));
}
