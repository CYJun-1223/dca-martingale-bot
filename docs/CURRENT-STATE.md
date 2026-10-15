# Current state (tag `pre-framework` = c6e4b82)

Updated 2026-10-08 after the React dashboard and the move to PostgreSQL. Node >= 22.12; runtime dependency: `pg` only (React / Vite are build-time).
Verified on 2026-10-08: `node test/units.js` -> "all 46 passed"; `node test/sim.js` -> "all invariants held".

## 1. File map

| File | Lines | Single responsibility |
|---|---|---|
| `apps/server/runner.js` | 141 | Supervisor: one loop per enabled bot + watch, all in one process (`sync()` runner.js:107, every 5 s runner.js:129) |
| `apps/server/bot.js` | 254 | Legacy single-bot CLI: `check / trace / status / setup / run / alert` (bot.js:2-10). `npm start` still points here |
| `apps/server/engine.js` | 708 | Per-bot state machine: load/save state, tick, fills, resting-order sync, dashboard commands |
| `apps/server/strategy.js` | 292 | Pure decision + DCA math, no I/O (entry signals, ladder, plan, levels, `decide`) |
| `apps/server/executor.js` | 187 | Order adapters: `SimExecutor`, `BitgetExecutor`, `BinanceExecutor`; `createExecutor` (executor.js:178); `STOP_FILE` (executor.js:8); `liveEnabled` (executor.js:175) |
| `apps/server/bitget.js` / `apps/server/binance.js` | 93 / 41 | Signed REST clients |
| `apps/server/market.js` | 76 | Candles, price, contract rules per broker; `TF_MS`, `nextCheckAt` |
| `apps/server/indicators.js` | 81 | sma, ema, boll, macd, rsi, atr |
| `apps/server/alerts.js` | 85 | Bus subscriber: Telegram + `alerts-<id>.log` |
| `apps/server/recorder.js` | 50 | Bus subscriber: one `trades` row per open / add / tp / close / reduce; `toCsv` for the download |
| `apps/server/db.js` | 90 | PostgreSQL: schema, settings lists, state documents, trade ledger, command queue |
| `apps/server/events.js` | 36 | `Bus` pub/sub, subscriber errors swallowed |
| `apps/server/bots.js` | 210 | bots + strategies registry (database), `validate`, `cfgFor`, `patch` |
| `apps/server/watches.js` / `apps/server/watcher.js` | 69 / 86 | Alert-only watches: registry/validate / run loop (`runWatch` watcher.js:48) |
| `apps/server/config.js` | 40 | Defaults every bot record overrides |
| `apps/server/web.js` | 554 | Dashboard HTTP server: auth, JSON API, watchdog Telegram alert |
| `apps/server/dca.mjs` | 70 | The DCA order math (margins, drops from the entry, qty, rounding, minimums); the one copy used by `strategy.js` and the dashboard |
| `apps/web/` (incl. `vite.config.mjs`) | - | Dashboard: React 19 + Vite, built by `npm run build` into `dist/` (gitignored) that web.js serves |
| `apps/web/public/` | - | PWA files: manifest, icons, no-op `sw.js` (caches nothing) |
| `test/units.js`, `test/sim.js` | 835/118 | Tests (section 7) |
| `tradingview/*.pine` | - | Pine scripts mirroring the ladder/entry for TradingView alerts; not loaded by Node |

## 2. Processes and the database

```
  +--------------+        +----------------------+        +---------------+
  | web.js :8787 | -----> | PostgreSQL (local)   | <----- | runner.js     |
  | HTTP + login |  SQL   | database soxxbot     |  SQL   | all bots +    |
  | serves dist/ | <----- | bots, strategies,    | -----> | alert watches |
  +------+-------+        | watches, bot_state,  |        +-------+-------+
         ^                | watch_state, trades, |                |
   HTTP  |                | commands             |                v
  +------+-------+        +----------------------+       runtime/ logs: bot-<id>.log,
  | web browser  |                                        alerts-*.log, runner.log
  +--------------+        STOP_ALL file = pause switch (web writes, executor checks)
```

