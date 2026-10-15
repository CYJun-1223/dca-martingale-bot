// A small route table for the dashboard server, plus the two HTTP helpers its handlers share.
//   router.add('POST', '/api/bots/:id/tp', handler)     :name matches [a-z0-9-]+ ; :name(regex) picks its own pattern
//   router.add('GET', /^\/api\/price\/(?<sym>[A-Z0-9]+)$/, handler)   a RegExp with named groups, matched against the whole URL
// A string pattern matches the whole URL exactly (a query string makes it a different URL, so it does not match) unless
// the route is added with { ignoreQuery: true }. The first route that matches wins; handlers get ({ req, res, params }).

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compile(pattern, ignoreQuery) {
  if (pattern instanceof RegExp) return pattern;
  let re = '', last = 0;
  for (const m of pattern.matchAll(/:(\w+)(?:\(([^)]*)\))?/g)) { // :name or :name(regex)
    re += escape(pattern.slice(last, m.index)) + `(?<${m[1]}>${m[2] ?? '[a-z0-9-]+'})`;
    last = m.index + m[0].length;
  }
  return new RegExp(`^${re}${escape(pattern.slice(last))}${ignoreQuery ? '(?:\\?.*)?' : ''}$`);
}

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, { ignoreQuery = false } = {}) {
    this.routes.push({ method, re: compile(pattern, ignoreQuery), handler });
    return this;
  }
  // -> { handler, params } for the first route that fits, else null
  match(method, url) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url);
      if (m) return { handler: r.handler, params: { ...(m.groups || {}) } };
    }
    return null;
  }
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

module.exports = { Router, send, readBody };
