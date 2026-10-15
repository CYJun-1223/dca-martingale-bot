// Number and time formatting, as on the exchange apps.
export const fx = (v, d = 2) => v === null || v === undefined || Number.isNaN(+v) ? '–' : (+v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const money = (v, d = 4) => v === null || v === undefined ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + fx(Math.abs(v), d);
export const dir = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
export const ago = ts => {
  if (!ts) return 'never';
  const s = (Date.now() - ts) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
export const when = ts => ts ? new Date(ts).toLocaleString('sv-SE').slice(0, 16) : '–';
export function heldFor(ms) {
  const m = Math.round(ms / 60e3), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}
// a fee as the exchange shows it: up to 8 decimals, trailing zeros dropped (0.00759696, 0.0076728)
export const feeFx = v => (+v).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 8 });
export const coinOf = symbol => symbol.replace(/USDT$/, '');