- `db.js` is the only module that talks to PostgreSQL (`pg`, DATABASE_URL in .env). Tables are created by `db.migrate()` at runner / dashboard start.
- `runner.js`: loads code once at start (code edits need a runner restart). Reads the bot list from the database every loop and while sleeping; symbol / broker / leverage / marginMode / dryRun are frozen for a running bot. Each Engine gets a store `{ saveState, takeCommands, hasCommands }` backed by db.js and the saved state from `bot_state`. No database at start = the runner exits (no trading).
- Engine saves (`engine.save()`) are awaited; orders are tracked in the state **before** they are sent, so a failed save means no order (fail closed).
- `web.js`: run as `node --watch apps/server/web.js`. Writes settings tables, `commands` (`enqueue`) and the `STOP_ALL` file. Liveness = `bot_state.updated_at`. Watchdog sends Telegram when a bot stops checking.
- Auth: fails closed without `WEB_PASSWORD`; Cloudflare Access JWT or HTTP Basic. `--readonly` = one view-only gate before routing. `LIVE_TRADING=1` required for live orders.
- Files kept on purpose, all in `runtime/` (gitignored): logs, `trace/` (indicator CSVs), `STOP_ALL` (works even with the database down). Everything else is in the database; the old JSON / CSV files were moved to `../soxx-bot-data-archive/` on 2026-10-08.

## 3. Data schemas

**Bot record** (`bots.validate` bots.js:80-136): `id` (`^[a-z0-9][a-z0-9-]{0,31}$`, fixed), `name`, `broker` (fixed after create), `symbol`, `tf` (1m..1D), `leverage` 1-125, `marginMode` crossed|isolated (fixed), `entry` (see below), `investment` 1-1e7, `maxAdds` 0-20 int, `stepPct` 0.01-50, `stepMult` 1-10, `amountMult` 1-10, `tpPct` 0.01-100, `usMarketHoursOnly`, `fillMode` auto|manual, `maxCycles` (0 = none, can only go up), `dryRun`, `enabled`, `createdAt`, `updatedAt`, `closedAt` (sticky). Rejects if `dropAt(maxAdds) >= 1`. Note: validate rebuilds the record, so unknown fields (e.g. `reservePct` in the live `smh-live` record) are dropped on the next PUT/invest/tp/cycles/maxadds edit.

**Entry** (strategy.js:36-48): `{ mode: 'maker'|'taker', limitPx }` or `{ logic: 'or'|'and', window, groups: [{ logic, signals: [...] }], volatility }`. Signal: `{ type: ma-cross|boll-revert|boll-break|macd-cross|rsi-cross, ...fields, tf?, volatility?{minPct,maxPct,period} }` (`parseSignal` bots.js:55). Older flat `{logic, signals}` / single `signal` still read.

**Bot state** (table `bot_state`, one jsonb document per bot; was `state-<id>.json`) (engine.js:43-49 defaults): `seq, pos, lastBarTs, pending{...,cid}, realizedPnl, halted, history[] (max 500), manualOrders[], armed{stop,close,reset}, closing{cid,px,qty,reset?}, live, advised{}, short{n,need}, lastCheck{ts,price}`, legacy `legacyHistory/legacyPortions`.
- `pos = { id, openedAt, orders: [{ n (null if manual), ts, px, qty, margin, orderType, fee..., manual? }], qty, cost, realized?, reductions?, plan }` (engine.js:623-637).
- `pos.plan = { maxAdds, adds: [{ k, px, qty }] }` fixed when first needed (engine.js:305-316).
- `live = { rev, adds: { [k]: { cid, px, qty } }, tp: { cid, px, qty } | null }` (engine.js:251-253).
- history entry: `{ id, openedAt, closedAt, orders, qty, avg, exitPx, exit{ts,px,qty,orderType,fee}, margin, pnl, reductions, closedBy? }` (engine.js:649-651).
- Old per-portion state is migrated with a backup first (`migratePortions` engine.js:54).

**Commands** (table `commands`, taken with one `delete ... returning`; engine.js:387-449): `manual {side, orderType, px, qty, ref}`, `cancel {ref}`, `fill {side,px,qty}`, `stop|close {how: market|limit|hold, px, dir}`, `reset {how, px}`, `disarm {what}`. Live bots reject manual/fill.

**Strategy** (table `strategies`, `parseStrategy` bots.js:187): `{ id, name, params }`, params subset of `investment, leverage, maxAdds, stepPct, stepMult, amountMult, tpPct, maxCycles` + `symbol, fillMode, tf, marginMode, entry` (never limitPx). All optional, no range limits.

**Watch** (`watches.validate` watches.js:33): `{ id, name, broker, symbol, tf, checkTf?, entry (flattened to one OR group, max 5 signals), enabled, createdAt, updatedAt }`. Files `watch-<id>.json/.log`, `alerts-watch-<id>.log`.

## 4. DCA rules now

