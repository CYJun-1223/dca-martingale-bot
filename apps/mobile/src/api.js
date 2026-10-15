// Talks to the dashboard server (apps/server/web.js). Same JSON API the web dashboard uses.
// One way to sign in: the dashboard's own user + password (WEB_USER / WEB_PASSWORD), sent as HTTP Basic,
// to the dashboard's Tailscale / LAN address (no Cloudflare in between).
const b64 = s => {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = unescape(encodeURIComponent(s)); let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i), b = bytes.charCodeAt(i + 1), c = bytes.charCodeAt(i + 2);
    out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4 || 0)] + (isNaN(b) ? '=' : chars[((b & 15) << 2) | (c >> 6 || 0)]) + (isNaN(c) ? '=' : chars[c & 63]);
  }
  return out;
};

export const cleanUrl = u => {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = (/^(localhost|127\.|10\.|192\.168\.)/.test(s) ? 'http://' : 'https://') + s;
  return s;
};

export function headersFor(c, json = false) {
  const h = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  if (c.user || c.pass) h.Authorization = `Basic ${b64(`${c.user}:${c.pass}`)}`;
  return h;
}

export class ApiError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; } // kind: 'auth' | 'network' | 'server'
}

export async function request(conn, path, { method = 'GET', body, timeout = 15000 } = {}) {
  const base = cleanUrl(conn.url);
  if (!base) throw new ApiError('Set the server address first.', 'network');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(base + path, { method, headers: headersFor(conn, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new ApiError(e.name === 'AbortError' ? 'The server did not answer in time.' : `Cannot reach the server (${e.message || e}). Check the address and that Tailscale is on.`, 'network');
  } finally { clearTimeout(timer); }
  if (r.status === 401 || r.status === 403 || r.redirected) throw new ApiError('Signed out: check the user and password.', 'auth');
  const ct = r.headers.get('content-type') || '';
  if (!/json/.test(ct)) throw new ApiError(r.ok ? 'The server answered with something that is not the dashboard.' : `The server answered ${r.status}.`, r.ok ? 'auth' : 'server');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error || `The server answered ${r.status}.`, 'server');
  return j;
}
