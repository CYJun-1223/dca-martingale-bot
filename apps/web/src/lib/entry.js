// Entry conditions: same shapes as bots.json (and strategy.js entryOf). Text for the cards, the form and the auto name.
export const TFS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];
export const TF_MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1H': 60, '4H': 240, '1D': 1440 };
export const IND_DEFAULT = {
  ma: { type: 'ma-cross', ma: 'sma', fast: 20, slow: 50 },
  boll: { type: 'boll-revert', period: 20, mult: 2 },
  macd: { type: 'macd-cross', fast: 12, slow: 26, signal: 9 },
  rsi: { type: 'rsi-cross', period: 14, level: 30 },
};
// the form's two fields (band, side) <-> the signal type
export const bollType = (band, side) => ({ 'lower-below': 'boll-revert', 'lower-above': 'boll-reclaim', 'upper-above': 'boll-break', 'upper-below': 'boll-fade' })[`${band}-${side}`];
export const bollBand = t => t === 'boll-revert' || t === 'boll-reclaim' ? 'lower' : 'upper';
export const bollSide = t => t === 'boll-revert' || t === 'boll-fade' ? 'below' : 'above';
export const indOf =type => ({ 'ma-cross': 'ma', 'macd-cross': 'macd', 'rsi-cross': 'rsi' })[type] || 'boll';

// entry = groups of conditions; older flat shapes become one group
export function entryOf(b) {
  const e = b.entry;
  if (e && (e.mode === 'maker' || e.mode === 'taker')) return { mode: e.mode, limitPx: e.limitPx, logic: 'or', window: 3, groups: [], volatility: null };
  if (e && e.groups && e.groups.length) return { logic: e.logic || 'or', window: e.window || 3, groups: e.groups, volatility: e.volatility || null };
  if (e && e.signals) return { logic: 'or', window: e.window || 3, groups: [{ logic: e.logic || 'or', signals: e.signals }], volatility: e.volatility || null };
  return { logic: 'or', window: 3, groups: [{ logic: 'or', signals: [b.signal || IND_DEFAULT.boll] }] };
}
export const usesAnd = e => (e.logic === 'and' && e.groups.length > 1) || e.groups.some(g => g.logic === 'and' && g.signals.length > 1);

export const volText = v => v && (+v.minPct > 0 || +v.maxPct > 0)
  ? `ATR ${+v.minPct > 0 ? v.minPct : ''}${+v.minPct > 0 && +v.maxPct > 0 ? '–' : +v.minPct > 0 ? '+' : '≤'}${+v.maxPct > 0 ? v.maxPct : ''}%` : '';
const sigExtra = s => { const bits = [s.tf, volText(s.volatility)].filter(Boolean); return bits.length ? ` (${bits.join(', ')})` : ''; };
const sigText = s => ({
  'ma-cross': () => `${String(s.ma).toUpperCase()} ${s.fast}/${s.slow} cross`,
  'macd-cross': () => `MACD(${s.fast}, ${s.slow}, ${s.signal}) cross`,
  'rsi-cross': () => `RSI(${s.period}) up through ${s.level}`,
  'boll-break': () => `BOLL(${s.period}, ${s.mult}) breakout`,
  'boll-reclaim': () => `BOLL(${s.period}, ${s.mult}) above lower band`,
  'boll-fade': () => `BOLL(${s.period}, ${s.mult}) below upper band`,
})[s.type]?.() ?? `BOLL(${s.period}, ${s.mult}) below lower band`;
export const sigLabel = s => sigText(s) + sigExtra(s);
export function entryText(e) {
  if (e.mode) return e.mode === 'taker' ? 'Market order right away' : `Limit order at ${e.limitPx}`;
  const j = l => l === 'and' ? ' AND ' : ' OR ', gs = e.groups.map(g => g.signals.map(sigLabel).join(j(g.logic)));
  return gs.length === 1 ? gs[0] : gs.map(g => `(${g})`).join(j(e.logic));
}
const sigShortBase = s => ({ 'ma-cross': `${String(s.ma).toUpperCase()} ${s.fast}/${s.slow}`, 'macd-cross': `MACD ${s.fast}/${s.slow}/${s.signal}`,
  'rsi-cross': `RSI ${s.period} ↑${s.level}`, 'boll-break': `BOLL ${s.period}/${s.mult} breakout`, 'boll-reclaim': `BOLL ${s.period}/${s.mult} reclaim`, 'boll-fade': `BOLL ${s.period}/${s.mult} fade` })[s.type] || `BOLL ${s.period}/${s.mult}`;
export const sigShort = s => sigShortBase(s) + (s.tf ? ` ${s.tf}` : '');
function sigSentenceBase(s) {
  switch (s.type) {
    case 'ma-cross': return `${String(s.ma).toUpperCase()}(${s.fast}) crosses above ${String(s.ma).toUpperCase()}(${s.slow})`;
    case 'macd-cross': return `the MACD(${s.fast}, ${s.slow}) line crosses above its ${s.signal}-period signal line`;
    case 'rsi-cross': return `RSI(${s.period}) rises back above ${s.level}`;
    case 'boll-break': return `the close crosses above the upper band of BOLL(${s.period}, ${s.mult})`;
    case 'boll-reclaim': return `the close crosses above the lower band of BOLL(${s.period}, ${s.mult})`;
    case 'boll-fade': return `the close crosses below the upper band of BOLL(${s.period}, ${s.mult})`;
    default: return `the close crosses below the lower band of BOLL(${s.period}, ${s.mult})`;
  }
}
// the sentence under the editor: a condition's own K-line / volatility filter are spelled out
export function sigSentence(s) {
  const v = s.volatility, vol = volText(v) ? `, only while volatility (${volText(v)} of price) is in range` : '';
  return sigSentenceBase(s) + (s.tf ? ` on the ${s.tf} candles` : '') + vol;
}
