#!/usr/bin/env node
// Tools for one bot (from the database; the bots themselves run in runner.js):
//   node bot.js check    verify API, symbol, keys, balance (read-only)
//   node bot.js trace    print SMA / EMA / BOLL values for recent bars
//   node bot.js status   show the open martingale cycle
//   node bot.js setup    set one-way mode, cross margin, leverage (live only; not enabled yet)
//   node bot.js alert    send a test alert (checks Telegram settings)
//   add --bot=<id> to pick a bot (default: the first one)
//   node runner.js       runs every enabled bot
//   node web.js          dashboard at http://127.0.0.1:8787
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

// ---- .env loader (no dependencies) ----
const envFile = path.join(DIR, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { Bitget } = require('./bitget');
const { Binance } = require('./binance');
const { createMarket, BROKERS, checkTfFor } = require('./market');
const { createExecutor, SimExecutor } = require('./executor');
const { Alerts } = require('./alerts');
const { Bus } = require('./events');
const { Engine, usMarketOpen, localTime } = require('./engine');
const db = require('./db');
const S = require('./strategy');
const bots = require('./bots');

const args = Object.fromEntries(process.argv.slice(3).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
// --bot=<id> picks a bot from the database (default: the first one); none = plain config.js. Set up by load().
let bot, cfg, api, binance, market, broker, onBitget, botId;
async function load() {
  bot = await bots.find(typeof args.bot === 'string' ? args.bot : null);
  cfg = bot ? bots.cfgFor(bot) : { ...require('./config') };
  if (bot) console.log(`bot: ${bot.id} (${bot.name}) ${cfg.dryRun ? 'ALERT (simulated fills)' : 'LIVE'}`);
  if (args.tf) cfg.tf = args.tf;
  api = new Bitget({ key: process.env.BITGET_API_KEY, secret: process.env.BITGET_API_SECRET, passphrase: process.env.BITGET_PASSPHRASE, demo: cfg.demo || process.env.BITGET_DEMO === '1' });
  binance = new Binance({ key: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_API_SECRET });
  market = createMarket(cfg, api);
  broker = BROKERS[cfg.broker || 'bitget'].label;
  onBitget = broker === 'Bitget';
  botId = bot ? bot.id : 'default';
}
const parts = () => ({ market, executor: createExecutor(cfg, { bitget: api, binance }, market), bus: new Bus() });
const readOnly = () => ({ market, executor: new SimExecutor(market) });

const ok = (m) => console.log('  \x1b[32mPASS\x1b[0m ' + m);
const bad = (m) => console.log('  \x1b[31mFAIL\x1b[0m ' + m);
const info = (m) => console.log('  \x1b[33mNOTE\x1b[0m ' + m);

async function check() {
  console.log(`\nChecking ${cfg.symbol} on ${broker} (${cfg.dryRun ? 'alert' : 'LIVE'} mode, checks every ${checkTfFor(cfg)})\n`);
  let fails = 0;
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { fails++; bad(`${name}: ${e.message}`); }
  };

  if (onBitget) await step('server time', async () => {
    const t = +(await api.serverTime()).serverTime;
    const drift = Math.abs(t - Date.now()) / 1000;
    (drift < 5 ? ok : bad)(`Bitget reachable, clock drift ${drift.toFixed(1)}s${drift >= 5 ? ' (sync your PC clock!)' : ''}`);
    if (drift >= 5) fails++;
  });

  let c;
  await step('contract', async () => {
    c = await market.contract();
    ok(`${cfg.symbol} status=${c.symbolStatus} minQty=${c.minTradeNum} step=${c.sizeMultiplier} maxLev=${c.maxLever ?? '?'}`);
    if (c.symbolStatus && c.symbolStatus !== 'normal') info(`symbol status is "${c.symbolStatus}"`);
  });

  let price;
  await step('ticker', async () => {
    price = await market.lastPrice();
    ok(`last price ${price}`);
  });

  for (const tf of ['1H', '4H']) {
    await step(`candles ${tf}`, async () => {
      const bars = await market.closedBars(tf, 300);
      const last = bars[bars.length - 1];
      (bars.length >= 60 ? ok : bad)(`${tf}: ${bars.length} closed bars, last ${last ? localTime(last.ts) : '-'}`);
      if (bars.length < 60) fails++;
    });
  }

  info(cfg.usMarketHoursOnly
    ? `US market ${usMarketOpen() ? 'OPEN now' : 'CLOSED now'} (bot only opens cycles while open)`
    : 'opens allowed 24/7 (usMarketHoursOnly: false)');
  info(`entry: ${S.describeEntry(S.entryOf(cfg))} on ${cfg.tf}`);

  if (c && price) {
    // the whole martingale cycle if it opened now: every order must meet the exchange minimums
    const step = +c.sizeMultiplier, q = x => Math.floor(x / step + 1e-9) * step;
    const rows = S.plan(cfg, price);
    const small = rows.filter(r => q(r.notional / r.px) < +c.minTradeNum || q(r.notional / r.px) * r.px < +(c.minTradeUSDT || 0));
    (small.length ? bad : ok)(`first order ${S.firstMargin(cfg).toFixed(2)} USDT margin (≈${(S.firstMargin(cfg) * cfg.leverage).toFixed(0)} USDT notional, min ${c.minTradeNum} / ${c.minTradeUSDT || 0} USDT)`);
    if (small.length) fails++;
    console.table(rows.map(r => ({ order: r.n ? `add ${r.n}` : 'first', at: +r.px.toFixed(2), drop: `${r.dropPct.toFixed(1)}%`,
      margin: +r.orderMargin.toFixed(2), 'margin used': +r.margin.toFixed(2), avg: +r.avg.toFixed(2), TP: +r.tp.toFixed(2) })));
  }

  if (!onBitget) {
    info(`${broker}: market data only (no account checks yet)`);
  } else if (!api.hasKey) {
    info('no API key in .env -> skipped private checks (fine for paper mode)');
  } else {
    await step('account', async () => {
      const a = await api.account(cfg.symbol, cfg.productType, cfg.marginCoin);
      ok(`API key works. equity ${(+a.accountEquity).toFixed(2)} USDT, available ${(+a.available || +a.crossedMaxAvailable || 0).toFixed(2)}`);
      info(`posMode=${a.posMode} marginMode=${a.marginMode} crossLev=${a.crossedMarginLeverage}`);
      if (+a.accountEquity < cfg.investment) info(`equity is below the investment (${cfg.investment} USDT)`);
      if (a.posMode && a.posMode !== 'one_way_mode') info('run "node bot.js setup" to switch to one-way mode');
    });
    await step('position', async () => {
      const d = await api.position(cfg.symbol, cfg.productType, cfg.marginCoin);
      const long = (d || []).find(p => p.holdSide === 'long');
      ok(`current ${cfg.symbol} long: ${long ? long.total : 0}`);
    });
  }

  console.log(fails ? `\n${fails} check(s) failed.\n` : '\nAll checks passed.\n');
  process.exitCode = fails ? 1 : 0;
}

async function trace() {
  const n = +(args.n || 12);
  const bars = await market.closedBars(cfg.tf, 300);
  const e = new Engine(cfg, readOnly(), { dir: DIR, quiet: true });
  e.pdp = 2;
  const cols = e.traceRows(bars);
  const keys = Object.keys(cols);
  const rows = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const r = {};
    for (const k of keys) {
      const v = cols[k][i];
      r[k] = v === null ? '' : typeof v === 'string' ? v : k.endsWith('_pb') ? +v.toFixed(2) : +v.toFixed(2);
    }
    r.signal = S.entrySignal(bars.slice(0, i + 1).map(b => b.c), S.entryOf(cfg)) ? 'YES' : '';
    rows.push(r);
  }
  console.log(`\n${cfg.symbol} ${cfg.tf} - entry: ${S.describeEntry(S.entryOf(cfg))}  (_pb = %B, 0 = lower band, 1 = upper)`);
  // split wide table: MAs, then each BOLL set
  const base = ['time', 'close'];
  const ma = keys.filter(k => /^(sma|ema)/.test(k));
  console.table(rows.map(r => Object.fromEntries([...base, ...ma, 'signal'].map(k => [k, r[k]]))));
  for (const [p, m] of cfg.trace.boll) {
    const k = `bb${p}x${m}`;
    console.log(`BOLL(${p}, ${m})`);
    console.table(rows.map(r => Object.fromEntries([...base, `${k}_up`, `${k}_mid`, `${k}_lo`, `${k}_pb`].map(x => [x, r[x]]))));
  }
}

