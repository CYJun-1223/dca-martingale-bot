// Minimal Bitget v2 REST client (USDT-M futures). Node 18+ (built-in fetch).
const crypto = require('crypto');

class Bitget {
  constructor({ key, secret, passphrase, demo } = {}) {
    this.key = key; this.secret = secret; this.passphrase = passphrase;
    this.demo = !!demo;
    this.base = 'https://api.bitget.com';
  }

  get hasKey() { return !!(this.key && this.secret && this.passphrase); }

  async req(method, path, { query, body, auth } = {}) {
    const qs = query ? new URLSearchParams(query).toString() : '';
    const pathQs = path + (qs ? '?' + qs : '');
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', locale: 'en-US' };
    if (auth) {
      if (!this.hasKey) throw new Error('API key / secret / passphrase missing in .env');
      const ts = Date.now().toString();
      headers['ACCESS-KEY'] = this.key;
      headers['ACCESS-TIMESTAMP'] = ts;
      headers['ACCESS-PASSPHRASE'] = this.passphrase;
      headers['ACCESS-SIGN'] = crypto.createHmac('sha256', this.secret)
        .update(ts + method + pathQs + bodyStr).digest('base64');
    }
    if (this.demo) headers.paptrading = '1';

    const res = await fetch(this.base + pathQs, {
      method, headers, body: bodyStr || undefined, signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`); }
    if (j.code !== '00000') {
      const e = new Error(`Bitget ${j.code}: ${j.msg}`);
      e.code = j.code;
      throw e;
    }
    return j.data;
  }

  // ---- public ----
  serverTime() { return this.req('GET', '/api/v2/public/time'); }
  async contract(symbol, productType) {
    const d = await this.req('GET', '/api/v2/mix/market/contracts', { query: { productType, symbol } });
    if (!d || !d.length) throw new Error(`Contract ${symbol} not found`);
    return d[0];
  }
  async ticker(symbol, productType) {
    const d = await this.req('GET', '/api/v2/mix/market/ticker', { query: { symbol, productType } });
    return Array.isArray(d) ? d[0] : d;
  }
  async candles(symbol, productType, granularity, limit = 300) {
    const d = await this.req('GET', '/api/v2/mix/market/candles',
      { query: { symbol, productType, granularity, limit: String(limit) } });
    return d.map(k => ({ ts: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
      .sort((a, b) => a.ts - b.ts);
  }

  // ---- private ----
  account(symbol, productType, marginCoin) {
    return this.req('GET', '/api/v2/mix/account/account', { auth: true, query: { symbol, productType, marginCoin } });
  }
  position(symbol, productType, marginCoin) {
    return this.req('GET', '/api/v2/mix/position/single-position', { auth: true, query: { symbol, productType, marginCoin } });
  }
  setPositionMode(productType, posMode) {
    return this.req('POST', '/api/v2/mix/account/set-position-mode', { auth: true, body: { productType, posMode } });
  }
  setMarginMode(symbol, productType, marginCoin, marginMode) {
    return this.req('POST', '/api/v2/mix/account/set-margin-mode', { auth: true, body: { symbol, productType, marginCoin, marginMode } });
  }
  setLeverage(symbol, productType, marginCoin, leverage) {
    return this.req('POST', '/api/v2/mix/account/set-leverage', { auth: true, body: { symbol, productType, marginCoin, leverage: String(leverage) } });
  }
  placeOrder(body) {
    return this.req('POST', '/api/v2/mix/order/place-order', { auth: true, body });
  }
  orderDetail(symbol, productType, clientOid) {
    return this.req('GET', '/api/v2/mix/order/detail', { auth: true, query: { symbol, productType, clientOid } });
  }
  cancelOrder(symbol, productType, clientOid) {
    return this.req('POST', '/api/v2/mix/order/cancel-order', { auth: true, body: { symbol, productType, clientOid } });
  }
  // the open orders (委托) of one symbol
  async pendingOrders(symbol, productType) {
    const d = await this.req('GET', '/api/v2/mix/order/orders-pending', { auth: true, query: { symbol, productType } });
    return (d && d.entrustedList) || [];
  }
}

module.exports = { Bitget };
