// Characterization test for the dashboard server (apps/server/web.js): sends one fixed list of HTTP requests and compares the
// answers with test/web.golden.json (recorded from the code before the web layer was split up).
//   node test/web.js                 compare with the golden file
//   node test/web.js --record        rewrite the golden file (only after a deliberate behaviour change)
// Safe to run next to a live bot: the server code is copied to a temp folder, the database is an in-memory fake and the
// exchange answers come from a fake fetch, so no real database, exchange, runtime/ folder or STOP_ALL file is touched.
// Env: SERVER_DIR = another apps/server folder to test (e.g. an older copy), GOLDEN = another golden file path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const SERVER_DIR = path.resolve(process.env.SERVER_DIR || path.join(__dirname, '..', 'apps', 'server'));
const GOLDEN = process.env.GOLDEN || path.join(__dirname, 'web.golden.json');

// ============================== child: the dashboard with a fake database and a fake exchange ==============================
function child(root, args) {
  const serverDir = path.join(root, 'apps', 'server');
  const now = Date.now();
  const rec = { id: 't2', name: 'T2', broker: 'bitget', symbol: 'SMHUSDT', tf: '1H', leverage: 3, marginMode: 'crossed',
    entry: { mode: 'taker', logic: 'or', window: 3, groups: [], volatility: null }, investment: 100, maxAdds: 5, stepPct: 1, stepMult: 1,
    amountMult: 1, tpPct: 2, usMarketHoursOnly: false, fillMode: 'auto', maxCycles: 0, dryRun: true, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' };
  const pos = { id: 1, openedAt: '2026-01-01T00:00:00.000Z', orders: [{ n: 0, ts: now, px: 600, qty: 0.1, margin: 10 }], qty: 0.1, cost: 60,
    plan: { maxAdds: 5, adds: [{ k: 1, px: 594, qty: 0.11 }] } };
  const clone = x => JSON.parse(JSON.stringify(x));
  const T = { bots: [rec], watches: [], strategies: [], state: { t2: { seq: 1, pos, realizedPnl: 0, history: [], manualOrders: [], armed: {}, live: null, lastCheck: { ts: now, price: 600 } } },
    stateAt: { t2: now }, cmds: [], trades: { t2: [{ id: 1, bot_id: 't2', ts: new Date(1700000000000), symbol: 'SMHUSDT', cycle: 1, action: 'open', ord: 0, qty: '0.1', price: '600', margin: '10', avg_price: '600', pnl: null, opened_at: null, held: null, mode: 'alert' }] } };
  const fake = {
    q: async () => ({ rows: [] }), migrate: async () => {}, end: async () => {},
    listBots: async () => clone(T.bots), saveBots: async rows => { T.bots = clone(rows); },
    listWatches: async () => clone(T.watches), saveWatches: async rows => { T.watches = clone(rows); },
    listStrategies: async () => clone(T.strategies), saveStrategies: async rows => { T.strategies = clone(rows); },
    loadState: async id => clone(T.state[id] || null), saveState: async (id, st) => { T.state[id] = clone(st); T.stateAt[id] = Date.now(); },
    loadWatchState: async () => null, saveWatchState: async () => {},
    botStateRow: async id => ({ state: clone(T.state[id] || null), at: T.stateAt[id] || 0 }), watchStateRow: async () => ({ state: null, at: 0 }),
    topicOf: async () => null, saveTopic: async () => {}, addTrade: async () => {}, tradesOf: async id => clone(T.trades[id] || []),
    addCommand: async (botId, cmd) => { T.cmds.push({ botId, cmd: clone(cmd) }); },
    takeCommands: async () => [], pendingCommands: async botId => T.cmds.filter(c => c.botId === botId).map(c => clone(c.cmd)), hasCommands: async () => false,
  };
  const dbPath = require.resolve(path.join(serverDir, 'db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fake, children: [], paths: [] };
  const contract = sym => ({ symbol: sym, sizeMultiplier: '0.01', minTradeNum: '0.01', volumePlace: '2', pricePlace: '2', minTradeUSDT: '5', maxLever: '25', minLever: '1', symbolStatus: 'normal' });
  const reply = (data, code = '00000', msg = '') => ({ ok: true, status: 200, text: async () => JSON.stringify({ code, msg, data }), json: async () => ({ code, msg, data }) });
  global.fetch = async url => {
    const u = String(url);
    if (u.includes('/market/contracts')) return u.includes('symbol=NOPEUSDT') ? reply(null, '40309', 'The contract has been removed') : reply([contract(new URL(u).searchParams.get('symbol'))]);
    if (u.includes('/market/ticker')) return reply([{ lastPr: '600' }]);
    if (u.includes('current-fund-rate')) return reply([{ fundingRate: '0.0001', fundingRateInterval: '8', nextUpdate: '1700000000000' }]);
    throw new Error(`fake exchange: no answer for ${u}`);
  };
  process.env.WEB_USER = 'admin'; process.env.WEB_PASSWORD = 'pw';
  process.env.STOP_FILE = path.join(root, 'runtime', 'STOP_ALL');
  for (const k of ['LIVE_TRADING', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'BITGET_API_KEY', 'BINANCE_API_KEY', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD']) delete process.env[k];
  process.argv = [process.argv[0], path.join(serverDir, 'web.js'), ...args];
  require(path.join(serverDir, 'web.js'));
}

// ============================== parent: the request list ==============================
const BOT = { id: 't1', name: 'T1', symbol: 'SMHUSDT', tf: '1H', leverage: 3, entry: { mode: 'taker' }, investment: 150, maxAdds: 5, stepPct: 1, stepMult: 1, amountMult: 1.1, tpPct: 2 };
const WATCH = { id: 'w1', name: 'W1', symbol: 'SMHUSDT', tf: '1H', entry: { logic: 'or', window: 3, groups: [{ logic: 'or', signals: [{ type: 'boll-revert', period: 20, mult: 2 }] }] } };
const NOAUTH = { auth: false };
const EDIT = [
  ['app: index page', 'GET', '/'], ['app: manifest without login', 'GET', '/manifest.webmanifest', null, NOAUTH], ['app: icon without login', 'GET', '/icon.svg', null, NOAUTH],
  ['app: unknown hashed asset', 'GET', '/assets/index-abc.js'], ['login: no credentials', 'GET', '/api/bots', null, NOAUTH],
  ['login: wrong password', 'GET', '/api/bots', null, { auth: 'admin:nope' }], ['unknown GET', 'GET', '/nope'], ['unknown POST', 'POST', '/nope', {}],
  ['list at start', 'GET', '/api/bots'],
  ['check symbol ok', 'GET', '/api/check/SMHUSDT?broker=bitget&leverage=3'], ['check symbol: leverage too high', 'GET', '/api/check/SMHUSDT?broker=bitget&leverage=50'],
  ['check symbol: unknown broker', 'GET', '/api/check/SMHUSDT?broker=zzz&leverage=3'], ['check symbol: missing query', 'GET', '/api/check/SMHUSDT'],
  ['check symbol: not on exchange', 'GET', '/api/check/NOPEUSDT?broker=bitget&leverage=3'],
  ['price default broker', 'GET', '/api/price/SMHUSDT'], ['price bitget', 'GET', '/api/price/SMHUSDT?broker=bitget'],
  ['create bot', 'POST', '/api/bots', BOT], ['create bot: duplicate id', 'POST', '/api/bots', BOT], ['create bot: symbol not on exchange', 'POST', '/api/bots', { ...BOT, id: 't3', symbol: 'NOPEUSDT' }],
  ['create bot: invalid', 'POST', '/api/bots', { ...BOT, id: 't4', investment: 0 }], ['create bot: live refused while LIVE_TRADING is off', 'POST', '/api/bots', { ...BOT, id: 't5', dryRun: false }],
  ['create bot: bad json', 'POSTRAW', '/api/bots', '{nope'],
  ['list with bots', 'GET', '/api/bots'],
  ['invest', 'POST', '/api/bots/t1/invest', { add: 50 }], ['invest: zero', 'POST', '/api/bots/t1/invest', { add: 0 }], ['invest: unknown bot', 'POST', '/api/bots/zz/invest', { add: 5 }],
  ['tp', 'POST', '/api/bots/t1/tp', { tpPct: 3 }], ['tp: invalid', 'POST', '/api/bots/t1/tp', { tpPct: 0 }], ['tp: unknown bot', 'POST', '/api/bots/zz/tp', { tpPct: 3 }],
  ['cycles', 'POST', '/api/bots/t1/cycles', { maxCycles: 5 }], ['cycles: same value', 'POST', '/api/bots/t1/cycles', { maxCycles: 5 }], ['cycles: lower', 'POST', '/api/bots/t1/cycles', { maxCycles: 2 }],
  ['cycles: unknown bot', 'POST', '/api/bots/zz/cycles', { maxCycles: 5 }],
  ['maxadds quote', 'GET', '/api/bots/t1/maxadds?to=8'], ['maxadds quote: too high', 'GET', '/api/bots/t1/maxadds?to=21'], ['maxadds quote: no target', 'GET', '/api/bots/t1/maxadds'],
  ['maxadds apply', 'POST', '/api/bots/t1/maxadds', { maxAdds: 8 }], ['maxadds apply: not higher', 'POST', '/api/bots/t1/maxadds', { maxAdds: 8 }], ['maxadds: unknown bot', 'GET', '/api/bots/zz/maxadds?to=8'],
  ['manual market order', 'POST', '/api/bots/t2/manual', { side: 'buy', orderType: 'market', qty: 1 }], ['manual limit order', 'POST', '/api/bots/t2/manual', { side: 'sell', orderType: 'limit', px: 650, qty: 0.5 }],
  ['manual: no qty', 'POST', '/api/bots/t2/manual', { side: 'buy', orderType: 'market' }], ['manual: limit without price', 'POST', '/api/bots/t2/manual', { side: 'buy', orderType: 'limit', qty: 1 }],
  ['manual: cancel', 'POST', '/api/bots/t2/manual', { cancel: 'm1' }], ['manual: typed fill', 'POST', '/api/bots/t2/manual', { fill: true, side: 'buy', px: 590, qty: 0.2 }],
  ['manual: typed fill invalid', 'POST', '/api/bots/t2/manual', { fill: true, side: 'buy', px: 0, qty: 0.2 }], ['manual: unknown bot', 'POST', '/api/bots/zz/manual', { qty: 1 }],
  ['action: close at price', 'POST', '/api/bots/t2/action', { action: 'close', px: 650 }], ['action: close at current price', 'POST', '/api/bots/t2/action', { action: 'close', px: 600 }],
  ['action: close now', 'POST', '/api/bots/t2/action', { action: 'close' }], ['action: close with limit', 'POST', '/api/bots/t2/action', { action: 'close', how: 'limit', px: 700 }],
  ['action: close limit without price', 'POST', '/api/bots/t2/action', { action: 'close', how: 'limit' }], ['action: close hold', 'POST', '/api/bots/t2/action', { action: 'close', how: 'hold' }],
  ['action: stop at price', 'POST', '/api/bots/t2/action', { action: 'stop', px: 500 }], ['action: bad price', 'POST', '/api/bots/t2/action', { action: 'close', px: -3 }],
  ['action: disarm', 'POST', '/api/bots/t2/action', { action: 'disarm', what: 'stop' }], ['action: disarm nothing', 'POST', '/api/bots/t2/action', { action: 'disarm', what: 'x' }],
  ['action: unknown', 'POST', '/api/bots/t2/action', { action: 'explode' }], ['action: unknown bot', 'POST', '/api/bots/zz/action', { action: 'stop' }],
  ['action: close on bot that is not running', 'POST', '/api/bots/t1/action', { action: 'close' }], ['action: stop now', 'POST', '/api/bots/t1/action', { action: 'stop' }],
  ['start', 'POST', '/api/bots/t1/start', {}], ['stop', 'POST', '/api/bots/t1/stop', {}], ['start: unknown bot', 'POST', '/api/bots/zz/start', {}],
  ['edit bot', 'PUT', '/api/bots/t1', { ...BOT, name: 'Renamed' }], ['edit bot: change symbol while stopped', 'PUT', '/api/bots/t1', { ...BOT, symbol: 'SOXXUSDT' }],
  ['edit bot: change symbol to unknown', 'PUT', '/api/bots/t1', { ...BOT, symbol: 'NOPEUSDT' }], ['edit bot: unknown bot', 'PUT', '/api/bots/zz', BOT],
  ['edit running bot symbol', 'PUT', '/api/bots/t2', { ...rec2(), symbol: 'SOXXUSDT' }],
  ['trades csv', 'GET', '/api/bots/t2/trades.csv'], ['trades csv: none yet', 'GET', '/api/bots/t1/trades.csv'], ['trades csv: unknown bot', 'GET', '/api/bots/zz/trades.csv'],
  ['stop all on', 'POST', '/api/stop-all', { on: true }], ['list shows stop all', 'GET', '/api/bots'], ['stop all off', 'POST', '/api/stop-all', { on: false }],
  ['strategy: save', 'POST', '/api/strategies', { name: 'My Strat', params: { investment: 100, maxAdds: 4 } }], ['strategy: no name', 'POST', '/api/strategies', { params: {} }],
  ['strategy: delete', 'DELETE', '/api/strategies/my-strat'],
  ['watch: create', 'POST', '/api/watches', WATCH], ['watch: duplicate', 'POST', '/api/watches', WATCH], ['watch: symbol not on exchange', 'POST', '/api/watches', { ...WATCH, id: 'w2', symbol: 'NOPEUSDT' }],
  ['watch: edit', 'PUT', '/api/watches/w1', { ...WATCH, name: 'Renamed' }], ['watch: stop', 'POST', '/api/watches/w1/stop', {}], ['watch: start', 'POST', '/api/watches/w1/start', {}],
  ['watch: test message without Telegram', 'POST', '/api/watches/w1/test', {}], ['watch: unknown id', 'PUT', '/api/watches/zz', WATCH], ['watch: unknown id start', 'POST', '/api/watches/zz/start', {}],
  ['list with watch', 'GET', '/api/bots'], ['watch: delete', 'DELETE', '/api/watches/w1'],
  ['delete bot: still enabled', 'DELETE', '/api/bots/t2'], ['delete bot: stopped', 'DELETE', '/api/bots/t1'], ['delete bot: unknown', 'DELETE', '/api/bots/zz'],
  ['stop t2', 'POST', '/api/bots/t2/stop', {}], ['delete bot: open cycle', 'DELETE', '/api/bots/t2'], ['list at end', 'GET', '/api/bots'],
  // an app file that is missing on disk (sw.js is not created in the test folder) is a 404; it used to crash the server
  ['app: file missing on disk', 'GET', '/sw.js', null, NOAUTH], ['still alive afterwards', 'GET', '/api/bots/t2/trades.csv'],
];
const READONLY = [
  ['view-only: list', 'GET', '/api/bots'], ['view-only: index page', 'GET', '/'], ['view-only: create', 'POST', '/api/bots', BOT], ['view-only: stop all', 'POST', '/api/stop-all', { on: true }],
  ['view-only: edit', 'PUT', '/api/bots/t2', BOT], ['view-only: delete', 'DELETE', '/api/bots/t2'], ['view-only: maxadds quote', 'GET', '/api/bots/t2/maxadds?to=8'],
  ['view-only: csv download', 'GET', '/api/bots/t2/trades.csv'], ['view-only: unknown POST', 'POST', '/nope', {}],
];
function rec2() { return { id: 't2', name: 'T2', symbol: 'SMHUSDT', tf: '1H', leverage: 3, entry: { mode: 'taker' }, investment: 100, maxAdds: 5, stepPct: 1, stepMult: 1, amountMult: 1, tpPct: 2 }; }

const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
// times change from run to run: ISO dates and millisecond stamps become fixed words
const scrub = v => typeof v === 'string' ? v.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'ISO').replace(/(?<!\d)1[67]\d{11}(?!\d)/g, 'MS')
  : typeof v === 'number' ? (Number.isInteger(v) && v >= 1e12 && v < 2e12 ? 'MS' : v)
  : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
function request(port, [label, method, url, body, opt = {}]) {
  return new Promise((resolve, reject) => {
    const raw = method === 'POSTRAW', payload = body == null ? '' : raw ? body : JSON.stringify(body);
    const headers = {}; if (payload) headers['Content-Type'] = 'application/json';
    if (opt.auth !== false) headers.Authorization = 'Basic ' + Buffer.from(opt.auth || 'admin:pw').toString('base64');
    const req = http.request({ host: '127.0.0.1', port, path: url, method: raw ? 'POST' : method, headers }, res => {
      let s = ''; res.setEncoding('utf8'); res.on('data', d => { s += d; });
      res.on('end', () => {
        const type = (res.headers['content-type'] || '').split(';')[0];
        let out; if (type === 'application/json') { try { out = canon(JSON.parse(s)); } catch { out = s; } } else out = s;
        const h = Object.fromEntries(['content-type', 'cache-control', 'content-disposition', 'www-authenticate'].filter(k => res.headers[k]).map(k => [k, res.headers[k]]));
        resolve({ label, request: `${raw ? 'POST' : method} ${url}`, status: res.statusCode, headers: h, body: scrub(out) });
      });
    });
    req.on('error', reject); req.end(payload);
  });
}

async function runMode(root, name, extraArgs, port, list) {
  const kid = spawn(process.execPath, [__filename, '--child', root, `--port=${port}`, '--no-watchdog', ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC' } }); // UTC: the CSV prints local times
  let err = ''; kid.stderr.on('data', d => { err += d; });
  await new Promise((res, rej) => { kid.stdout.on('data', d => { if (String(d).includes('dashboard:')) res(); }); kid.on('exit', c => rej(new Error(`server exited (${c}): ${err}`))); setTimeout(() => rej(new Error('server did not start: ' + err)), 15000); });
  const out = [];
  try { for (const r of list) { try { out.push(await request(port, r)); } catch (e) { throw new Error(`request "${r[0]}" failed: ${e.message}\n${err}`); } } } finally { kid.kill(); }
  return { mode: name, results: out };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soxx-web-test-'));
  try {
    fs.cpSync(SERVER_DIR, path.join(root, 'apps', 'server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps', 'web', 'dist', 'assets'), { recursive: true }); fs.mkdirSync(path.join(root, 'apps', 'web', 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'web', 'dist', 'index.html'), '<html>dashboard</html>');
    fs.writeFileSync(path.join(root, 'apps', 'web', 'public', 'manifest.webmanifest'), '{"name":"test"}');
    fs.writeFileSync(path.join(root, 'apps', 'web', 'public', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const got = [await runMode(root, 'edit', [], await freePort(), EDIT), await runMode(root, 'readonly', ['--readonly'], await freePort(), READONLY)];
    // `defaults` is config.js as it is today: not part of what this test pins down
    for (const m of got) for (const r of m.results) if (r.body && r.body.defaults) r.body.defaults = '(config.js)';
    if (process.argv.includes('--record')) { fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n'); console.log(`recorded ${got.reduce((n, m) => n + m.results.length, 0)} answers in ${GOLDEN}`); return; }
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')); let bad = 0, n = 0;
    for (const [mi, m] of got.entries()) for (const [i, r] of m.results.entries()) {
      n++; const w = want[mi] && want[mi].results[i];
      if (!w || JSON.stringify(w) !== JSON.stringify(r)) { bad++; console.log(`  FAIL ${r.label}: ${r.request}\n    want ${JSON.stringify(w && { status: w.status, body: w.body }).slice(0, 300)}\n    got  ${JSON.stringify({ status: r.status, body: r.body }).slice(0, 300)}`); }
    }
    if (bad) { console.log(`${bad} of ${n} answers differ`); process.exit(1); }
    console.log(`all ${n} dashboard answers match the recorded ones`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[2] === '--child') child(process.argv[3], process.argv.slice(4)); else main().catch(e => { console.error(e); process.exit(1); });
