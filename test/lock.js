// The runner's single-instance lock: the first holder gets it, a second one is refused, and it is free again once the first exits.
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const SERVER = process.env.SERVER_DIR || path.join(__dirname, '..', 'apps', 'server');
const port = 20000 + Math.floor(Math.random() * 20000);
const child = `require(${JSON.stringify(path.join(SERVER, 'runner.js'))}).acquireLock(${port}).then(()=>{console.log('LOCKED');setInterval(()=>{},1000)},e=>{console.log('REFUSED '+e.message);process.exit(3)})`;
const run = () => { const p = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''; p.stdout.on('data', d => { out += d; }); return { p, out: () => out, done: new Promise(r => p.on('exit', c => r(c))) }; };
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); } };
(async () => {
  const a = run(); await until(() => /LOCKED|REFUSED/.test(a.out()));
  assert(/LOCKED/.test(a.out()), 'first runner gets the lock');
  const b = run(); assert.strictEqual(await b.done, 3, 'second runner is refused'); assert(/another runner is already running/.test(b.out()));
  a.p.kill(); await a.done;
  const c = run(); await until(() => /LOCKED|REFUSED/.test(c.out())); assert(/LOCKED/.test(c.out()), 'the lock is free again after the first exits');
  c.p.kill(); await c.done;
  console.log('lock: ok');
})().catch(e => { console.error('lock FAILED:', e.message); process.exit(1); });