strategy.js:
- `dropAt(cfg,n)` = stepPct/100 * sum_{j<n} stepMult^j = d*(k^n-1)/(k-1), from the entry (112).
- `weight(n)` = amountMult^n; `addBase` A = investment / sum_{n=0..maxAdds} weight; `marginFor(k)` = A*weight(k) (115-120). No reserve.
- `qtyFactor(L)` = 1.1/L + 1.1*0.0006; `qtyFor` = margin/(px*qtyFactor); `marginOf` = px*qty*qtyFactor (122-126).
- `planned(pos)` = non-manual orders (first order if all manual) (131). Manual orders move avg/TP but not the ladder.
- `levels`: avg = cost/qty over all orders, tp = avg*(1+tpPct/100), nextAdd = plan[0].px*(1-dropAt(adds+1)) (162-171).
- `ladder`: for k = planned.length..maxAdds: exact = p0*(1-dropAt(k)), px = floor to pdp, qty = rules.q(qtyFor(marginFor(k), exact, L)); stops at first add below minQty/minNotional (177-188).
- `plan(cfg, firstPx)`: unrounded preview rows (191-202).
engine.js:
- `planAdds` (307-316): creates `pos.plan` once from `ladder`; raising maxAdds appends k > old maxAdds; lowering filters k <= maxAdds; returns not-yet-filled adds.
- `syncOrders` (319-341): diffs wanted adds + one TP (qty capped at exchange position) against `live`, cancels/places only differences; aborts if a fill happened mid-cancel.
- `place` (343-355) saves tracking BEFORE sending.

**HARD INVARIANTS a refactor must keep**
1. Order n margin = A * amountMult^n, A = investment / sum weights (first order n = 0).
2. Add n drop from the entry (first planned order) = d*(k^n-1)/(k-1); never from the last fill.
3. qty = margin / (exactPx * (1.1/L + 1.1*0.0006)), rounded DOWN to the contract step; computed on the unrounded price.
4. Order price rounded DOWN to pdp (`Math.floor(x*10^pdp + 1e-9)`).
5. An open cycle's adds come only from `pos.plan`; code or settings changes never move them (only maxAdds up appends / down trims). Test: units.js:683.
6. State compatibility: existing `bot_state` documents (incl. `pos.plan`, `live`, `history`, legacy fields) must load unchanged; migrate with a `.bak-` copy, never drop positions/history/CSVs.
7. Client order ids: market `sx<ts><rand>` (engine.js:220), resting `sx<pos.id>t|a<k>r<rev>` (engine.js:344), limit close `sx<pos.id>c<rev>` (engine.js:539). Fills are recovered by these cids (`recoverPending`, `syncFills`).
8. Tracking saved before an order is sent; state written tmp + rename.
9. Dashboard never writes state; only queues commands. STOP_ALL blocks every live order; `LIVE_TRADING=1` required.

## 5. web.js HTTP API

"Edit" = returns 403 when started with `--readonly`. All except APP_FILES need auth. Errors -> 400 `{error}` (web.js:534).

| Method + path | Line | Gate | Purpose |
|---|---|---|---|
| GET `/manifest.webmanifest`, `/sw.js`, icons | 292 | none, no auth | PWA files |
| GET `/` | 305 | view | serve `dist/index.html` (503 + 'run npm run build' when not built); GET `/assets/*.js|css` from `dist/` behind the login |
| GET `/api/bots` | 304 | view | everything: accounts, editable, liveEnabled, stopAll, brokers, telegram, defaults, strategies, `botView[]`, `watchView[]` |
| GET `/api/check/<SYM>?broker=&leverage=` | 307 | view | symbol exists / leverage ok |
| POST `/api/bots` | 309 | edit | create bot (validate + checkSymbol) |
| GET `/api/bots/<id>/trades.csv` | 320 | view | download trades CSV |
| GET `/api/price/<SYM>?broker=` | 328 | view | price + contract rules |
| POST `/api/bots/<id>/manual` | 331 | edit, alert-mode only | queue manual / fill / cancel |
| POST `/api/bots/<id>/action` | 355 | edit | stop / close (market, limit, hold, at price) / disarm |
| POST `/api/watches` | 390 | edit | create watch |
| PUT, DELETE `/api/watches/<id>` | 400, 405 | edit | edit / delete watch |
| POST `/api/watches/<id>/start|stop|test` | 410, 415 | edit | toggle / Telegram test |
| POST `/api/strategies` | 423 | edit | save strategy |
| DELETE `/api/strategies/<id>` | 433 | edit | delete strategy |
| POST `/api/bots/<id>/invest` | 441 | edit | add funds (investment += add) |
| POST `/api/bots/<id>/tp` | 453 | edit | change tpPct |
| POST `/api/bots/<id>/cycles` | 462 | edit | raise maxCycles |
| GET, POST `/api/bots/<id>/maxadds[?to=n]` | 473 | edit (GET too) | preview / apply maxAdds up + extra investment (`maxAddsPlan` web.js:185) |
| POST `/api/stop-all` | 485 | edit | create/remove STOP_ALL |
| POST `/api/bots/<id>/start|stop` | 492 | edit | flip `enabled` (closed bots 409) |
| PUT `/api/bots/<id>` | 502 | edit | edit bot; symbol/leverage only when stopped and flat; dryRun only when stopped |
| DELETE `/api/bots/<id>` | 502 | edit | only when stopped and no open cycle |

