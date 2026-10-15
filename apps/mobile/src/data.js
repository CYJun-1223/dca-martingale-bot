// Server data, polled every 15 s like the web dashboard: GET /api/bots has everything (accounts, bots, watches).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { request } from './api';
import { loadConnection, saveConnection, clearConnection } from './storage';

const Ctx = createContext(null);
export const useData = () => useContext(Ctx);

export function DataProvider({ children }) {
  const [conn, setConn] = useState(null); // null = still reading the saved settings
  const [S, setS] = useState({ bots: [], watches: [], strategies: [], accounts: {}, editable: false, stopAll: false, lastOk: 0, error: null, loading: true });
  const connRef = useRef(conn); connRef.current = conn;

  useEffect(() => { loadConnection().then(setConn); }, []);

  const load = useCallback(async () => {
    const c = connRef.current;
    if (!c || !c.url) return;
    try {
      const d = await request(c, '/api/bots');
      setS(s => ({ ...s, ...d, accounts: d.accounts || {}, strategies: d.strategies || [], watches: d.watches || [], bots: d.bots || [], lastOk: Date.now(), error: null, loading: false }));
    } catch (e) { setS(s => ({ ...s, error: e, loading: false })); }
  }, []);

  useEffect(() => {
    if (!conn || !conn.url) return undefined;
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [conn, load]);

  const api = useMemo(() => ({
    conn, S, load,
    connect: async c => { await saveConnection(c); setS(s => ({ ...s, loading: true, error: null })); setConn(c); },
    disconnect: async () => { await clearConnection(); setConn({ url: '', user: '', pass: '', cfId: '', cfSecret: '' }); setS(s => ({ ...s, bots: [], watches: [], accounts: {}, lastOk: 0, error: null })); },
    post: (path, body) => request(connRef.current, path, { method: 'POST', body: body || {} }),
  }), [conn, S, load]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
