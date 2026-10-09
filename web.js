#!/usr/bin/env node
// Dashboard: bot parameters + live state; create / edit / delete bots in bots.json.
// Running bots pick up edits on their next tick (id, symbol, leverage and paper/live are fixed).
//   node web.js                 http://127.0.0.1:8787
//   node web.js --host=0.0.0.0  also reachable over your LAN / VPN
//   node web.js --readonly      view only (no create / edit / delete)
// Needs WEB_PASSWORD in .env. Public access goes through a Cloudflare Tunnel (see HANDOFF.md).
// Read-only toward Bitget (public prices only). It never starts bots or places orders.
const fs = require('fs');
const http = require('http');
const path = require('path');
const bots = require('./bots');
const watches = require('./watches');
const S = require('./strategy');
const { Bitget } = require('./bitget');
const { Binance } = require('./binance');
const { Alerts } = require('./alerts');
const { toCsv } = require('./recorder');
const db = require('./db');
const { TF_MS, checkTfFor, nextCheckAt, createMarket, BROKERS } = require('./market');
const { liveEnabled, STOP_FILE } = require('./executor');

const DIR = __dirname;
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const HOST = args.host || '127.0.0.1';
const PORT = +(args.port || 8787);
const EDIT = !args.readonly; // --readonly hides create / edit / delete
const DIST = path.join(DIR, args.dist || 'dist'); // the built dashboard (--dist <dir> to try another build)
const api = new Bitget({});

