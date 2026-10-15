# DCA martingale bots for Bitget / Binance USDT-M futures

Runs on your own PC. Each bot opens a long cycle (on an indicator signal, at a limit price, or at market), keeps a ladder of
limit buys resting on the exchange below the entry, and one take-profit sell for the whole position. A phone-friendly
dashboard creates, watches and manages the bots. Alert-only watches send a Telegram message when indicators fire.

## Order rules
For investment T, N add orders, leverage L, entry price P0, first price step d, step multiple k, amount multiple r:

| What | Rule |
|---|---|
| Margin of order n (n = 0 is the first) | A × rⁿ, with A = T ÷ (1 + r + … + r^N); all of T goes into the orders |
| Price of add n | P0 × (1 − drop n), drop n = d × (1 + k + … + k^(n−1)); every add is measured from the entry, rounded down |
| Quantity | margin ÷ (price × (1.1 ÷ L + 1.1 × 0.06%)), rounded down to the exchange step |
| Take profit | average price × (1 + TP%) for the whole position |
| Stop loss | none |

The math lives in one file, `dca.mjs`, used by both the bot and the dashboard. A cycle's adds are fixed when it opens
(`pos.plan`), so changing the code or the settings never moves the orders of an open cycle.

## Setup (Windows)
1. Install Node.js 22.12+ and PostgreSQL 17 (`winget install PostgreSQL.PostgreSQL.17`).
2. Create the database: `create role soxxbot login password '...'; create database soxxbot owner soxxbot;`.
   Keep PostgreSQL on localhost only (`listen_addresses = 'localhost'`).
3. In this folder: `copy .env.example .env`, then fill in `DATABASE_URL`, `WEB_PASSWORD` and the exchange keys.
4. `npm install`, then `npm run build` (builds the dashboard into `dist/`).
5. `npm start` runs every enabled bot (`apps/server/runner.js`); `npm run web` serves the dashboard on http://127.0.0.1:8787.
   The tables are created on first start.

Exchange keys: use a **sub-account** with **futures trade + read only, no withdrawal**. Live orders are refused unless
`LIVE_TRADING=1` is set.

## Where things are
| Part | Files |
|---|---|
| Runner (all bots + alert watches, one process) | `apps/server/runner.js`, `apps/server/engine.js` (one bot), `apps/server/watcher.js` (one watch) |
| Strategy | `apps/server/strategy.js` (entry signals, ladder, decisions), `apps/server/dca.mjs` (order math), `apps/server/indicators.js` |
| Exchanges | `apps/server/bitget.js`, `apps/server/binance.js`, `apps/server/market.js`, `apps/server/executor.js` |
| Data | `apps/server/db.js`: PostgreSQL tables `bots`, `strategies`, `watches`, `bot_state`, `watch_state`, `trades`, `commands` |
| Dashboard | `apps/server/web.js` (HTTP API + login), `apps/web/` (React 19 + Vite) |
| Alerts | `apps/server/alerts.js` (Telegram + log), `apps/server/recorder.js` (trade ledger) |
| Tools | `node apps/server/bot.js check|trace|status|setup|alert [--bot=<id>]` |
| Tests | `npm test`; `node test/db.js` against the database `soxxbot_test` |

`docs/CURRENT-STATE.md` describes the internals in detail.

## Folders

```napps/server/ backend: runner, engine, web API, exchanges, db
apps/web/    dashboard (React + Vite); src/, public/ (PWA files), dist/ (build)
apps/mobile/ Android app (Capacitor)
test/        npm test
docs/        CURRENT-STATE.md
tradingview/ Pine scripts
runtime/     logs, indicator traces, STOP_ALL (gitignored, created on start)
```

## Safety built in
- Every order is saved to the database **before** it is sent. If the database can't be reached, nothing is sent.
- After a crash the bot looks its orders up on the exchange; the position is compared with the exchange every check and
  new entries pause on a mismatch.
- **Pause** on the dashboard (a `STOP_ALL` file, so it works even without the database) cancels every resting order.