Watch routes are all edit-gated, including GET-less ones (web.js:388). Routing is a chain of regexes in one handler; no body size limit check beyond `readBody` (web.js:274).

## 6. Dashboard (apps/web/, React 19 + Vite)

Replaced the single-file `web.html` on 2026-10-08 (the old page is in git at tag `pre-framework`). Same CSS (apps/web/src/styles.css, copied unchanged), same screens and texts; checked side by side in a browser.
- `apps/web/src/core.jsx`: data polling (`/api/bots` every 15 s), hash routes (`#/`, `#/bot/<id>/<tab>`), toasts + confirm dialog, `Sheet` / `Drawer` with the back gesture built in (one history entry per open panel; back closes the top one; closing on the page drops the entry).
- `apps/web/src/List.jsx` list page; `Detail.jsx` bot page (Overview, Parameters, Orders, History, swipe between tabs, cycle sheet); `Sheets.jsx` management sheets (More, manual order, fill, take profit, max adds, max cycles, add funds, stop / close); `Form.jsx` bot / alert form + order preview; `App.jsx` shell and which panel is open.
- `apps/web/src/lib/`: `format.js` numbers / times, `entry.js` entry-condition texts, `cycle.js` cycle numbers (`cycleRows` shows `pos.plan` adds for a live cycle).
- **No order math in the browser**: previews, the Orders tab and the minimum investment import `dca.mjs`, the same module the bot uses. `test/parity.js` checks the preview equals the bot's live ladder (243 settings).
- Build: `npm run build` (Vite, dev-only dependency); `npm run dev:ui` serves apps/web/ with /api proxied to :8787.

## 7. Tests

- `node test/units.js`: 46 tests, offline, temp `STOP_FILE` (units.js:7). Covers check timing, executor sim/live refusal, size cap + STOP_ALL, Binance adapter mapping, live gating, alerts/bus, decide, plan math incl. reference table (units.js:150), entry AND/OR/windows, indicator correctness (RSI/MACD), validation, portion migration, manual orders, maxAdds raise, armed stop/close, min order + top-up, fees, watches, per-condition tf/volatility, entry modes, by-hand fills, resting orders (place, add fill moves TP, TP closes and cancels, settings change re-prices only diffs, pos.plan fixed), strategies, pause, close hold/limit/market.
- `node test/sim.js [seed]`: real Engine vs fake exchange on synthetic prices; checks per tick: local vs exchange qty, not halted, orders <= maxAdds+1, qty sum, add px <= trigger, amount multiple, exit >= TP, pnl formula, one alert per fill.
- `node test/parity.js`: dashboard preview (dca.mjs) == bot ladder (strategy.js), 243 settings + the reference table.
- Not tested automatically: web.js routes, dashboard rendering (checked by hand in a browser), runner supervisor.

## 8. Pain points and refactor risks

Pain points:
- web.html is 1949 lines of CSS + markup + string-template JS with global state and manual `patch()` diffing; hard to change one screen safely.
- DCA math duplicated in browser (section 6) with no parity test; already diverges for open cycles.
- web.js is one regex-chain handler; edit gating, 404 lookup and validate-then-save repeated per route; `.env` loader duplicated with runner.js.
- (fixed 2026-10-08) Commands and settings now go through PostgreSQL transactions; no file IPC left.
- No API/UI tests; `botView` does network calls per bot on every 15 s poll.
- `bot.js` legacy CLI and `npm start` still point at the old single-bot path.

Refactor risks:
- Touching runner/engine/strategy while a live cycle is open: runner loads code once, so a restart picks up any change; invariants 1-9 must hold and `pos.plan` must be honoured.
- `node --watch web` restarts on every saved file, including during a refactor of shared modules web.js requires (bots.js, strategy.js, executor.js).
- State/config shape drift: a new validator dropping or renaming fields in the bots table / bot_state documents; back up the database (pg_dump) before migrations; keep backups and the current readers.
- Auth regressions on a publicly tunnelled dashboard (Basic + CF Access, fail closed, APP_FILES-only bypass).
- Browser math changes that silently differ from the engine's real orders.
