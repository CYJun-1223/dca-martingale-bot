#!/usr/bin/env node
// Runs every enabled bot (and alert watch) from the database, each on its own schedule, in one process.
// Start / Stop on the dashboard just flips `enabled`; this picks it up within seconds.
// Each bot's state is in the database, so an open cycle survives restarts and code updates.
//   node apps/server/runner.js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..'), RUNTIME = path.join(ROOT, 'runtime'); // logs, traces and the STOP_ALL switch live in runtime/
fs.mkdirSync(RUNTIME, { recursive: true });

require('./env').loadEnv(ROOT); // .env -> process.env

const { Bitget } = require('./bitget');
const { Binance } = require('./binance');
const { createMarket, checkTfFor, nextCheckAt } = require('./market');
const { createExecutor } = require('./executor');
const { Alerts } = require('./alerts');
const { Recorder } = require('./recorder');
const { Bus } = require('./events');
const { Engine, localTime } = require('./engine');
const S = require('./strategy');
const bots = require('./bots');
const watches = require('./watches');
const { runWatch } = require('./watcher');
const db = require('./db');

const api = new Bitget({
  key: process.env.BITGET_API_KEY, secret: process.env.BITGET_API_SECRET,
  passphrase: process.env.BITGET_PASSPHRASE, demo: process.env.BITGET_DEMO === '1',
});
const binance = new Binance({ key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isEnabled = b => b.enabled !== false; // bots saved before Start/Stop existed are running ones

// one bot's loop: runs until wanted() says stop (disabled, deleted, or the process is shutting down)
async function runBot(record, wanted) {
  let bot = record;
  const cfg = bots.cfgFor(bot);
  const market = createMarket(cfg, api);
  const bus = new Bus(), alerts = new Alerts(cfg, { dir: RUNTIME, botId: bot.id });
  alerts.attach(bus);
  Recorder.forBot(cfg).attach(bus);
  // the bot's state and the dashboard's commands live in the database (db.js)
  const store = { saveState: st => db.saveState(bot.id, st), takeCommands: () => db.takeCommands(bot.id), hasCommands: () => db.hasCommands(bot.id) };
  const e = new Engine(cfg, { market, executor: createExecutor(cfg, { bitget: api, binance }, market), bus }, { dir: RUNTIME, store, state: await db.loadState(bot.id) });
  await e.init();
  // live: set one-way / cross / leverage on the account before any order; a failure stops this bot (retried in 60s)
  if (e.executor.live) for (const line of await e.executor.setup()) e.log('INFO', line);
  if (e.migrated) {
    const L = S.levels(e.st.pos, cfg);
    e.log('WARN', `kept ${e.migrated} open position(s) from the previous strategy as cycle #${e.st.pos.id} (state backed up)`);
    e.emit('error', { message: `Strategy changed: the open position (${e.st.pos.qty} @ ${L.avg.toFixed(2)}, opened ${localTime(e.st.pos.openedAt)}) was kept as cycle #${e.st.pos.id}. TP ${L.tp.toFixed(2)}, next add ${L.nextAdd ? L.nextAdd.toFixed(2) : 'none'}.` });
  }
  e.log('INFO', `started ${cfg.dryRun ? 'ALERT' : 'LIVE'} ${cfg.symbol} ${cfg.tf} (checks ${S.checkEvery(cfg, !!e.st.pos) === '15s' ? 'every 15s' : `when each ${S.signalTf(cfg)} candle closes`}) entry=${S.describeEntry(S.entryOf(cfg))} ${e.st.pos ? `cycle #${e.st.pos.id} open` : 'no cycle'}`);
  e.emit('start', { checkTf: S.signalTf(cfg), entry: S.entryOf(cfg), investment: cfg.investment, maxAdds: cfg.maxAdds, stepPct: cfg.stepPct,
    stepMult: cfg.stepMult, amountMult: cfg.amountMult, tpPct: cfg.tpPct, open: e.st.pos ? e.st.pos.id : null });

  let errors = 0;
  while (wanted()) {
    // pick up edits made in the dashboard; symbol / broker / leverage / mode never change for a running bot
    const fresh = (await bots.list()).find(b => b.id === bot.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(bot)) {
      const keep = { symbol: cfg.symbol, broker: cfg.broker, leverage: cfg.leverage, marginMode: cfg.marginMode, dryRun: cfg.dryRun };
      Object.assign(cfg, bots.cfgFor(fresh), keep);
      bot = fresh;
      e.log('INFO', 'settings updated');
    }
    try {
      const r = await e.tick();
      if (r && r.action) { // armed stop / close reached: turn the bot off (a closed bot stays closed)
        await bots.patch(bot.id, r.action === 'close' ? { enabled: false, closedAt: new Date().toISOString() } : { enabled: false });
        break;
      }
      if (errors >= 3) e.emit('error', { message: `Back to normal after ${errors} failed checks.`, recovered: true });
      errors = 0;
    } catch (err) {
      errors++;
      e.log('ERROR', `check failed (${errors}): ${err.message}`);
      if (errors === 3) e.emit('error', { message: `3 checks in a row failed: ${err.message}` });
    }
    // open cycle / limit / market entry: every 15 s; indicator with no cycle: when its K-line closes (S.checkWait); errors back off
    const wait = errors ? Math.min(15e3 * 2 ** errors, 10 * 60e3) : S.checkWait(cfg, !!e.st.pos, Date.now());
    // wake early when the dashboard queues a command or edits this bot (only while checks are healthy)
    const edited = async () => { const f = (await bots.list()).find(b => b.id === bot.id); return f && JSON.stringify(f) !== JSON.stringify(bot); };
    for (let t = 0; t < wait && wanted(); t += 1000) {
      await sleep(Math.min(1000, wait - t));
      try { if (!errors && (await e.hasCommands() || await edited())) break; } catch { /* database away: the next check reports it */ }
    }
  }
  // switched off on the dashboard (not a runner restart): the resting buys must not keep filling unwatched
  const rec = (await bots.list()).find(b => b.id === bot.id);
  if (!rec || rec.enabled === false) {
    try { await e.onStop(); } catch (err) { e.log('ERROR', `could not cancel the resting orders: ${err.message}`); }
  }
  e.log('INFO', 'stopped');
  e.emit('stop');
}

// ---- supervisor: keep one loop per enabled bot ----
const loops = new Map(); // id -> { stop: bool, done: Promise }
const retryAt = new Map(); // id -> time a crashed bot may start again
let shuttingDown = false;

// bots and alert-only watches share the supervisor; a watch's key is "w:<id>"
async function sync() {
  let items;
  try {
    items = [...(await bots.list()).map(r => ({ key: r.id, rec: r, run: (wanted) => runBot(r, wanted) })),
      ...(await watches.list()).map(r => ({ key: 'w:' + r.id, rec: r, run: (wanted) => runWatch(r, wanted, { api, dir: RUNTIME }) }))];
  } catch (e) { console.error(`${localTime(Date.now())} can't read the bots: ${e.message}`); return; } // database away: next pass
  const want = new Set(items.filter(i => isEnabled(i.rec)).map(i => i.key));
  for (const i of items) {
    if (!want.has(i.key) || loops.has(i.key) || shuttingDown || (retryAt.get(i.key) || 0) > Date.now()) continue;
    const ctl = { stop: false };
    ctl.done = i.run(() => !ctl.stop && !shuttingDown)
      .catch(err => { console.error(`${localTime(Date.now())} ${i.key} failed: ${err.message}`); retryAt.set(i.key, Date.now() + 60e3); })
      .finally(() => { loops.delete(i.key); });
    loops.set(i.key, ctl);
    console.log(`${localTime(Date.now())} started ${i.key}`);
  }
  for (const [id, ctl] of loops) if (!want.has(id) && !ctl.stop) { ctl.stop = true; console.log(`${localTime(Date.now())} stopping ${id}`); }
}

async function main() {
  console.log(`${localTime(Date.now())} runner started`);
  await db.migrate(); // creates the tables on first use
  await sync();
  let syncing = false;
  const timer = setInterval(async () => { if (syncing) return; syncing = true; try { await sync(); } finally { syncing = false; } }, 5e3);
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true; clearInterval(timer);
    await Promise.all([...loops.values()].map(l => l.done));
    await sleep(3000); // let the last alerts go out
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

if (require.main === module) main().catch(e => { console.error(`${localTime(Date.now())} runner could not start: ${e.message}`); process.exit(1); }); // no database = no trading
module.exports = { runBot, isEnabled };
