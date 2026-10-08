// Bot registry: one record per bot (database table bots), each overriding config.js.
// Every bot gets its own state (database), log and trace files, keyed by id.
const path = require('path');
const base = require('./config');
const { liveEnabled } = require('./executor');
const { TF_MS, BROKERS } = require('./market');
const S = require('./strategy');
const db = require('./db');

const TFS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'];
const SIGNALS = ['ma-cross', 'boll-revert', 'boll-break', 'macd-cross', 'rsi-cross'];

const list = () => db.listBots();
const save = all => db.saveBots(all);

// full config for one bot record
function cfgFor(bot) {
  const cfg = {
    ...base,
    logFile: `bot-${bot.id}.log`,
    traceDir: path.join('trace', bot.id),
    ...bot,
  };
  return cfg;
}

// change fields of one bot record (used by the runner when a stop / close price is reached)
async function patch(id, fields) {
  const all = await list(), i = all.findIndex(b => b.id === id);
  if (i < 0) return;
  all[i] = { ...all[i], ...fields, updatedAt: new Date().toISOString() };
  await save(all);
}

async function find(id) {
  const bots = await list();
  const bot = id ? bots.find(b => b.id === id) : bots[0];
  if (id && !bot) throw new Error(`No bot "${id}" (have: ${bots.map(b => b.id).join(', ') || 'none'})`);
  return bot;
}

// entry signal per indicator: each has its own fields
//   MA   { type: 'ma-cross', ma: 'sma' | 'ema', fast, slow }
//   BOLL { type: 'boll-revert' | 'boll-break', period, mult (K) }
//   MACD { type: 'macd-cross', fast, slow, signal }
//   RSI  { type: 'rsi-cross', period, level }
function parseSignal(s) {
  const num = (k, min, max, int = true) => {
    const v = +s[k];
    if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) throw new Error(`${k} must be ${int ? 'a whole number' : 'a number'} from ${min} to ${max}`);
    return v;
  };
  if (!SIGNALS.includes(s.type)) throw new Error(`signal type must be one of ${SIGNALS.join(', ')}`);
  let out;
  if (s.type === 'ma-cross') out = { type: s.type, ma: s.ma === 'ema' ? 'ema' : 'sma', fast: num('fast', 1, 500), slow: num('slow', 2, 500) };
  else if (s.type === 'macd-cross') out = { type: s.type, fast: num('fast', 1, 200), slow: num('slow', 2, 300), signal: num('signal', 1, 100) };
  else if (s.type === 'rsi-cross') out = { type: s.type, period: num('period', 2, 100), level: num('level', 1, 99, false) };
  else out = { type: s.type, period: num('period', 2, 500), mult: num('mult', 0.1, 10, false) };
  if ('fast' in out && out.fast >= out.slow) throw new Error('fast must be smaller than slow');
  // this condition's own K-line and volatility filter (both optional)
  if (s.tf) {
    if (!TFS.includes(s.tf)) throw new Error(`K-line must be one of ${TFS.join(', ')}`);
    out.tf = s.tf;
  }
  const vol = parseVolatility(s.volatility);
  if (vol) out.volatility = vol;
  return out;
}

