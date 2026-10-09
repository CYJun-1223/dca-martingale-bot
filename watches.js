// Alert-only watches: follow an indicator set on a symbol and send a Telegram message when it fires.
// No orders, no ladder: the user trades by hand. One record per watch (database table watches).
const base = require('./config');
const bots = require('./bots');
const { TF_MS, BROKERS } = require('./market');
const S = require('./strategy');
const db = require('./db');

const list = () => db.listWatches();
const save = all => db.saveWatches(all);

// full config for one watch (own state / alert files, never shared with a bot)
function cfgFor(w) {
  return { ...base, logFile: `watch-${w.id}.log`, alertsFile: `alerts-watch-${w.id}.log`, dryRun: true, ...w };
}

// an alert is one flat list of indicators (up to 5); any one of them firing sends the alert
function flatEntry(e) {
  const signals = e.groups.flatMap(g => g.signals);
  if (signals.length > 5) throw new Error('an alert can have up to 5 indicators: use another alert for more');
  return { logic: 'or', window: 3, groups: [{ logic: 'or', signals }], volatility: null };
}

function validate(input, existing, prev = null) {
  const id = prev ? prev.id : String(input.id || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new Error('id: lowercase letters, digits and "-" only');
  if (!prev && existing.some(x => x.id === id)) throw new Error(`id "${id}" already exists`);
  const symbol = prev ? prev.symbol : String(input.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) throw new Error('symbol must look like SOXXUSDT');
  const broker = prev ? prev.broker || 'bitget' : String(input.broker || 'bitget');
  if (!BROKERS[broker]) throw new Error(`broker must be one of ${Object.keys(BROKERS).join(', ')}`);
  if (!bots.TFS.includes(input.tf)) throw new Error(`tf must be one of ${bots.TFS.join(', ')}`);
  const checkTf = input.checkTf || undefined;
  if (checkTf && !(bots.TFS.includes(checkTf) && TF_MS[checkTf] < TF_MS[input.tf])) throw new Error('checkTf must be a timeframe smaller than tf');
  const w = {
    id,
    name: String(input.name || id).trim().slice(0, 60),
    broker, symbol, tf: input.tf, checkTf,
    entry: flatEntry(bots.parseEntry(input.entry)),
    enabled: prev ? prev.enabled !== false : true,
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
  };
  if (prev) w.updatedAt = new Date().toISOString();
  if (!w.checkTf) delete w.checkTf;
  return w;
}

// An alert only has to look when a candle has closed, so it follows the shortest K-line its indicators use
// (the default K-line for those without their own): 1H only = every hour, a 15m indicator in the mix = every 15 minutes.
function watchTf(cfg) {
  return S.distinctTfs(S.entryOf(cfg), cfg.tf).sort((a, b) => TF_MS[a] - TF_MS[b])[0];
}

// the entry with every condition's K-line spelled out, so the shortest K-line can be the timeline
function explicitEntry(cfg) {
  const e = S.entryOf(cfg);
  return { ...e, groups: e.groups.map(g => ({ ...g, signals: g.signals.map(s => ({ ...s, tf: s.tf || cfg.tf })) })) };
}

// alerts on one symbol share one Telegram topic (titled e.g. SOXX)
const topic = w => ({ key: `symbol:${w.symbol}`, title: w.symbol.replace(/USDT$/, '') });

module.exports = { list, save, cfgFor, validate, watchTf, explicitEntry, topic };
