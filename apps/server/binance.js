// Minimal Binance USDT-M futures (fapi) REST client, signed endpoints only (public data is in market.js). Node 18+.
const crypto = require('crypto');

class Binance {
  constructor({ key, secret, base = 'https://fapi.binance.com' } = {}) {
    this.key = key; this.secret = secret; this.base = base;
  }

  get hasKey() { return !!(this.key && this.secret); }

  // every call here is signed: params go in the query string with timestamp + HMAC-SHA256 (hex) of that string
  async req(method, path, params = {}) {
    if (!this.hasKey) throw new Error('BINANCE_API_KEY / BINANCE_API_SECRET missing in .env');
    const qs = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now()) }).toString();
    const sig = crypto.createHmac('sha256', this.secret).update(qs).digest('hex');
    const res = await fetch(`${this.base}${path}?${qs}&signature=${sig}`, {
      method, headers: { 'X-MBX-APIKEY': this.key }, signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`); }
    if (!res.ok || (j && j.code < 0)) {
      const e = new Error(`Binance ${j.code}: ${j.msg}`);
      e.code = j.code;
      throw e;
    }
    return j;
  }

  setOneWay() { return this.req('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: 'false' }); }
  setMarginType(symbol, marginType) { return this.req('POST', '/fapi/v1/marginType', { symbol, marginType }); } // ISOLATED | CROSSED
  setLeverage(symbol, leverage) { return this.req('POST', '/fapi/v1/leverage', { symbol, leverage: String(leverage) }); }
  placeOrder(p) { return this.req('POST', '/fapi/v1/order', p); }
  order(symbol, clientOid) { return this.req('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientOid }); }
  cancelOrder(symbol, clientOid) { return this.req('DELETE', '/fapi/v1/order', { symbol, origClientOrderId: clientOid }); }
  openOrders(symbol) { return this.req('GET', '/fapi/v1/openOrders', { symbol }); }
  userTrades(symbol, orderId) { return this.req('GET', '/fapi/v1/userTrades', { symbol, orderId: String(orderId) }); }
  positionRisk(symbol) { return this.req('GET', '/fapi/v2/positionRisk', { symbol }); }
}

module.exports = { Binance };
