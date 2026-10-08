// Stage 4 - executor: turns the engine's orders into fills.
//   SimExecutor    - fills at the current market price, no orders sent (the only one enabled)
//   BitgetExecutor / BinanceExecutor - real orders, one adapter per exchange (same calls; the engine doesn't
//                    know which one it has). createExecutor() refuses both unless LIVE_TRADING=1.
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STOP_FILE = process.env.STOP_FILE || path.join(__dirname, 'STOP_ALL'); // exists = trading paused (dashboard switch); tests use their own file

class SimExecutor {
  constructor(market) { this.market = market; }
  get live() { return false; }
  async setup() { return ['simulated execution: no account settings changed']; }
  async marketOrder({ size, px }) { return { px: px || await this.market.lastPrice(), qty: +size, done: true }; } // px: a maker entry fills at its limit
  async findOrder() { return null; }
  async positionQty() { return null; } // local state is the truth
}

// What every exchange adapter shares: the STOP ALL / per-order cap guard and "market order, then wait for the fill".
// An adapter supplies lastPrice(), sendMarket(), findOrder() and the rest of the order calls.
class LiveExecutor {
  constructor(api, cfg) { this.api = api; this.cfg = cfg; }
  get live() { return true; }

  // no order while trading is paused (STOP_FILE); new exposure (not reduce-only) is capped per order, closing never is
  async guard(size, reduceOnly, price) {
    if (fs.existsSync(STOP_FILE)) throw new Error('Trading is paused: no orders are sent. Resume it on the dashboard.');
    if (!reduceOnly) {
      const last = price || await this.lastPrice(), cap = +process.env.MAX_ORDER_USDT || 300;
      if (!(last > 0) || size * last > cap) throw new Error(`Order ${size} x ${last} = ${(size * last).toFixed(0)} USDT is over the ${cap} USDT cap (MAX_ORDER_USDT in .env).`);
    }
  }

  async marketOrder({ side, size, reduceOnly, clientOid }) {
    await this.guard(size, reduceOnly);
    await this.sendMarket({ side, size, reduceOnly, clientOid });
    for (let i = 0; i < 15; i++) {
      await sleep(700);
      const d = await this.findOrder(clientOid, true);
      if (d && d.done) return d;
    }
    throw new Error(`Order ${clientOid} not filled after 10s`);
  }
}

class BitgetExecutor extends LiveExecutor {
  get mm() { return this.cfg.marginMode === 'isolated' ? 'isolated' : 'crossed'; }
  get sym() { return [this.cfg.symbol, this.cfg.productType]; }

  async setup() {
    const { symbol, productType, marginCoin, leverage } = this.cfg, mm = this.mm;
    const out = [];
    try { await this.api.setPositionMode(productType, 'one_way_mode'); out.push('position mode: one-way'); }
    catch (e) { out.push('position mode unchanged (' + e.message + ')'); }
    try { await this.api.setMarginMode(symbol, productType, marginCoin, mm); out.push(`margin mode: ${mm === 'isolated' ? 'isolated' : 'cross'}`); }
    catch (e) { out.push('margin mode unchanged (' + e.message + ')'); }
    await this.api.setLeverage(symbol, productType, marginCoin, leverage);
    out.push(`leverage: ${leverage}x`);
    return out;
  }

  async lastPrice() { return +(await this.api.ticker(...this.sym)).lastPr; }

  // a resting limit order (shows under 委托 / open orders on Bitget); the fill is found later through pendingOrders / findOrder
  async limitOrder({ side, size, price, reduceOnly, clientOid }) {
    const { symbol, productType, marginCoin } = this.cfg;
    await this.guard(size, reduceOnly, price);
    await this.api.placeOrder({
      symbol, productType, marginCoin, marginMode: this.mm,
      size: String(size), price: String(price), side, orderType: 'limit', force: 'gtc',
      reduceOnly: reduceOnly ? 'YES' : 'NO', clientOid,
    });
  }
  cancel(clientOid) { return this.api.cancelOrder(...this.sym, clientOid); } // cancelling is never blocked
  // what an order of ours did: { px, qty } filled so far, or null when the exchange has no such order. Other errors throw.
  async orderState(clientOid) {
    try { const d = await this.api.orderDetail(...this.sym, clientOid); return d ? { px: +d.priceAvg, qty: +d.baseVolume || 0, fee: Math.abs(+d.fee || 0), ts: +d.uTime || undefined } : null; }
    catch (e) { if (/40109|not exist|cannot be found|not found/i.test(e.message)) return null; throw e; }
  }
  async pendingOrders() {
    return (await this.api.pendingOrders(...this.sym)).map(o => ({ cid: o.clientOid, side: o.side, px: +o.price, size: +o.size, filled: +o.baseVolume || 0 }));
  }

  sendMarket({ side, size, reduceOnly, clientOid }) {
    const { symbol, productType, marginCoin } = this.cfg;
    return this.api.placeOrder({
      symbol, productType, marginCoin, marginMode: this.mm,
      size: String(size), side, orderType: 'market',
      reduceOnly: reduceOnly ? 'YES' : 'NO', clientOid,
    });
  }

  // returns {px, qty, done} or null if the order doesn't exist / nothing filled
  async findOrder(clientOid, raw = false) {
    let d;
    try { d = await this.api.orderDetail(this.cfg.symbol, this.cfg.productType, clientOid); }
    catch { return null; }
    if (!d) return null;
    const qty = +d.baseVolume || 0;
    const done = ['filled', 'canceled', 'cancelled'].includes(d.state), fee = Math.abs(+d.fee || 0), ts = +d.uTime || undefined;
    if (raw) return { px: +d.priceAvg, qty, done, fee, ts };
    return qty > 0 ? { px: +d.priceAvg, qty, done, fee, ts } : null;
  }