async function status() {
  const e = new Engine(cfg, readOnly(), { dir: DIR, quiet: true, state: bot && await db.loadState(bot.id) });
  const st = e.st;
  console.log(`\n${cfg.symbol}  realized ${st.realizedPnl.toFixed(2)} USDT, ${st.history.length} cycles closed${st.halted ? '  [ENTRIES PAUSED: position mismatch]' : ''}`);
  if (!st.pos) return console.log('  no open cycle\n');
  const L = S.levels(st.pos, cfg);
  console.log(`  cycle #${st.pos.id} opened ${localTime(st.pos.openedAt)}: ${st.pos.qty} @ avg ${L.avg.toFixed(2)}, TP ${L.tp.toFixed(2)}, next add ${L.nextAdd ? L.nextAdd.toFixed(2) : 'none left'}`);
  console.table(st.pos.orders.map(o => ({ order: o.manual ? 'manual' : o.n ? `add ${o.n}` : 'first', time: localTime(o.ts), price: +o.px.toFixed(2), qty: o.qty, margin: +(o.margin || 0).toFixed(2) })));
}

async function setup() {
  if (cfg.dryRun) return console.log('Alert mode (dryRun: true): nothing to set up on Bitget.');
  for (const line of await parts().executor.setup()) console.log('  ' + line);
}

async function alert() {
  const a = new Alerts(cfg, { dir: DIR, botId });
  await a.send('test', 'Test alert from the bot. If you can read this, alerts work.');
  console.log(`sent to: ${a.channels.join(', ')}${a.channels.includes('telegram') ? '' : ' (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env for Telegram)'}`);
  console.log(`log: ${a.file}`);
}


const cmd = process.argv[2] || 'help';
const cmds = { check, trace, status, setup, alert };
if (!cmds[cmd]) {
  console.log('Usage: node bot.js <check|trace|status|setup|alert> [--bot=<id>] [--tf=4H] [--n=20]   (run the bots: node runner.js)');
} else {
  load().then(cmds[cmd]).catch(err => { console.error('Error:', err.message); process.exitCode = 1; }).finally(() => db.end());
}
