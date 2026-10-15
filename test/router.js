// Router (apps/server/router.js): the route table behind the dashboard API.
const assert = require('assert');
const { Router } = require('../apps/server/router');

const r = new Router();
r.add('GET', '/api/bots', 'list')
  .add('GET', '/api/bots/:id/trades.csv', 'csv')
  .add('POST', '/api/bots/:id/:what(start|stop)', 'startstop')
  .add('PUT', '/api/bots/:id', 'edit')
  .add('POST', '/api/watches/:id([^/?]+)/test', 'test', { ignoreQuery: true })
  .add('GET', /^\/api\/price\/(?<sym>[A-Z0-9]+)(?:\?broker=(?<broker>[a-z]+))?$/, 'price');
const hit = (m, u) => { const x = r.match(m, u); return x && { name: x.handler, ...x.params }; };

assert.deepStrictEqual(hit('GET', '/api/bots'), { name: 'list' });
assert.strictEqual(hit('GET', '/api/bots?x=1'), null, 'a string pattern is exact: a query makes it another URL');
assert.strictEqual(hit('POST', '/api/bots'), null, 'the method must match');
assert.deepStrictEqual(hit('GET', '/api/bots/t1/trades.csv'), { name: 'csv', id: 't1' });
assert.strictEqual(hit('GET', '/api/bots/t1/tradesXcsv'), null, 'a dot in a pattern is a dot, not "any character"');
assert.deepStrictEqual(hit('POST', '/api/bots/my-bot-2/stop'), { name: 'startstop', id: 'my-bot-2', what: 'stop' });
assert.strictEqual(hit('POST', '/api/bots/t1/explode'), null);
assert.strictEqual(hit('PUT', '/api/bots/T1'), null, 'ids are lowercase');
assert.deepStrictEqual(hit('PUT', '/api/bots/t1'), { name: 'edit', id: 't1' });
assert.deepStrictEqual(hit('POST', '/api/watches/Any_id.1/test?x=1'), { name: 'test', id: 'Any_id.1' }, 'custom pattern + ignoreQuery');
assert.deepStrictEqual(hit('GET', '/api/price/SMHUSDT'), { name: 'price', sym: 'SMHUSDT', broker: undefined });
assert.deepStrictEqual(hit('GET', '/api/price/SMHUSDT?broker=bitget'), { name: 'price', sym: 'SMHUSDT', broker: 'bitget' });
assert.strictEqual(hit('GET', '/api/price/smhusdt'), null);
// the first matching route wins
const o = new Router().add('GET', '/a/:x', 'first').add('GET', '/a/b', 'second');
assert.strictEqual(o.match('GET', '/a/b').handler, 'first');
console.log('router: ok');