  async positionQty() {
    const d = await this.api.position(...this.sym, this.cfg.marginCoin);
    const long = (d || []).find(p => p.holdSide === 'long');
    return long ? +long.total : 0;
  }
}

// Binance USDT-M futures: same calls as Bitget, Binance names (BUY/SELL, LIMIT/MARKET, origClientOrderId, positionAmt)
const BN_DONE = ['FILLED', 'CANCELED', 'EXPIRED', 'EXPIRED_IN_MATCH'];
const bnMissing = e => e.code === -2013 || e.code === -2011; // order does not exist / unknown order
class BinanceExecutor extends LiveExecutor {
  get mt() { return this.cfg.marginMode === 'isolated' ? 'ISOLATED' : 'CROSSED'; }

  async setup() {
    const { symbol, leverage } = this.cfg, out = [];
    try { await this.api.setOneWay(); out.push('position mode: one-way'); }
    catch (e) { out.push('position mode unchanged (' + e.message + ')'); } // -4059 = already one-way
    try { await this.api.setMarginType(symbol, this.mt); out.push(`margin mode: ${this.mt === 'ISOLATED' ? 'isolated' : 'cross'}`); }
    catch (e) { out.push('margin mode unchanged (' + e.message + ')'); } // -4046 = already that mode
    await this.api.setLeverage(symbol, leverage);
    out.push(`leverage: ${leverage}x`);
    return out;
  }

  async lastPrice() {
    const r = await fetch(`${this.api.base}/fapi/v1/ticker/price?symbol=${this.cfg.symbol}`, { signal: AbortSignal.timeout(10e3) });
    return +(await r.json()).price;
  }

  async limitOrder({ side, size, price, reduceOnly, clientOid }) {
    await this.guard(size, reduceOnly, price);
    await this.api.placeOrder({ symbol: this.cfg.symbol, side: side.toUpperCase(), type: 'LIMIT', timeInForce: 'GTC',
      quantity: String(size), price: String(price), reduceOnly: reduceOnly ? 'true' : 'false', newClientOrderId: clientOid });
  }
  sendMarket({ side, size, reduceOnly, clientOid }) {
    return this.api.placeOrder({ symbol: this.cfg.symbol, side: side.toUpperCase(), type: 'MARKET',
      quantity: String(size), reduceOnly: reduceOnly ? 'true' : 'false', newClientOrderId: clientOid });
  }
  cancel(clientOid) { return this.api.cancelOrder(this.cfg.symbol, clientOid); } // cancelling is never blocked

  // what an order of ours did: { px, qty } filled so far, or null when the exchange has no such order. Other errors throw.
  async orderState(clientOid) {
    try { const d = await this.api.order(this.cfg.symbol, clientOid); return { px: +d.avgPrice, qty: +d.executedQty || 0, fee: await this.feeOf(d), ts: +d.updateTime || undefined }; }
    catch (e) { if (bnMissing(e)) return null; throw e; }
  }
  // Binance keeps the fee on the trades, not the order: the sum of the order's trades (commission in USDT)
  async feeOf(d) {
    if (!(+d.executedQty > 0)) return 0;
    return (await this.api.userTrades(this.cfg.symbol, d.orderId)).reduce((s, t) => s + Math.abs(+t.commission || 0), 0);
  }
  async pendingOrders() {
    return (await this.api.openOrders(this.cfg.symbol)).map(o => ({ cid: o.clientOrderId, side: o.side.toLowerCase(), px: +o.price, size: +o.origQty, filled: +o.executedQty || 0 }));
  }
  // returns {px, qty, done} or null if the order doesn't exist / nothing filled
  async findOrder(clientOid, raw = false) {
    let d;
    try { d = await this.api.order(this.cfg.symbol, clientOid); } catch { return null; }
    const qty = +d.executedQty || 0, done = BN_DONE.includes(d.status);
    const fee = done ? await this.feeOf(d).catch(() => undefined) : undefined; // unknown fee = the engine books the standard rate
    const ts = +d.updateTime || undefined;
    if (raw) return { px: +d.avgPrice, qty, done, fee, ts };
    return qty > 0 ? { px: +d.avgPrice, qty, done, fee, ts } : null;
  }
  async positionQty() {
    const p = (await this.api.positionRisk(this.cfg.symbol)).find(x => x.symbol === this.cfg.symbol);
    return p ? Math.max(0, +p.positionAmt) : 0; // one-way mode: positive = long
  }
}

// fails closed: live orders only when LIVE_TRADING=1 is in .env
const liveEnabled = () => process.env.LIVE_TRADING === '1'; // read at call time: web.js loads .env after requiring this

// apis = { bitget, binance }: the signed client for each broker
function createExecutor(cfg, apis, market) {
  if (cfg.dryRun) return new SimExecutor(market);
  if (!liveEnabled()) throw new Error('Live trading is off: set LIVE_TRADING=1 in .env, or use alert mode.');
  const broker = cfg.broker || 'bitget';
  if (broker === 'bitget') return new BitgetExecutor(apis.bitget, cfg);
  if (broker === 'binance') return new BinanceExecutor(apis.binance, cfg);
  throw new Error(`No order adapter for broker "${broker}"`);
}

module.exports = { SimExecutor, BitgetExecutor, BinanceExecutor, createExecutor, liveEnabled, STOP_FILE };