// turn raw form input into a bot record; throws with a readable message
// prev = the record being edited: id, symbol, leverage and createdAt are kept from it
function validate(input, existing, prev = null) {
  const num = (k, min, max) => {
    const v = +input[k];
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be a number from ${min} to ${max}`);
    return v;
  };
  const intIn = (k, min, max) => { const v = num(k, min, max); if (!Number.isInteger(v)) throw new Error(`${k} must be a whole number`); return v; };
  const bool = k => input[k] === true || input[k] === 'true' || input[k] === 'on';
  const id = prev ? prev.id : String(input.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('id: lowercase letters, digits and "-" only');
  if (!prev && existing.some(b => b.id === id)) throw new Error(`id "${id}" already exists`);
  const symbol = String((prev && input.symbol === undefined ? prev.symbol : input.symbol) || '').trim().toUpperCase(); // changing it on a saved bot is checked in web.js
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) throw new Error('symbol must look like SOXXUSDT');
  const broker = prev ? prev.broker || 'bitget' : String(input.broker || 'bitget');
  if (!BROKERS[broker]) throw new Error(`broker must be one of ${Object.keys(BROKERS).join(', ')}`);
  // alert mode (simulated fills) unless live is asked for explicitly
  const dryRun = input.dryRun === undefined ? (prev ? prev.dryRun : true) : bool('dryRun');
  if (!TFS.includes(input.tf)) throw new Error(`tf must be one of ${TFS.join(', ')}`);
  if (!dryRun && !liveEnabled()) throw new Error('Live trading is off: set LIVE_TRADING=1 in .env and restart the runner and dashboard');
  const bot = {
    id,
    name: String(input.name || id).trim().slice(0, 60),
    broker,
    symbol,
    tf: input.tf,
    leverage: prev && input.leverage === undefined ? prev.leverage : num('leverage', 1, 125),
    // 'crossed' (全仓) or 'isolated' (逐仓); fixed at creation like the leverage (older bots have none = crossed)
    marginMode: prev ? prev.marginMode || 'crossed' : input.marginMode === 'isolated' ? 'isolated' : 'crossed',
    entry: parseEntry(input.entry),
    // martingale, same fields as Bitget's
    investment: num('investment', 1, 1e7),        // total margin (USDT) for the first order + every add
    maxAdds: num('maxAdds', 0, 20),               // add orders after the first
    stepPct: num('stepPct', 0.01, 50),            // first price step (%); every add is measured from the entry price
    stepMult: num('stepMult', 1, 10),             // each step = previous step x this
    amountMult: num('amountMult', 1, 10),         // order #n margin = base x this^n (first order n = 0)
    tpPct: num('tpPct', 0.01, 100),               // take profit: % above the average entry price
    usMarketHoursOnly: bool('usMarketHoursOnly'),
    // 'manual' = the orders are placed by hand on the exchange and entered here as they fill (the bot never fills them itself)
    fillMode: input.fillMode === undefined ? (prev && prev.fillMode) || 'auto' : input.fillMode === 'manual' ? 'manual' : 'auto',
    maxCycles: input.maxCycles === undefined || input.maxCycles === '' ? (prev && prev.maxCycles) || 0 : intIn('maxCycles', 0, 1000), // 0 = no limit
    dryRun,
    enabled: prev ? prev.enabled !== false : true, // Start / Stop on the dashboard; new bots start right away
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
  };
  // an edit can only raise a limit (0 = no limit counts as the highest)
  if (prev && prev.maxCycles > 0 && bot.maxCycles > 0 && bot.maxCycles < prev.maxCycles) throw new Error(`Max cycles can only go up: more than ${prev.maxCycles}, or 0 for no limit.`); // unchanged is fine: other edits re-send it
  if (prev && prev.closedAt) bot.closedAt = prev.closedAt; // a closed bot stays closed
  if (!Number.isInteger(bot.maxAdds)) throw new Error('maxAdds must be a whole number');
  if (prev) bot.updatedAt = new Date().toISOString();
  // the last add must stay above zero
  if (!(S.dropAt(bot, bot.maxAdds) < 1))
    throw new Error('price steps are too large: an add order would be at or below zero');
  return bot;
}

// entry: a group of 1-5 indicator conditions combined with AND / OR
//   { logic: 'and' | 'or', window: bars within which AND conditions must all fire, signals: [...] }
// entry: 1-5 groups, each with 1-5 conditions and its own AND / OR; `logic` combines the groups
//   { logic: 'or' | 'and', window, groups: [{ logic: 'and' | 'or', signals: [...] }] }
// (a flat { logic, signals } from before groups is accepted as one group)
function parseEntry(e) {
  if (e && (e.mode === 'maker' || e.mode === 'taker')) { // no indicator: a limit order at limitPx, or a market order right away
    const limitPx = +e.limitPx;
    if (e.mode === 'maker' && !(limitPx > 0)) throw new Error('limit (maker) entry needs a price above 0');
    return { mode: e.mode, ...(e.mode === 'maker' ? { limitPx } : {}), logic: 'or', window: 3, groups: [], volatility: null };
  }
  if (e && !e.groups && Array.isArray(e.signals)) e = { logic: 'or', window: e.window, volatility: e.volatility, groups: [{ logic: e.logic, signals: e.signals }] };
  if (!e || !Array.isArray(e.groups) || !e.groups.length || e.groups.length > 5) throw new Error('entry needs 1 to 5 condition groups');
  const window = Math.round(+e.window || 3);
  if (window < 1 || window > 50) throw new Error('AND window must be 1 to 50 bars');
  return {
    logic: e.logic === 'and' ? 'and' : 'or',
    window,
    groups: e.groups.map((g, gi) => {
      if (!g || !Array.isArray(g.signals) || !g.signals.length || g.signals.length > 5) throw new Error(`group ${gi + 1} needs 1 to 5 conditions`);
      return { logic: g.logic === 'and' ? 'and' : 'or', signals: g.signals.map((s, i) => {
        try { return parseSignal(s); } catch (err) { throw new Error(`group ${gi + 1}, condition ${i + 1}: ${err.message}`); }
      }) };
    }),
    volatility: parseVolatility(e.volatility),
  };
}

// volatility filter: ATR(period) as % of price must be within [minPct, maxPct]; empty limits = off
function parseVolatility(v) {
  if (!v) return null;
  const opt = (k, max) => {
    if (v[k] === '' || v[k] == null) return null;
    const x = +v[k];
    if (!Number.isFinite(x) || x < 0 || x > max) throw new Error(`volatility ${k === 'minPct' ? 'minimum' : 'maximum'} must be 0 to ${max} %`);
    return x || null;
  };
  const minPct = opt('minPct', 100), maxPct = opt('maxPct', 100);
  if (!minPct && !maxPct) return null;
  if (minPct && maxPct && minPct >= maxPct) throw new Error('volatility minimum must be below the maximum');
  const period = Math.round(+v.period || 14);
  if (period < 2 || period > 200) throw new Error('volatility period must be 2 to 200 candles');
  return { period, minPct, maxPct };
}

// ---- strategies: saved sets of martingale parameters that auto-fill the new-bot form (indicator, symbol and name stay per bot) ----
const STRATEGY_FIELDS = ['investment', 'leverage', 'maxAdds', 'stepPct', 'stepMult', 'amountMult', 'tpPct', 'maxCycles'];
// A strategy = the entry (first-order mode, indicator conditions, K-line, check interval) + the martingale numbers + the reserve.
// The symbol, name and a limit PRICE are never part of it (a price belongs to one moment). Every field is optional and has no
// limits here: a number only has to be a number, the entry only has to look like an entry. Everything is checked when a bot
// is created from it (validate / parseEntry), so nothing invalid can reach a running bot.
function parseStrategy(input) {
  const p = {};
  for (const k of STRATEGY_FIELDS) {
    if (input[k] === undefined || input[k] === null || String(input[k]).trim() === '') continue;
    const v = +input[k];
    if (!Number.isFinite(v)) throw new Error(`${k} must be a number`);
    p[k] = v;
  }
  const sym = String(input.symbol || '').trim().toUpperCase();
  if (/^[A-Z0-9]+USDT$/.test(sym)) p.symbol = sym;
  if (['manual', 'live', 'auto'].includes(input.fillMode)) p.fillMode = input.fillMode; // how orders are filled: by hand / live
  if (TFS.includes(input.tf)) p.tf = input.tf;
  if (input.marginMode === 'crossed' || input.marginMode === 'isolated') p.marginMode = input.marginMode;
  const e = input.entry;
  if (e && (e.mode === 'maker' || e.mode === 'taker')) p.entry = { mode: e.mode }; // the first-order mode; never the limit price, which follows the market when a bot is made
  else if (e && Array.isArray(e.groups) && e.groups.length) p.entry = JSON.parse(JSON.stringify({ logic: e.logic === 'and' ? 'and' : 'or', window: Math.round(+e.window) || 3, groups: e.groups }));
  return p;
}
const listStrategies = () => db.listStrategies();
const saveStrategies = all => db.saveStrategies(all);

module.exports = { listStrategies, saveStrategies, parseStrategy, patch, TFS, SIGNALS, list, save, cfgFor, find, validate, parseSignal, parseEntry };
