// The Expo app's server client (apps/mobile/src/api.js): address cleanup, sign-in headers and error handling, against a fake fetch.
const assert = require('assert');
const path = require('path');

(async () => {
  const api = await import(path.join(__dirname, '..', 'apps', 'mobile', 'src', 'api.js'));

  // addresses: scheme added, trailing slash dropped, plain http only for local addresses
  assert.strictEqual(api.cleanUrl('bots.example.com/'), 'https://bots.example.com');
  assert.strictEqual(api.cleanUrl(' https://x.io// '), 'https://x.io');
  assert.strictEqual(api.cleanUrl('192.168.1.5:8787'), 'http://192.168.1.5:8787');
  assert.strictEqual(api.cleanUrl('localhost:8787'), 'http://localhost:8787');
  assert.strictEqual(api.cleanUrl(''), '');

  // sign-in headers
  const h = api.headersFor({ user: 'admin', pass: 'p@ss:é', cfId: 'id.access', cfSecret: 's3' }, true);
  assert.strictEqual(h.Authorization, 'Basic ' + Buffer.from('admin:p@ss:é', 'utf8').toString('base64'));
  assert.strictEqual(h['CF-Access-Client-Id'], 'id.access'); assert.strictEqual(h['CF-Access-Client-Secret'], 's3');
  assert.strictEqual(h['Content-Type'], 'application/json');
  assert.deepStrictEqual(Object.keys(api.headersFor({ user: '', pass: '' })), ['Accept']);

  // requests against a fake server
  const reply = (status, body, ct = 'application/json; charset=utf-8', redirected = false) => ({ status, ok: status < 400, redirected, headers: { get: () => ct }, json: async () => body });
  const conn = { url: 'srv.test', user: 'a', pass: 'b' };
  let seen;
  globalThis.fetch = async (url, opts) => { seen = { url, opts }; return reply(200, { bots: [1] }); };
  assert.deepStrictEqual(await api.request(conn, '/api/bots'), { bots: [1] });
  assert.strictEqual(seen.url, 'https://srv.test/api/bots'); assert.strictEqual(seen.opts.method, 'GET'); assert.strictEqual(seen.opts.body, undefined);
  await api.request(conn, '/api/stop-all', { method: 'POST', body: { on: true } });
  assert.strictEqual(seen.opts.body, '{"on":true}');

  const kind = async fn => { try { await fn(); return 'no error'; } catch (e) { assert(e instanceof api.ApiError); return e.kind; } };
  globalThis.fetch = async () => reply(401, {}); assert.strictEqual(await kind(() => api.request(conn, '/api/bots')), 'auth');
  globalThis.fetch = async () => reply(200, '<html>', 'text/html'); assert.strictEqual(await kind(() => api.request(conn, '/api/bots')), 'auth'); // an Access login page
  globalThis.fetch = async () => reply(200, {}, 'application/json', true); assert.strictEqual(await kind(() => api.request(conn, '/api/bots')), 'auth');
  globalThis.fetch = async () => reply(500, { error: 'boom' }); assert.strictEqual(await kind(() => api.request(conn, '/api/bots')), 'server');
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); }; assert.strictEqual(await kind(() => api.request(conn, '/api/bots')), 'network');
  assert.strictEqual(await kind(() => api.request({ url: '' }, '/api/bots')), 'network');
  globalThis.fetch = async () => reply(409, { error: 'closed' });
  await assert.rejects(() => api.request(conn, '/api/bots/x/start', { method: 'POST', body: {} }), /closed/);
  console.log('mobile: ok');
})().catch(e => { console.error('mobile FAILED:', e.message); process.exit(1); });
