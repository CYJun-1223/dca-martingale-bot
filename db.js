// PostgreSQL storage for everything the bots keep: settings (bots, strategies, alert watches), each bot's state (open cycle,
// pos.plan, resting orders, history), each watch's state, the trade ledger and the dashboard -> bot command queue.
// DATABASE_URL in .env. If the database can't be reached every call throws: the engine saves BEFORE it sends an order,
// so a failed save means no order is sent (fail closed). Logs and the pause switch (STOP file) stay files on purpose.
const { Pool } = require('pg');

let pool = null;
const db = () => {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (.env)');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    pool.on('error', () => {}); // an idle client dropped (database restarted): the next query reconnects
  }
  return pool;
};
const q = (sql, params) => db().query(sql, params);

const SCHEMA = `
create table if not exists bots       (id text primary key, rec jsonb not null, pos serial);
create table if not exists strategies (id text primary key, name text not null, params jsonb not null, pos serial);
create table if not exists watches    (id text primary key, rec jsonb not null, pos serial);
create table if not exists bot_state  (bot_id text primary key, state jsonb not null, updated_at timestamptz not null default now());
create table if not exists watch_state(watch_id text primary key, state jsonb not null, updated_at timestamptz not null default now());
create table if not exists trades (
  id bigserial primary key, bot_id text not null, ts timestamptz not null, symbol text not null, cycle int,
  action text not null, ord int, qty numeric, price numeric, margin numeric, avg_price numeric, pnl numeric,
  opened_at timestamptz, held text, mode text);
create index if not exists trades_bot on trades (bot_id, id);
create table if not exists commands (id bigserial primary key, bot_id text not null, cmd jsonb not null, at timestamptz not null default now());
create index if not exists commands_bot on commands (bot_id, id);`;
const migrate = () => q(SCHEMA);

// ---------- settings: an ordered list of records, replaced as a whole (same as the old JSON files) ----------
// replace = delete what is gone, upsert the rest, keep the given order; one transaction
async function replaceList(table, rows, toValues) {
  const c = await db().connect();
  try {
    await c.query('begin');
    await c.query(`delete from ${table} where not (id = any($1))`, [rows.map(r => r.id)]);
    for (const [i, r] of rows.entries()) {
      const [cols, vals] = toValues(r);
      const set = cols.map((k, j) => `${k} = $${j + 2}`).join(', ');
      await c.query(`insert into ${table} (id, ${cols.join(', ')}, pos) values ($1, ${cols.map((_, j) => `$${j + 2}`).join(', ')}, $${cols.length + 2})
        on conflict (id) do update set ${set}, pos = $${cols.length + 2}`, [r.id, ...vals, i]);
    }
    await c.query('commit');
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}
const listBots = async () => (await q('select rec from bots order by pos')).rows.map(r => r.rec);
const saveBots = rows => replaceList('bots', rows, r => [['rec'], [r]]);
const listWatches = async () => (await q('select rec from watches order by pos')).rows.map(r => r.rec);
const saveWatches = rows => replaceList('watches', rows, r => [['rec'], [r]]);
const listStrategies = async () => (await q('select id, name, params from strategies order by pos')).rows;
const saveStrategies = rows => replaceList('strategies', rows, r => [['name', 'params'], [r.name, r.params]]);

// ---------- state documents: one per bot / watch, written as a whole ----------
// The JSON is taken at the moment of the call, so later changes to the object can't leak into this write.
const loadState = async id => { const r = await q('select state from bot_state where bot_id = $1', [id]); return r.rows[0] ? r.rows[0].state : null; };
const saveState = (id, st) => q(`insert into bot_state (bot_id, state) values ($1, $2) on conflict (bot_id) do update set state = $2, updated_at = now()`, [id, JSON.stringify(st)]);
const loadWatchState = async id => { const r = await q('select state from watch_state where watch_id = $1', [id]); return r.rows[0] ? r.rows[0].state : null; };
const saveWatchState = (id, st) => q(`insert into watch_state (watch_id, state) values ($1, $2) on conflict (watch_id) do update set state = $2, updated_at = now()`, [id, JSON.stringify(st)]);
// with the time of the last save: a recent one means the process behind it is alive
const stateRow = async (table, key, id) => { const r = await q(`select state, updated_at from ${table} where ${key} = $1`, [id]); return r.rows[0] ? { state: r.rows[0].state, at: r.rows[0].updated_at.getTime() } : { state: null, at: 0 }; };
const botStateRow = id => stateRow('bot_state', 'bot_id', id);
const watchStateRow = id => stateRow('watch_state', 'watch_id', id);
const statesOf = async ids => Object.fromEntries((await q('select bot_id, state from bot_state where bot_id = any($1)', [ids])).rows.map(r => [r.bot_id, r.state]));

// ---------- trade ledger: one row per open / add / take profit / close / reduce ----------
const TRADE_COLS = ['bot_id', 'ts', 'symbol', 'cycle', 'action', 'ord', 'qty', 'price', 'margin', 'avg_price', 'pnl', 'opened_at', 'held', 'mode'];
const addTrade = t => q(`insert into trades (${TRADE_COLS.join(', ')}) values (${TRADE_COLS.map((_, i) => `$${i + 1}`).join(', ')})`, TRADE_COLS.map(k => t[k] ?? null));
const tradesOf = async id => (await q('select * from trades where bot_id = $1 order by id', [id])).rows;

// ---------- dashboard -> bot commands: the bot takes them all at once (taken = deleted, in one statement) ----------
const addCommand = (botId, cmd) => q('insert into commands (bot_id, cmd) values ($1, $2)', [botId, cmd]);
const takeCommands = async botId => (await q('delete from commands where bot_id = $1 returning id, cmd', [botId])).rows.sort((a, b) => a.id - b.id).map(r => r.cmd);
const pendingCommands = async botId => (await q('select cmd from commands where bot_id = $1 order by id', [botId])).rows.map(r => r.cmd);
const hasCommands = async botId => (await q('select 1 from commands where bot_id = $1 limit 1', [botId])).rowCount > 0;

const end = () => pool ? pool.end().then(() => { pool = null; }) : Promise.resolve();

module.exports = { q, migrate, listBots, saveBots, listWatches, saveWatches, listStrategies, saveStrategies, loadState, saveState, statesOf,
  loadWatchState, saveWatchState, botStateRow, watchStateRow, addTrade, tradesOf, addCommand, takeCommands, pendingCommands, hasCommands, end };
