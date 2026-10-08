// All tunable settings. API keys go in .env, never here.
module.exports = {
  symbol: 'SOXXUSDT',
  productType: 'USDT-FUTURES',
  marginCoin: 'USDT',

  tf: '1H',              // signal timeframe (K-line) for the entry indicators
  leverage: 3,

  // ---- entry: indicator conditions that open the first order of a cycle ----
  //   logic 'or' : any condition fires;  'and': all fire within `window` bars
  //   types: boll-revert / boll-break { period, mult }, ma-cross { ma, fast, slow },
  //          macd-cross { fast, slow, signal }, rsi-cross { period, level }
  entry: { logic: 'or', window: 3, signals: [{ type: 'boll-revert', period: 20, mult: 2 }] },

  // ---- martingale (same fields as Bitget's martingale bot) ----
  investment: 1000,      // total margin (USDT) for the first order + all adds
  maxAdds: 5,            // add orders after the first
  stepPct: 2,            // add when price is this % below the previous order ...
  stepMult: 1.5,         // ... and each step is this x the previous one (2%, 3%, 4.5% ...)
  amountMult: 2,         // each order is this x the previous one
  tpPct: 2,              // close everything at this % above the average entry price

  // ---- trace: extra indicators logged every closed bar (don't affect trading) ----
  trace: {
    sma: [20, 50, 100, 200],
    ema: [20, 50],
    boll: [[20, 2], [20, 2.5], [30, 2]],
  },

  usMarketHoursOnly: false, // true = only OPEN during 09:30-16:00 New York, Mon-Fri (exits run anytime)
  checkTf: null,         // how often to check: null = one step below tf (4H->15m, 1H->5m, 1D->1H)

  dryRun: true,          // true = alert mode: simulated fills, no orders sent (live execution not enabled yet)
  demo: false,           // true = send 'paptrading' header (Bitget demo account)

  logFile: 'bot.log',
  traceDir: 'trace',
};
