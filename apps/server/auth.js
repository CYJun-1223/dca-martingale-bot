// Dashboard login: HTTP Basic (WEB_USER / WEB_PASSWORD) or a Cloudflare Access token (Cf-Access-Jwt-Assertion), which replaces the password.
//   const { authorized } = createAuth({ user, pass, team, aud });   if (!(await authorized(req))) -> 401
// No password set = open (web.js refuses to start that way unless --no-auth is given).
// CF_ACCESS_TEAM=<your-team>  CF_ACCESS_AUD=<application audience tag>  (both in .env)
const crypto = require('crypto');

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createAuth({ user, pass, team, aud }) {
  let jwks = { at: 0, keys: [] };
  async function accessKeys() {
    if (Date.now() - jwks.at < 3600e3 && jwks.keys.length) return jwks.keys;
    const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    jwks = { at: Date.now(), keys: (await r.json()).keys };
    return jwks.keys;
  }
  async function accessOk(token) {
    if (!team || !aud || !token) return false;
    try {
      const [h, p, s] = token.split('.');
      const head = JSON.parse(Buffer.from(h, 'base64url')), body = JSON.parse(Buffer.from(p, 'base64url'));
      const jwk = (await accessKeys()).find(k => k.kid === head.kid);
      if (!jwk || head.alg !== 'RS256') return false;
      const valid = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
      const now = Date.now() / 1000;
      return valid && [].concat(body.aud).includes(aud) && body.exp > now
        && body.iss === `https://${team}.cloudflareaccess.com`;
    } catch { return false; }
  }
  async function authorized(req) {
    if (!pass) return true;
    if (await accessOk(req.headers['cf-access-jwt-assertion'])) return true;
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const [u, ...p] = Buffer.from(m[1], 'base64').toString().split(':');
    return same(u, user) & same(p.join(':'), pass);
  }
  return { authorized };
}

module.exports = { createAuth };
