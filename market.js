// Stage 1 - market watcher: read-only market data for one symbol, per broker (public endpoints).
// Every broker returns the same shapes, so the engine doesn't care which one it watches:
//   contract()   -> { sizeMultiplier, minTradeNum, volumePlace, pricePlace, minTradeUSDT } (Bitget's field names)
//   closedBars() -> [{ ts, o, h, l, c, v }] oldest first, fully closed bars only
//   lastPrice()  -> number
const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1H': 36e5, '4H': 144e5, '1D': 864e5 };

const BROKERS = {
  bitget: { label: 'Bitget', market: 'USDT-M perpetual' },
  binance: { label: 'Binance', market: 'USDT-M perpetual' },
};

const closedOnly = (bars, tf) => { const now = Date.now(); return bars.filter(b => b.ts + TF_MS[tf] <= now); };

class BitgetMarket {
  constructor(api, cfg) { this.api = api; this.cfg = cfg; }
  get sym() { return [this.cfg.symbol, this.cfg.productType]; }
  contract() { return this.api.contract(...this.sym); }
  async closedBars(tf, limit = 300) { return closedOnly(await this.api.candles(...this.sym, tf, limit), tf); }
  async lastPrice() { return +(await this.api.ticker(...this.sym)).lastPr; }
}

// Binance USDT-M futures (fapi), public endpoints only
class BinanceMarket {
  constructor(cfg, { base = 'https://fapi.binance.com' } = {}) { this.cfg = cfg; this.base = base; }

  async get(path, query) {
    const r = await fetch(`${this.base}${path}?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(10e3) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Binance ${j && j.code ? `${j.code}: ${j.msg}` : `HTTP ${r.status}`}`);
    return j;
  }

  async contract() {
    const j = await this.get('/fapi/v1/exchangeInfo', {});
    // crypto is PERPETUAL, stocks (NVDA, TSLA, ...) are TRADIFI_PERPETUAL; quarterly futures are skipped
    const s = j.symbols.find(x => x.symbol === this.cfg.symbol && /PERPETUAL$/.test(x.contractType));
    if (!s) throw new Error(`Contract ${this.cfg.symbol} not found on Binance`);
    const f = t => s.filters.find(x => x.filterType === t) || {};
    const lot = f('MARKET_LOT_SIZE').stepSize ? f('MARKET_LOT_SIZE') : f('LOT_SIZE');
    const dp = x => (String(+x).split('.')[1] || '').length;
    return {
      symbolStatus: s.status === 'TRADING' ? 'normal' : s.status.toLowerCase(),
      sizeMultiplier: String(+lot.stepSize), minTradeNum: String(+lot.minQty),
      volumePlace: String(dp(lot.stepSize)), pricePlace: String(dp(f('PRICE_FILTER').tickSize)),
      minTradeUSDT: f('MIN_NOTIONAL').notional || '0', maxLever: null,
    };
  }

  async closedBars(tf, limit = 300) {
    const k = await this.get('/fapi/v1/klines', { symbol: this.cfg.symbol, interval: tf.toLowerCase(), limit: String(limit) });
    return closedOnly(k.map(x => ({ ts: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })), tf);
  }

  async lastPrice() { return +(await this.get('/fapi/v1/ticker/price', { symbol: this.cfg.symbol })).price; }
}

function createMarket(cfg, bitgetApi) {
  const broker = cfg.broker || 'bitget';
  if (broker === 'bitget') return new BitgetMarket(bitgetApi, cfg);
  if (broker === 'binance') return new BinanceMarket(cfg);
  throw new Error(`Unknown broker "${broker}" (have: ${Object.keys(BROKERS).join(', ')})`);
}

// How often a bot checks, by its signal timeframe: one step down (4H -> 15m, 1H -> 5m, 1D -> 1H).
// A bot can override it with checkTf.
const CHECK_TF = { '1m': '1m', '5m': '1m', '15m': '5m', '30m': '5m', '1H': '5m', '4H': '15m', '1D': '1H' };
const checkTfFor = cfg => cfg.checkTf || CHECK_TF[cfg.tf] || '5m';

// next check time: just after the next check-timeframe bar closes (UTC-aligned, like exchange candles)
function nextCheckAt(now, checkTf, delayMs = 5e3) {
  const step = TF_MS[checkTf];
  return Math.floor(now / step) * step + step + delayMs;
}

module.exports = { BitgetMarket, BinanceMarket, Market: BitgetMarket, createMarket, BROKERS, TF_MS, CHECK_TF, checkTfFor, nextCheckAt };
