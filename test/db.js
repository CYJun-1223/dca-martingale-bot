// db.js against a real PostgreSQL: the test database soxxbot_test (DATABASE_URL from .env with the database name swapped,
// so the live data is never touched). Run: node test/db.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const envFile = path.join(__dirname, '..', '.env');
for (const line of fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.DATABASE_URL) { console.log('db: skipped (no DATABASE_URL)'); process.exit(0); }
process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, '/soxxbot_test$1');
const db = require('../apps/server/db');
const { Engine } = require('../apps/server/engine');
const { Recorder, toCsv, HEADER } = require('../apps/server/recorder');
const { Bus } = require('../apps/server/events');

(async () => {
  await db.migrate();
  await db.q('truncate bots, strategies, watches, bot_state, watch_state, trades, commands restart identity');

  // settings lists keep their order; a removed record is gone; an edit replaces it
  await db.saveBots([{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }]);
  assert.deepStrictEqual((await db.listBots()).map(b => b.id), ['b', 'a']);
  await db.saveBots([{ id: 'a', name: 'A2' }]);
  assert.deepStrictEqual(await db.listBots(), [{ id: 'a', name: 'A2' }]);
  await db.saveStrategies([{ id: 's', name: 'S', params: { tpPct: 2 } }]);
  assert.deepStrictEqual(await db.listStrategies(), [{ id: 's', name: 'S', params: { tpPct: 2 } }]);

  // the engine saves its whole state through the store; a save is taken at the moment of the call
  const store = { saveState: st => db.saveState('a', st), takeCommands: () => db.takeCommands('a'), hasCommands: () => db.hasCommands('a') };
  const e = new Engine({ symbol: 'X', logFile: 'x.log', leverage: 10 }, { market: {}, executor: {} }, { dir: require('os').tmpdir(), quiet: true, store, state: await db.loadState('a') });
  e.st.pos = { id: 1, orders: [{ n: 0, px: 639.4, qty: 0.02 }], qty: 0.02, cost: 12.788, plan: { maxAdds: 20, adds: [{ k: 1, px: 633.96, qty: 0.02 }] } };
  const saving = e.save(); e.st.pos.qty = 99; await saving;
  assert.strictEqual((await db.loadState('a')).pos.qty, 0.02, 'the state as it was when save() was called');
  assert.deepStrictEqual((await db.loadState('a')).pos.plan.adds, [{ k: 1, px: 633.96, qty: 0.02 }], 'pos.plan stored as it is');
  const row = await db.botStateRow('a');
  assert.ok(Date.now() - row.at < 60e3, 'updated_at tells the dashboard the bot is alive');

  // commands: the dashboard adds, the bot takes them all once, in order
  await db.addCommand('a', { type: 'stop', px: 90 }); await db.addCommand('a', { type: 'disarm', what: 'stop' });
  assert.strictEqual(await e.hasCommands(), true);
  assert.strictEqual((await db.pendingCommands('a')).length, 2);
  await e.applyCommands();
  assert.strictEqual(await e.hasCommands(), false, 'taken');
  assert.ok(!(await db.loadState('a')).armed.stop, 'stop armed then disarmed, saved');

  // trade ledger: one row per event, the CSV download gives the same columns as before
  const bus = new Bus({ onError: err => { throw err; } });
  new Recorder('a').attach(bus);
  await bus.emit('open', { ts: Date.UTC(2026, 9, 8, 4, 0), symbol: 'SMHUSDT', id: 3, n: 0, qty: 0.02, px: 639.4, avg: 639.4, margin: 1.836, mode: 'LIVE', pdp: 2 }).done;
  await new Promise(r => setTimeout(r, 200)); // the recorder writes in the background
  const rows = await db.tradesOf('a');
  assert.strictEqual(rows.length, 1);
  const csv = toCsv(rows).split('\n');
  assert.strictEqual(csv[0] + '\n', HEADER);
  assert.match(csv[1], /,SMHUSDT,3,open,0,0\.02,639\.4,1\.84,639\.4,,/);

  // fail closed: a database that can't be reached makes save() throw, so an order tracked "before sending" is never sent
  const bad = { saveState: () => Promise.reject(new Error('database away')) };
  const e2 = new Engine({ symbol: 'X', logFile: 'x.log' }, { market: {}, executor: {} }, { dir: require('os').tmpdir(), quiet: true, store: bad });
  await assert.rejects(e2.save(), /database away/);

  await db.end();
  console.log('db: settings, state, commands, trade ledger and fail-closed save work against PostgreSQL');
})().catch(err => { console.error(err); process.exit(1); });
