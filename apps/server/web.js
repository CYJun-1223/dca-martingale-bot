#!/usr/bin/env node
// Dashboard: bot parameters + live state; create / edit / delete bots (database), send commands to the running bots.
// Running bots pick up edits on their next tick (id, symbol, leverage and paper/live are fixed).
//   node apps/server/web.js                 http://127.0.0.1:8787
//   node apps/server/web.js --host=0.0.0.0  also reachable over your LAN / VPN (or WEB_HOST=0.0.0.0 in .env)
//   node apps/server/web.js --readonly      view only (no create / edit / delete)
// Needs WEB_PASSWORD in .env. Public access goes through a Cloudflare Tunnel.
// Read-only toward Bitget (public prices, plus the .env key for the account and resting-order view). It never places orders:
// stop / close / manual orders are queued for the runner.
//
// Where things are: auth.js (login) · views.js (what the dashboard shows) · routes.js (the JSON API) · router.js (route table)
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadEnv } = require('./env');
const bots = require('./bots');
const { Alerts } = require('./alerts');
const db = require('./db');
const { createAuth } = require('./auth');
const { createViews } = require('./views');
const { buildRoutes } = require('./routes');
const { send } = require('./router');

const ROOT = path.join(__dirname, '..', '..'), RUNTIME = path.join(ROOT, 'runtime'); // logs, traces and the STOP_ALL switch live in runtime/
fs.mkdirSync(RUNTIME, { recursive: true });
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const PORT = +(args.port || 8787);
const EDIT = !args.readonly; // --readonly hides create / edit / delete
const WEB = path.join(ROOT, 'apps', 'web');
const DIST = path.join(WEB, args.dist || 'dist'); // the built dashboard (--dist <dir> to try another build)

// ---- login: WEB_USER / WEB_PASSWORD from .env (HTTP basic auth; serve over https only), or Cloudflare Access ----
loadEnv(ROOT);
const HOST = args.host || process.env.WEB_HOST || '127.0.0.1'; // WEB_HOST=0.0.0.0 in .env = also reachable over LAN / Tailscale
const PASS = process.env.WEB_PASSWORD;
if (!PASS && !args['no-auth']) {
  console.error('Set WEB_PASSWORD in .env (or pass --no-auth for local-only use).');
  process.exit(1);
}
const { authorized } = createAuth({ user: process.env.WEB_USER || 'admin', pass: PASS, team: process.env.CF_ACCESS_TEAM, aud: process.env.CF_ACCESS_AUD });

const views = createViews({ runtime: RUNTIME });
const router = buildRoutes({ views, runtime: RUNTIME, edit: EDIT });

// The files that make the dashboard installable as an app (apps/web/public/). They hold nothing private, and browsers fetch the manifest
// and the service worker without the login, so these exact names are served before the login check. Nothing else there is reachable.
const APP_FILES = {
  '/manifest.webmanifest': ['application/manifest+json', 'no-cache'], '/sw.js': ['text/javascript', 'no-cache'], '/icon.svg': ['image/svg+xml', 'public, max-age=86400'],
  '/icon-192.png': ['image/png', 'public, max-age=86400'], '/icon-512.png': ['image/png', 'public, max-age=86400'],
  '/icon-maskable-512.png': ['image/png', 'public, max-age=86400'], '/apple-touch-icon.png': ['image/png', 'public, max-age=86400'],
};

// serves one file with the given headers; a file that is missing is a plain 404 (never a half-written answer)
function sendFile(res, file, headers) {
  let data;
  try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: 'not found' }); }
  res.writeHead(200, headers);
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    const app = req.method === 'GET' && APP_FILES[url];
    if (app) return sendFile(res, path.join(WEB, 'public', url), { 'Content-Type': app[0], 'Cache-Control': app[1] });
    if (!(await authorized(req))) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="bots"' });
      return res.end('login required');
    }
    // view-only dashboard: anything that changes something (every non-GET, and the max-adds quote) is refused here, once
    if (!EDIT && (req.method !== 'GET' || /^\/api\/bots\/[a-z0-9-]+\/maxadds/.test(req.url))) return send(res, 403, { error: 'dashboard is view-only' });
    // the dashboard: the React app (apps/web) built into dist/ by `npm run build`
    const built = path.join(DIST, 'index.html');
    if (req.method === 'GET' && url === '/' && !fs.existsSync(built)) return send(res, 503, 'The dashboard is not built yet: run npm run build in the bot folder.', 'text/plain');
    if (req.method === 'GET' && url === '/') return sendFile(res, built, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    const asset = req.method === 'GET' && /^\/assets\/[\w.-]+\.(js|css)$/.exec(url); // file names carry a content hash: cache them for good
    if (asset && fs.existsSync(path.join(DIST, url))) {
      return sendFile(res, path.join(DIST, url), { 'Content-Type': asset[1] === 'js' ? 'text/javascript' : 'text/css', 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    const hit = router.match(req.method, req.url);
    if (hit) return await hit.handler({ req, res, params: hit.params });
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) return res.end(); // already answering: do not try to answer twice (that used to crash the server)
    send(res, 400, { error: e.message });
  }
});

// ---- watchdog: Telegram alert when a bot that was checking stops (amd asleep, crash, offline) ----
const alive = {};
async function watchdog() {
  for (const bot of (await bots.list())) {
    try {
      const v = await views.botView(bot);
      if (!v.state || !v.enabled) { delete alive[bot.id]; continue; }
      const was = alive[bot.id];
      alive[bot.id] = v.running;
      if (was === undefined || was === v.running) continue;
      const a = new Alerts(bots.cfgFor(bot), { dir: RUNTIME, botId: bot.id });
      await a.send(v.running ? 'start' : 'error', v.running ? 'Checking again.'
        : `No check since ${new Date(v.lastSeen).toLocaleString('sv-SE').slice(0, 16)}. The bot may have stopped (computer asleep, offline or crashed).`);
    } catch (e) { console.error('watchdog', bot.id, e.message); }
  }
}
if (!args['no-watchdog']) { watchdog(); setInterval(watchdog, 60e3); }

db.migrate().catch(e => console.error(`database: ${e.message}`)); // creates the tables on first use
// Started by a loop (Task Scheduler `cmd /c for /l`): when that parent goes away (task ended) exit too, so End + Run in Task Scheduler is a real restart.
const PARENT = process.ppid;
if (PARENT > 1) setInterval(() => { try { process.kill(PARENT, 0); } catch (e) { if (e.code === 'ESRCH') process.exit(0); } }, 2000).unref();
server.listen(PORT, HOST, () => console.log(`dashboard: http://${HOST}:${PORT} (${EDIT ? 'edit' : 'view-only'})`));