// ---- login: WEB_USER / WEB_PASSWORD from .env (HTTP basic auth; serve over https only) ----
const envFile = path.join(DIR, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const USER = process.env.WEB_USER || 'admin', PASS = process.env.WEB_PASSWORD;
if (!PASS && !args['no-auth']) {
  console.error('Set WEB_PASSWORD in .env (or pass --no-auth for local-only use).');
  process.exit(1);
}
const crypto = require('crypto');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// ---- Cloudflare Access: a valid Cf-Access-Jwt-Assertion replaces the password ----
// CF_ACCESS_TEAM=<your-team>  CF_ACCESS_AUD=<application audience tag>  (both in .env)
const TEAM = process.env.CF_ACCESS_TEAM, AUD = process.env.CF_ACCESS_AUD;
let jwks = { at: 0, keys: [] };
async function accessKeys() {
  if (Date.now() - jwks.at < 3600e3 && jwks.keys.length) return jwks.keys;
  const r = await fetch(`https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`);
  jwks = { at: Date.now(), keys: (await r.json()).keys };
  return jwks.keys;
}
async function accessOk(token) {
  if (!TEAM || !AUD || !token) return false;
  try {
    const [h, p, s] = token.split('.');
    const head = JSON.parse(Buffer.from(h, 'base64url')), body = JSON.parse(Buffer.from(p, 'base64url'));
    const jwk = (await accessKeys()).find(k => k.kid === head.kid);
    if (!jwk || head.alg !== 'RS256') return false;
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    const now = Date.now() / 1000;
    return valid && [].concat(body.aud).includes(AUD) && body.exp > now
      && body.iss === `https://${TEAM}.cloudflareaccess.com`;
  } catch { return false; }
}

async function authorized(req) {
  if (!PASS) return true;
  if (await accessOk(req.headers['cf-access-jwt-assertion'])) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const [u, ...p] = Buffer.from(m[1], 'base64').toString().split(':');
  return same(u, USER) & same(p.join(':'), PASS);
}

// ---- prices (public ticker per broker, cached 10s per broker + symbol) ----
const priceCache = {};
const marketFor = (symbol, broker = 'bitget') => createMarket({ ...require('./config'), symbol, broker }, api);
// contract rules (qty step, minimums) so the dashboard shows the same quantities the bot will order; cached 1h
const contractCache = {};
async function contract(symbol, broker = 'bitget') {
  const key = `${broker}:${symbol}`, c = contractCache[key];
  if (c && Date.now() - c.at < 3600e3) return c.v;
  try {
    const r = await marketFor(symbol, broker).contract();
    const v = { step: +r.sizeMultiplier || Math.pow(10, -(+r.volumePlace)), qdp: +r.volumePlace, pdp: +r.pricePlace, minQty: +r.minTradeNum, minValue: +r.minTradeUSDT || 0 };
    contractCache[key] = { v, at: Date.now() };
    return v;
  } catch { return c ? c.v : null; }
}

// does the symbol exist on the broker, is it tradable, and does it allow this leverage (fresh read, not cached)
async function checkSymbol(symbol, broker, leverage) {
  const label = BROKERS[broker].label;
  let r;
  try { r = await marketFor(symbol, broker).contract(); } catch (e) { return { ok: false, message: `${symbol} is not available on ${label}: ${e.message}` }; }
  const maxLever = +r.maxLever || null, minLever = +r.minLever || 1, status = r.symbolStatus || 'normal', lev = +leverage;
  const out = { symbol, status, maxLever, minLever, minQty: +r.minTradeNum, minValue: +r.minTradeUSDT || 0, price: await price(symbol, broker), leverage: lev };
  if (status !== 'normal') return { ...out, ok: false, message: `${symbol} exists on ${label} but its status is "${status}", so it cannot be traded now.` };
  if (lev && (lev < minLever || (maxLever && lev > maxLever))) return { ...out, ok: false, message: `${symbol} exists on ${label}, but ${lev}x is not allowed: leverage must be ${minLever} to ${maxLever || '?'}x.` };
  return { ...out, ok: true, message: `${symbol} is on ${label}, trading, price ${out.price}. Leverage ${minLever} to ${maxLever || '?'}x${lev ? `: ${lev}x is allowed` : ''}. Minimum order ${out.minQty} (${out.minValue} USDT).` };
}

async function price(symbol, broker = 'bitget') {
  const key = `${broker}:${symbol}`, c = priceCache[key];
  if (c && Date.now() - c.at < 10e3) return c.px;
  try {
    const px = await marketFor(symbol, broker).lastPrice();
    priceCache[key] = { px, at: Date.now() };
    return px;
  } catch { return c ? c.px : null; }
}

// funding rate (Bitget public endpoint, cached 5 min): rate per interval and the next settlement
const fundingCache = {};
async function funding(symbol, broker = 'bitget') {
  if (broker !== 'bitget') return null;
  const c = fundingCache[symbol];
  if (c && Date.now() - c.at < 300e3) return c.v;
  try {
    const j = await (await fetch(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`)).json();
    const d = j.data && j.data[0];
    const v = d ? { rate: +d.fundingRate, hours: +d.fundingRateInterval, next: +d.nextUpdate } : null;
    fundingCache[symbol] = { v, at: Date.now() };
    return v;
  } catch { return c ? c.v : null; }
}

// the open orders (委托) really resting on the exchange for a live bot, read with the .env key; cached 8 s per symbol so the
// dashboard's refresh stays cheap. { ok, at, cids } or { ok: false, at, error }
const pendingCache = {};
async function pendingOn(cfg) {
  const c = pendingCache[cfg.symbol];
  if (c && Date.now() - c.at < 8e3) return c.v;
  let v;
  try {
    const a = new Bitget({ key: process.env.BITGET_API_KEY, secret: process.env.BITGET_API_SECRET, passphrase: process.env.BITGET_PASSPHRASE, demo: process.env.BITGET_DEMO === '1' });
    v = { ok: true, at: Date.now(), cids: new Set((await a.pendingOrders(cfg.symbol, cfg.productType)).map(o => o.clientOid)) };
  } catch (e) { v = { ok: false, at: Date.now(), error: e.message }; }
  pendingCache[cfg.symbol] = { v, at: Date.now() };
  return v;
}

// the futures account behind the .env keys, per exchange (only those with a key): equity, unrealized P&L, free to open,
// held by open orders. Read-only, cached 15 s. { bitget: { equity, upl, free, locked } | { error } , binance: ... }
let accountCache = null;
async function accounts() {
  if (accountCache && Date.now() - accountCache.at < 15e3) return accountCache.v;
  const v = {}, read = async (k, fn) => { try { v[k] = await fn(); } catch (e) { v[k] = { error: e.message }; } };
  if (process.env.BITGET_API_KEY) await read('bitget', async () => {
    const a = new Bitget({ key: process.env.BITGET_API_KEY, secret: process.env.BITGET_API_SECRET, passphrase: process.env.BITGET_PASSPHRASE, demo: process.env.BITGET_DEMO === '1' });
    const u = (await a.req('GET', '/api/v2/mix/account/accounts', { auth: true, query: { productType: 'USDT-FUTURES' } })).find(x => x.marginCoin === 'USDT');
    return { equity: +u.usdtEquity, upl: +u.unrealizedPL, free: +u.crossedMaxAvailable, locked: +u.locked };
  });
  if (process.env.BINANCE_API_KEY) await read('binance', async () => {
    const a = await new Binance({ key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET }).req('GET', '/fapi/v2/account');
    return { equity: +a.totalMarginBalance, upl: +a.totalUnrealizedProfit, free: +a.availableBalance, locked: +a.totalOpenOrderInitialMargin };
  });
  accountCache = { v, at: Date.now() };
  return v;
}

function tail(file, lines) {
  if (!fs.existsSync(file)) return [];
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size, len = Math.min(size, 64 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines);
}

// a command for the running bot (stop, close, manual order, fill...): it takes the queue on its next check
const enqueue = (bot, cmd) => db.addCommand(bot.id, cmd);

// raising max add orders: the investment grows by what the new orders need, so the planned ones keep their size
async function maxAddsPlan(bot, to) {
  if (bot.maxAdds >= 20) throw new Error('Already at the maximum of 20 add orders.');
  if (!Number.isInteger(to) || to <= bot.maxAdds || to > 20) throw new Error(`Max add orders can only go up: choose ${bot.maxAdds + 1} to 20.`);
  const cfg = bots.cfgFor(bot), st = await db.loadState(bot.id);
  const extra = Math.ceil(S.extraInvestment(cfg, st && st.pos, to) * 100) / 100;
  return { current: bot.maxAdds, to, extra, investment: bot.investment, investmentAfter: +(bot.investment + extra).toFixed(2) };
}

async function botView(bot) {
  const cfg = bots.cfgFor(bot);
  const { state: st, at: mtime } = await db.botStateRow(bot.id), queued = await db.pendingCommands(bot.id);
  // the engine saves its state every check, so a recent save means the process is alive
  // how often this bot checks now (15s with a cycle open or a limit / market entry, else its K-line): 2 missed checks + 2 min = not responding
  const checkTf = S.checkEvery(cfg, !!(st && st.pos)), every = checkTf === '15s' ? S.CYCLE_CHECK_MS : TF_MS[checkTf];
  const fresh = st && Date.now() - mtime < every * 2 + 120e3;
  // status for people: running / starting / stopped / not responding (enabled but no recent check)
  const enabled = bot.enabled !== false;
  const status = bot.closedAt ? 'closed' : !enabled ? 'stopped' : fresh ? 'running' : !st || Date.now() - Date.parse(bot.updatedAt || bot.createdAt) < 120e3 ? 'starting' : 'down';
  const running = enabled && fresh;
  const px = await price(cfg.symbol, cfg.broker);
  // the open martingale cycle with its levels and live P&L
  let pos = null;
  if (st && st.pos) {
    const L = S.levels(st.pos, cfg), margin = st.pos.orders.reduce((s, o) => s + (o.margin || 0), 0);
    const upnl = px ? (px - L.avg) * st.pos.qty : null;
    pos = { ...st.pos, ...L, margin, upnl, pnlPct: upnl !== null && margin ? upnl / margin * 100 : null,
      preview: S.plan(cfg, st.pos.orders[0].px) }; // pos.plan stays the cycle's fixed adds (live bots); preview = the rules applied now
  }
  // a live bot keeps its cycle on the exchange as resting orders: which of them are really pending there (null = could not ask Bitget)
  let resting = null;
  if (!bot.dryRun && st && st.pos && st.live && (bot.broker || 'bitget') === 'bitget') {
    const ex = await pendingOn(cfg), row = o => o && { px: o.px, qty: o.qty, onExchange: ex.ok ? ex.cids.has(o.cid) : null };
    resting = { checkedAt: ex.at, error: ex.ok ? null : ex.error, tp: row(st.live.tp), adds: Object.fromEntries(Object.entries(st.live.adds || {}).map(([k, o]) => [k, row(o)])) };
  }
  return {
    bot, price: px, running: !!running, status, enabled, lastSeen: mtime || null, resting,
    state: st && {
      realizedPnl: st.realizedPnl || 0, halted: st.halted, pending: st.pending,
      lastBarTs: st.lastBarTs, closed: (st.history || []).length,
    },
    pos,
    firstMargin: S.firstMargin(cfg),
    contract: await contract(cfg.symbol, cfg.broker),
    funding: await funding(cfg.symbol, cfg.broker),
    upnl: pos ? pos.upnl || 0 : 0,
    log: tail(path.join(DIR, cfg.logFile), 30),
    alerts: tail(path.join(DIR, `alerts-${bot.id}.log`), 50),
    history: st && st.history ? st.history.filter(h => h.orders).slice(-100).reverse() : [],
    // manual orders not filled yet: limit orders waiting for their price + ones the bot hasn't picked up
    manualOrders: [...((st && st.manualOrders) || []), ...queued.filter(c => c.type === 'manual').map(c => ({ ...c, queued: true }))],
    // stop / close armed at a price (already picked up by the bot, or still waiting in the queue)
    armed: { ...((st && st.armed) || {}), ...Object.fromEntries(queued.filter(c => c.type === 'stop' || c.type === 'close').map(c => [c.type, c.how === 'limit' ? { now: true, how: 'limit', limitPx: c.px, queued: true } : c.how === 'hold' ? { now: true, how: 'hold', queued: true }
      : c.px > 0 ? { px: c.px, dir: c.dir, queued: true } : { now: true, queued: true }])) },
    closing: st && st.closing ? { px: st.closing.px, qty: st.closing.qty } : null, // a closing limit sell resting on the exchange
    // an order the exchange minimum blocked: shown until the investment covers it
    short: (() => {
      const s = st && st.short;
      if (!s) return null;
      const topUp = S.topUpFor(cfg, st.pos, s.n, s.need);
      return topUp > 0.005 ? { n: s.n, need: s.need, topUp: Math.ceil(topUp * 100) / 100 } : null;
    })(),
    checkTf, lastCheck: st && st.lastCheck,
  };
}

// an alert-only watch: status, price, and the signals it has sent
async function watchView(w) {
  const cfg = watches.cfgFor(w), { state: st, at: mtime } = await db.watchStateRow(w.id);
  const checkTf = watches.watchTf(cfg); // an alert looks once per candle of its shortest K-line
  const fresh = st && Date.now() - mtime < TF_MS[checkTf] * 2 + 120e3, enabled = w.enabled !== false;
  const status = !enabled ? 'stopped' : fresh ? 'running' : !st || Date.now() - Date.parse(w.updatedAt || w.createdAt) < 120e3 ? 'starting' : 'down';
  return { watch: w, price: await price(cfg.symbol, cfg.broker), running: enabled && !!fresh, status, enabled, lastSeen: mtime || null,
    lastCheck: st && st.lastCheck, signals: st ? st.signals.slice(0, 30) : [], checkTf, nextCheck: enabled ? nextCheckAt(Date.now(), checkTf) : null, alerts: tail(path.join(DIR, cfg.alertsFile), 30) };
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
  });
}

// The files that make the dashboard installable as an app (public/). They hold nothing private, and browsers fetch the manifest and the
// service worker without the login, so these exact names are served before the login check. Nothing else in public/ is reachable.
const APP_FILES = {
  '/manifest.webmanifest': ['application/manifest+json', 'no-cache'], '/sw.js': ['text/javascript', 'no-cache'], '/icon.svg': ['image/svg+xml', 'public, max-age=86400'],
  '/icon-192.png': ['image/png', 'public, max-age=86400'], '/icon-512.png': ['image/png', 'public, max-age=86400'],
  '/icon-maskable-512.png': ['image/png', 'public, max-age=86400'], '/apple-touch-icon.png': ['image/png', 'public, max-age=86400'],
};

const server = http.createServer(async (req, res) => {
  try {
    const app = req.method === 'GET' && APP_FILES[req.url.split('?')[0]];
    if (app) {
      res.writeHead(200, { 'Content-Type': app[0], 'Cache-Control': app[1] });
      return res.end(fs.readFileSync(path.join(DIR, 'public', req.url.split('?')[0])));
    }
    if (!(await authorized(req))) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="bots"' });
      return res.end('login required');
    }
    // view-only dashboard: anything that changes something (every non-GET, and the max-adds quote) is refused here, once
    if (!EDIT && (req.method !== 'GET' || /^\/api\/bots\/[a-z0-9-]+\/maxadds/.test(req.url))) return send(res, 403, { error: 'dashboard is view-only' });
    // the dashboard: the React app (ui/) built into dist/ by `npm run build`
    const url = req.url.split('?')[0], built = path.join(DIST, 'index.html');
    if (req.method === 'GET' && url === '/' && !fs.existsSync(built)) return send(res, 503, 'The dashboard is not built yet: run npm run build in the bot folder.', 'text/plain');
    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(built));
    }
    const asset = req.method === 'GET' && /^\/assets\/[\w.-]+\.(js|css)$/.exec(url); // file names carry a content hash: cache them for good
    if (asset && fs.existsSync(path.join(DIST, url))) {
      res.writeHead(200, { 'Content-Type': asset[1] === 'js' ? 'text/javascript' : 'text/css', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(path.join(DIST, url)));
    }
    if (req.method === 'GET' && req.url === '/api/bots') {
      return send(res, 200, { accounts: await accounts(), editable: EDIT, liveEnabled: liveEnabled(), stopAll: fs.existsSync(STOP_FILE), brokers: BROKERS, telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), defaults: require('./config'), strategies: (await bots.listStrategies()), bots: await Promise.all((await bots.list()).map(botView)), watches: await Promise.all((await watches.list()).map(watchView)) });
    }
    const ck = /^\/api\/check\/([A-Z0-9]+)\?broker=([a-z]+)&leverage=(\d*)$/.exec(req.url);
    if (req.method === 'GET' && ck) return send(res, 200, BROKERS[ck[2]] ? await checkSymbol(ck[1], ck[2], ck[3]) : { ok: false, message: 'unknown broker' });
    if (req.method === 'POST' && req.url === '/api/bots') {
      const list = (await bots.list());
      const bot = bots.validate(await readBody(req), list);
      // the symbol must exist on the chosen broker (e.g. SOXX is on Bitget, not Binance)
      const ck = await checkSymbol(bot.symbol, bot.broker, bot.leverage);
      if (!ck.ok) throw new Error(ck.message);
      list.push(bot);
      await bots.save(list);
      return send(res, 201, bot);
    }
    const tm = /^\/api\/bots\/([a-z0-9-]+)\/trades\.csv$/.exec(req.url);
    if (req.method === 'GET' && tm) {
      const bot = (await bots.list()).find(b => b.id === tm[1]);
      const rows = bot ? await db.tradesOf(bot.id) : [];
      if (!rows.length) return send(res, 404, { error: 'no trades recorded yet' });
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="trades-${bot.id}.csv"` });
      return res.end(toCsv(rows));
    }
    const pm = /^\/api\/price\/([A-Z0-9]+)(?:\?broker=([a-z]+))?$/.exec(req.url);
    if (req.method === 'GET' && pm) return send(res, 200, { price: await price(pm[1], pm[2] || 'bitget'), contract: await contract(pm[1], pm[2] || 'bitget') });
    // manual order: queued for the bot, which adds it to its cycle on the next check
    const mm = /^\/api\/bots\/([a-z0-9-]+)\/manual$/.exec(req.url);
    if (req.method === 'POST' && mm) {
      const bot = (await bots.list()).find(b => b.id === mm[1]);
      if (!bot) return send(res, 404, { error: 'bot not found' });
      if (!bot.dryRun) throw new Error('A live bot only records real Bitget fills: manual orders and typed fills are off.');
      // { side: buy | sell, orderType: market | limit, px (limit only), qty }  or  { cancel: ref }
      const body = await readBody(req);
      const queue = [];
      if (body.cancel) queue.push({ type: 'cancel', ref: String(body.cancel), at: Date.now() });
      else if (body.fill) { // the real fill from the exchange: the bot takes it as the next planned order (buy) or closes / reduces (sell)
        if (!(+body.px > 0) || !(+body.qty > 0)) throw new Error('Enter the fill price and size from the exchange.');
        queue.push({ type: 'fill', side: body.side === 'sell' ? 'sell' : 'buy', px: +body.px, qty: +body.qty, at: Date.now() });
      } else {
        const side = body.side === 'sell' ? 'sell' : 'buy', orderType = body.orderType === 'limit' ? 'limit' : 'market';
        if (!(+body.qty > 0)) throw new Error('Enter an amount above 0.');
        if (orderType === 'limit' && !(+body.px > 0)) throw new Error('Enter a limit price above 0.');
        queue.push({ type: 'manual', ref: `m${Date.now()}`, side, orderType, px: orderType === 'limit' ? +body.px : null, qty: +body.qty, at: Date.now() });
      }
      await enqueue(bot, queue[0]);
      return send(res, 200, { queued: (await db.pendingCommands(bot.id)).length });
    }
    // stop / close the bot now or at a price; or cancel an armed one
    const am = /^\/api\/bots\/([a-z0-9-]+)\/action$/.exec(req.url);
    if (req.method === 'POST' && am) {
      const list = (await bots.list()), i = list.findIndex(b => b.id === am[1]);
      if (i < 0) return send(res, 404, { error: 'bot not found' });
      const bot = list[i], body = await readBody(req);
      if (bot.closedAt) throw new Error('This bot is closed.');
      if (body.action === 'disarm') {
        if (body.what !== 'stop' && body.what !== 'close') throw new Error('Nothing to cancel.');
        await enqueue(bot, { type: 'disarm', what: body.what, at: Date.now() });
        return send(res, 200, { ok: true });
      }
      if (body.action !== 'stop' && body.action !== 'close') throw new Error('Unknown action.');
      // close: how = 'market' (now / when a price is reached), 'limit' (a limit sell at px; the bot closes when it fills) or 'hold' (keep the position)
      const how = body.action === 'close' && (body.how === 'hold' || body.how === 'limit') ? body.how : 'market';
      const px = how === 'hold' || body.px === undefined || body.px === null || body.px === '' ? null : +body.px;
      if (px !== null && !(px > 0)) throw new Error('Enter a price above 0.');
      if (how === 'limit' && px === null) throw new Error('Enter the limit price to sell at.');
      if (body.action === 'stop' && px === null) { // stopping now just turns the bot off
        list[i] = { ...bot, enabled: false, updatedAt: new Date().toISOString() };
        await bots.save(list);
        return send(res, 200, { stopped: true });
      }
      const v = await botView(bot);
      if (!v.running) throw new Error(body.action === 'close' ? 'Start the bot first: it has to be running to place the closing order.' : 'Start the bot first: it has to be running to watch the price.');
      if (how === 'market' && px !== null && !v.price) throw new Error('No price available right now. Try again in a moment.');
      if (how === 'market' && px !== null && px === v.price) throw new Error('That is the current price: choose now instead.');
      await enqueue(bot, { type: body.action, ...(body.action === 'close' ? { how } : {}), px, dir: how !== 'market' || px === null ? undefined : px > v.price ? 'up' : 'down', at: Date.now() });
      return send(res, 200, { queued: true });
    }
    // alert-only watches: /api/watches, /api/watches/<id>, /api/watches/<id>/<start|stop|test>
    const seg = req.url.split('?')[0].split('/');
    if (seg[1] === 'api' && seg[2] === 'watches') {
      const list = (await watches.list()), id = seg[3], action = seg[4];
      if (!id && req.method === 'POST') {
        const w = watches.validate(await readBody(req), list);
        try { await marketFor(w.symbol, w.broker).contract(); }
        catch (e) { throw new Error(`${w.symbol} is not available on ${BROKERS[w.broker].label}: ${e.message}`); }
        list.push(w);
        await watches.save(list);
        return send(res, 201, w);
      }
      const i = list.findIndex(x => x.id === id);
      if (i < 0) return send(res, 404, { error: 'alert not found' });
      if (!action && req.method === 'PUT') {
        list[i] = watches.validate(await readBody(req), list, list[i]);
        await watches.save(list);
        return send(res, 200, list[i]);
      }
      if (!action && req.method === 'DELETE') {
        list.splice(i, 1);
        await watches.save(list);
        return send(res, 200, { deleted: id });
      }
      if ((action === 'start' || action === 'stop') && req.method === 'POST') {
        list[i] = { ...list[i], enabled: action === 'start', updatedAt: new Date().toISOString() };
        await watches.save(list);
        return send(res, 200, { enabled: list[i].enabled });
      }
      if (action === 'test' && req.method === 'POST') { // a real Telegram message, so the user knows it reaches them
        const w = list[i], a = new Alerts(watches.cfgFor(w), { dir: DIR, botId: w.name, topic: watches.topic(w) });
        if (!a.sendFn) throw new Error('Telegram is not set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env and restart.');
        await a.telegram(`🔔 Test: ${w.name} (${w.symbol} ${w.tf}) is watching. Alerts will arrive here.`);
        return send(res, 200, { sent: true });
      }
    }
    // strategies: saved martingale parameters for the new-bot form
    if (req.url === '/api/strategies' && req.method === 'POST') {
      const body = await readBody(req), name = String(body.name || '').trim().slice(0, 40);
      if (!name) throw new Error('Give the strategy a name.');
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'strategy';
      const all = (await bots.listStrategies()).filter(x => x.id !== id);
      all.push({ id, name, params: bots.parseStrategy(body.params || {}) });
      await bots.saveStrategies(all);
      return send(res, 200, { id, strategies: all });
    }
    const dsm = /^\/api\/strategies\/([a-z0-9-]+)$/.exec(req.url);
    if (dsm && req.method === 'DELETE') {
      const all = (await bots.listStrategies()).filter(x => x.id !== dsm[1]);
      await bots.saveStrategies(all);
      return send(res, 200, { strategies: all });
    }
    // add funds: raises the investment (the orders still to place get bigger; planned ones already filled stay)
    const im = /^\/api\/bots\/([a-z0-9-]+)\/invest$/.exec(req.url);
    if (req.method === 'POST' && im) {
      const list = (await bots.list()), i = list.findIndex(b => b.id === im[1]);
      if (i < 0) return send(res, 404, { error: 'bot not found' });
      const add = +(await readBody(req)).add;
      if (!(add > 0)) throw new Error('Enter an amount above 0.');
      list[i] = bots.validate({ ...list[i], investment: +(list[i].investment + add).toFixed(2) }, list, list[i]);
      await bots.save(list);
      return send(res, 200, { investment: list[i].investment });
    }
    // take profit % (any value) and max add orders (up only, investment grows by what the new orders need)
    const tpm = /^\/api\/bots\/([a-z0-9-]+)\/tp$/.exec(req.url);
    if (req.method === 'POST' && tpm) {
      const list = (await bots.list()), i = list.findIndex(b => b.id === tpm[1]);
      if (i < 0) return send(res, 404, { error: 'bot not found' });
      list[i] = bots.validate({ ...list[i], tpPct: (await readBody(req)).tpPct }, list, list[i]);
      await bots.save(list);
      return send(res, 200, { tpPct: list[i].tpPct });
    }
    const cym = /^\/api\/bots\/([a-z0-9-]+)\/cycles$/.exec(req.url);
    if (req.method === 'POST' && cym) { // up only (0 = no limit); works while the bot runs
      const list = (await bots.list()), i = list.findIndex(b => b.id === cym[1]);
      if (i < 0) return send(res, 404, { error: 'bot not found' });
      const to = +(await readBody(req)).maxCycles;
      if (list[i].maxCycles > 0 && to === list[i].maxCycles) return send(res, 400, { error: `Max cycles is already ${to}: choose more, or 0 for no limit.` });
      list[i] = bots.validate({ ...list[i], maxCycles: to }, list, list[i]);
      await bots.save(list);
      return send(res, 200, { maxCycles: list[i].maxCycles });
    }
    const xm = /^\/api\/bots\/([a-z0-9-]+)\/maxadds(?:\?to=(\d+))?$/.exec(req.url);
    if (xm && (req.method === 'GET' || req.method === 'POST')) {
      const list = (await bots.list()), i = list.findIndex(b => b.id === xm[1]);
      if (i < 0) return send(res, 404, { error: 'bot not found' });
      if (req.method === 'GET') return send(res, 200, await maxAddsPlan(list[i], +xm[2]));
      const plan = await maxAddsPlan(list[i], +(await readBody(req)).maxAdds);
      list[i] = bots.validate({ ...list[i], maxAdds: plan.to, investment: plan.investmentAfter }, list, list[i]);
      await bots.save(list);
      return send(res, 200, plan);
    }
    // STOP ALL: while the STOP_ALL file exists no live bot sends an order (closing included); bots keep running and retry
    if (req.method === 'POST' && req.url === '/api/stop-all') {
      const on = (await readBody(req)).on === true;
      if (on) fs.writeFileSync(STOP_FILE, new Date().toISOString()); else if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);
      return send(res, 200, { stopAll: on });
    }
    // Start / Stop: flips `enabled`; runner.js starts or stops the bot within seconds
    const sm = /^\/api\/bots\/([a-z0-9-]+)\/(start|stop)$/.exec(req.url);
    if (req.method === 'POST' && sm) {
      const list = (await bots.list()), i = list.findIndex(b => b.id === sm[1]);
      if (i < 0) return send(res, 404, { error: 'bot not found' });
      if (sm[2] === 'start' && list[i].closedAt) return send(res, 409, { error: 'This bot was closed and cannot be started again.' });
      list[i] = { ...list[i], enabled: sm[2] === 'start', updatedAt: new Date().toISOString() };
      await bots.save(list);
      return send(res, 200, { enabled: list[i].enabled });
    }
    const m = /^\/api\/bots\/([a-z0-9-]+)$/.exec(req.url);
    if (m && (req.method === 'PUT' || req.method === 'DELETE')) {
      const list = (await bots.list()), i = list.findIndex(b => b.id === m[1]);
      if (i < 0) return send(res, 404, { error: `no bot "${m[1]}"` });
      if (req.method === 'PUT') {
        const input = await readBody(req);
        const old = list[i], bot = bots.validate(input, list, old);
        if (bot.symbol !== old.symbol || bot.leverage !== old.leverage) {
          const ov = await botView(old);
          if (ov.enabled || ov.pos) throw new Error('Stop the bot and wait for its open cycle to close before changing the symbol or leverage.');
          const ck = await checkSymbol(bot.symbol, bot.broker, bot.leverage);
          if (!ck.ok) throw new Error(ck.message);
        }
        if (bot.dryRun !== list[i].dryRun && (await botView(list[i])).running) {
          throw new Error('Stop the bot before switching between alert and live mode.');
        }
        list[i] = bot;
        await bots.save(list);
        return send(res, 200, bot);
      }
      const v = await botView(list[i]);
      if (v.enabled) return send(res, 409, { error: 'Stop the bot before deleting it.' });
      if (v.pos) return send(res, 409, { error: `It still has an open cycle (#${v.pos.id}). Wait until it closes.` });
      list.splice(i, 1);
      await bots.save(list);
      return send(res, 200, { deleted: m[1] });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// ---- watchdog: Telegram alert when a bot that was checking stops (amd asleep, crash, offline) ----
const alive = {};
async function watchdog() {
  for (const bot of (await bots.list())) {
    try {
      const v = await botView(bot);
      if (!v.state || !v.enabled) { delete alive[bot.id]; continue; }
      const was = alive[bot.id];
      alive[bot.id] = v.running;
      if (was === undefined || was === v.running) continue;
      const a = new Alerts(bots.cfgFor(bot), { dir: DIR, botId: bot.id });
      await a.send(v.running ? 'start' : 'error', v.running ? 'Checking again.'
        : `No check since ${new Date(v.lastSeen).toLocaleString('sv-SE').slice(0, 16)}. The bot may have stopped (computer asleep, offline or crashed).`);
    } catch (e) { console.error('watchdog', bot.id, e.message); }
  }
}
if (!args['no-watchdog']) { watchdog(); setInterval(watchdog, 60e3); }

db.migrate().catch(e => console.error(`database: ${e.message}`)); // creates the tables on first use
server.listen(PORT, HOST, () => console.log(`dashboard: http://${HOST}:${PORT} (${EDIT ? 'edit' : 'view-only'})`));
