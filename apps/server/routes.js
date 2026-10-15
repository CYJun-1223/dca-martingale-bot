// The dashboard's JSON API as a route table (see router.js). Every route that changes something is an "edit" route: web.js refuses
// those in --readonly mode before routing. Errors thrown here become `400 { error }` in web.js.
//   const router = buildRoutes({ views, runtime })
const fs = require('fs');
const bots = require('./bots');
const watches = require('./watches');
const { Alerts } = require('./alerts');
const { toCsv } = require('./recorder');
const db = require('./db');
const { BROKERS } = require('./market');
const { liveEnabled, STOP_FILE } = require('./executor');
const { Router, send, readBody } = require('./router');

function buildRoutes({ views, runtime, edit }) {
  const { price, contract, checkSymbol, marketFor, accounts, maxAddsPlan, botView, watchView } = views;
  const router = new Router();
  const get = (p, h, o) => router.add('GET', p, h, o), post = (p, h, o) => router.add('POST', p, h, o);
  const put = (p, h, o) => router.add('PUT', p, h, o), del = (p, h, o) => router.add('DELETE', p, h, o);

  // a command for the running bot (stop, close, manual order, fill...): it takes the queue on its next check
  const enqueue = (bot, cmd) => db.addCommand(bot.id, cmd);
  const now = () => new Date().toISOString();

  // the bot list with the index of one bot; answers 404 itself and returns null when there is no such bot
  async function withBot(res, id, notFound = 'bot not found') {
    const list = await bots.list(), i = list.findIndex(b => b.id === id);
    if (i < 0) { send(res, 404, { error: notFound }); return null; }
    return { list, i, bot: list[i] };
  }

  // ---------------------------------------------------------------- read
  get('/api/bots', async ({ res }) => send(res, 200, {
    accounts: await accounts(), editable: edit, liveEnabled: liveEnabled(), stopAll: fs.existsSync(STOP_FILE), brokers: BROKERS,
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), defaults: require('./config'), strategies: await bots.listStrategies(),
    bots: await Promise.all((await bots.list()).map(botView)), watches: await Promise.all((await watches.list()).map(watchView)),
  }));

  get(/^\/api\/check\/(?<sym>[A-Z0-9]+)\?broker=(?<broker>[a-z]+)&leverage=(?<leverage>\d*)$/, async ({ res, params: p }) =>
    send(res, 200, BROKERS[p.broker] ? await checkSymbol(p.sym, p.broker, p.leverage) : { ok: false, message: 'unknown broker' }));

  get(/^\/api\/price\/(?<sym>[A-Z0-9]+)(?:\?broker=(?<broker>[a-z]+))?$/, async ({ res, params: p }) =>
    send(res, 200, { price: await price(p.sym, p.broker || 'bitget'), contract: await contract(p.sym, p.broker || 'bitget') }));

  get('/api/bots/:id/trades.csv', async ({ res, params }) => {
    const bot = (await bots.list()).find(b => b.id === params.id);
    const rows = bot ? await db.tradesOf(bot.id) : [];
    if (!rows.length) return send(res, 404, { error: 'no trades recorded yet' });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="trades-${bot.id}.csv"` });
    res.end(toCsv(rows));
  });

  // ---------------------------------------------------------------- bots: create, edit, delete, start / stop
  post('/api/bots', async ({ req, res }) => {
    const list = await bots.list();
    const bot = bots.validate(await readBody(req), list);
    // the symbol must exist on the chosen broker (e.g. SOXX is on Bitget, not Binance)
    const ck = await checkSymbol(bot.symbol, bot.broker, bot.leverage);
    if (!ck.ok) throw new Error(ck.message);
    list.push(bot);
    await bots.save(list);
    send(res, 201, bot);
  });

  put('/api/bots/:id', async ({ req, res, params }) => {
    const f = await withBot(res, params.id, `no bot "${params.id}"`);
    if (!f) return;
    const { list, i } = f, old = list[i], bot = bots.validate(await readBody(req), list, old);
    if (bot.symbol !== old.symbol || bot.leverage !== old.leverage) {
      const ov = await botView(old);
      if (ov.enabled || ov.pos) throw new Error('Stop the bot and wait for its open cycle to close before changing the symbol or leverage.');
      const ck = await checkSymbol(bot.symbol, bot.broker, bot.leverage);
      if (!ck.ok) throw new Error(ck.message);
    }
    if (bot.dryRun !== old.dryRun && (await botView(old)).running) throw new Error('Stop the bot before switching between alert and live mode.');
    list[i] = bot;
    await bots.save(list);
    send(res, 200, bot);
  });

  del('/api/bots/:id', async ({ res, params }) => {
    const f = await withBot(res, params.id, `no bot "${params.id}"`);
    if (!f) return;
    const { list, i } = f, v = await botView(list[i]);
    if (v.enabled) return send(res, 409, { error: 'Stop the bot before deleting it.' });
    if (v.pos) return send(res, 409, { error: `It still has an open cycle (#${v.pos.id}). Wait until it closes.` });
    list.splice(i, 1);
    await bots.save(list);
    send(res, 200, { deleted: params.id });
  });

  // Start / Stop: flips `enabled`; runner.js starts or stops the bot within seconds
  router.add('POST', '/api/bots/:id/:what(start|stop)', async ({ res, params }) => {
    const f = await withBot(res, params.id);
    if (!f) return;
    const { list, i } = f;
    if (params.what === 'start' && list[i].closedAt) return send(res, 409, { error: 'This bot was closed and cannot be started again.' });
    list[i] = { ...list[i], enabled: params.what === 'start', updatedAt: now() };
    await bots.save(list);
    send(res, 200, { enabled: list[i].enabled });
  });

  // ---------------------------------------------------------------- bots: settings changed while it runs
  // add funds: raises the investment (the orders still to place get bigger; planned ones already filled stay)
  post('/api/bots/:id/invest', async ({ req, res, params }) => {
    const f = await withBot(res, params.id);
    if (!f) return;
    const { list, i } = f, add = +(await readBody(req)).add;
    if (!(add > 0)) throw new Error('Enter an amount above 0.');
    list[i] = bots.validate({ ...list[i], investment: +(list[i].investment + add).toFixed(2) }, list, list[i]);
    await bots.save(list);
    send(res, 200, { investment: list[i].investment });
  });

  // take profit % (any value)
  post('/api/bots/:id/tp', async ({ req, res, params }) => {
    const f = await withBot(res, params.id);
    if (!f) return;
    const { list, i } = f;
    list[i] = bots.validate({ ...list[i], tpPct: (await readBody(req)).tpPct }, list, list[i]);
    await bots.save(list);
    send(res, 200, { tpPct: list[i].tpPct });
  });

  // max cycles: up only (0 = no limit); works while the bot runs
  post('/api/bots/:id/cycles', async ({ req, res, params }) => {
    const f = await withBot(res, params.id);
    if (!f) return;
    const { list, i } = f, to = +(await readBody(req)).maxCycles;
    if (list[i].maxCycles > 0 && to === list[i].maxCycles) return send(res, 400, { error: `Max cycles is already ${to}: choose more, or 0 for no limit.` });
    list[i] = bots.validate({ ...list[i], maxCycles: to }, list, list[i]);
    await bots.save(list);
    send(res, 200, { maxCycles: list[i].maxCycles });
  });

  // max add orders: up only, the investment grows by what the new orders need. GET = the quote, POST = apply
  const maxAddsUrl = /^\/api\/bots\/(?<id>[a-z0-9-]+)\/maxadds(?:\?to=(?<to>\d+))?$/;
  get(maxAddsUrl, async ({ res, params }) => {
    const f = await withBot(res, params.id);
    if (f) send(res, 200, await maxAddsPlan(f.bot, +params.to));
  });
  post(maxAddsUrl, async ({ req, res, params }) => {
    const f = await withBot(res, params.id);
    if (!f) return;
    const { list, i } = f, plan = await maxAddsPlan(list[i], +(await readBody(req)).maxAdds);
    list[i] = bots.validate({ ...list[i], maxAdds: plan.to, investment: plan.investmentAfter }, list, list[i]);
    await bots.save(list);
    send(res, 200, plan);
  });

  // ---------------------------------------------------------------- bots: orders for the running bot
  // manual order: queued for the bot, which adds it to its cycle on the next check
  post('/api/bots/:id/manual', async ({ req, res, params }) => {
    const bot = (await bots.list()).find(b => b.id === params.id);
    if (!bot) return send(res, 404, { error: 'bot not found' });
    if (!bot.dryRun) throw new Error('A live bot only records real Bitget fills: manual orders and typed fills are off.');
    // { side: buy | sell, orderType: market | limit, px (limit only), qty }  or  { cancel: ref }
    const body = await readBody(req);
    let cmd;
    if (body.cancel) cmd = { type: 'cancel', ref: String(body.cancel), at: Date.now() };
    else if (body.fill) { // the real fill from the exchange: the bot takes it as the next planned order (buy) or closes / reduces (sell)
      if (!(+body.px > 0) || !(+body.qty > 0)) throw new Error('Enter the fill price and size from the exchange.');
      cmd = { type: 'fill', side: body.side === 'sell' ? 'sell' : 'buy', px: +body.px, qty: +body.qty, at: Date.now() };
    } else {
      const side = body.side === 'sell' ? 'sell' : 'buy', orderType = body.orderType === 'limit' ? 'limit' : 'market';
      if (!(+body.qty > 0)) throw new Error('Enter an amount above 0.');
      if (orderType === 'limit' && !(+body.px > 0)) throw new Error('Enter a limit price above 0.');
      cmd = { type: 'manual', ref: `m${Date.now()}`, side, orderType, px: orderType === 'limit' ? +body.px : null, qty: +body.qty, at: Date.now() };
    }
    await enqueue(bot, cmd);
    send(res, 200, { queued: (await db.pendingCommands(bot.id)).length });
  });

  // stop / close the bot now or at a price; or cancel an armed one
  post('/api/bots/:id/action', async ({ req, res, params }) => {
    const f = await withBot(res, params.id);
    if (!f) return;
    const { list, i, bot } = f, body = await readBody(req);
    if (bot.closedAt) throw new Error('This bot is closed.');
    if (body.action === 'disarm') {
      if (body.what !== 'stop' && body.what !== 'close') throw new Error('Nothing to cancel.');
      await enqueue(bot, { type: 'disarm', what: body.what, at: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (body.action !== 'stop' && body.action !== 'close') throw new Error('Unknown action.');
    // close: how = 'market' (now / when a price is reached), 'limit' (a limit sell at px; the bot closes when it fills) or 'hold' (keep the position)
    const how = body.action === 'close' && (body.how === 'hold' || body.how === 'limit') ? body.how : 'market';
    const px = how === 'hold' || body.px === undefined || body.px === null || body.px === '' ? null : +body.px;
    if (px !== null && !(px > 0)) throw new Error('Enter a price above 0.');
    if (how === 'limit' && px === null) throw new Error('Enter the limit price to sell at.');
    if (body.action === 'stop' && px === null) { // stopping now just turns the bot off
      list[i] = { ...bot, enabled: false, updatedAt: now() };
      await bots.save(list);
      return send(res, 200, { stopped: true });
    }
    const v = await botView(bot);
    if (!v.running) throw new Error(body.action === 'close' ? 'Start the bot first: it has to be running to place the closing order.' : 'Start the bot first: it has to be running to watch the price.');
    if (how === 'market' && px !== null && !v.price) throw new Error('No price available right now. Try again in a moment.');
    if (how === 'market' && px !== null && px === v.price) throw new Error('That is the current price: choose now instead.');
    await enqueue(bot, { type: body.action, ...(body.action === 'close' ? { how } : {}), px, dir: how !== 'market' || px === null ? undefined : px > v.price ? 'up' : 'down', at: Date.now() });
    send(res, 200, { queued: true });
  });

  // STOP ALL: while the STOP_ALL file exists no live bot sends an order (closing included); bots keep running and retry
  post('/api/stop-all', async ({ req, res }) => {
    const on = (await readBody(req)).on === true;
    if (on) fs.writeFileSync(STOP_FILE, now()); else if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);
    send(res, 200, { stopAll: on });
  });

  // ---------------------------------------------------------------- strategies: saved martingale parameters for the new-bot form
  post('/api/strategies', async ({ req, res }) => {
    const body = await readBody(req), name = String(body.name || '').trim().slice(0, 40);
    if (!name) throw new Error('Give the strategy a name.');
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'strategy';
    const all = (await bots.listStrategies()).filter(x => x.id !== id);
    all.push({ id, name, params: bots.parseStrategy(body.params || {}) });
    await bots.saveStrategies(all);
    send(res, 200, { id, strategies: all });
  });

  del('/api/strategies/:id', async ({ res, params }) => {
    const all = (await bots.listStrategies()).filter(x => x.id !== params.id);
    await bots.saveStrategies(all);
    send(res, 200, { strategies: all });
  });

  // ---------------------------------------------------------------- alert-only watches
  // watch ids are not limited to the bot id characters, and these routes ignore a query string
  post('/api/watches', async ({ req, res }) => {
    const list = await watches.list(), w = watches.validate(await readBody(req), list);
    try { await marketFor(w.symbol, w.broker).contract(); }
    catch (e) { throw new Error(`${w.symbol} is not available on ${BROKERS[w.broker].label}: ${e.message}`); }
    list.push(w);
    await watches.save(list);
    send(res, 201, w);
  }, { ignoreQuery: true });

  // the watch list with the index of one watch; answers 404 itself when there is none
  async function withWatch(res, id) {
    const list = await watches.list(), i = list.findIndex(x => x.id === id);
    if (i < 0) { send(res, 404, { error: 'alert not found' }); return null; }
    return { list, i };
  }

  put(`/api/watches/:id([^/?]+)`, async ({ req, res, params }) => {
    const f = await withWatch(res, params.id);
    if (!f) return;
    const { list, i } = f;
    list[i] = watches.validate(await readBody(req), list, list[i]);
    await watches.save(list);
    send(res, 200, list[i]);
  }, { ignoreQuery: true });

  del(`/api/watches/:id([^/?]+)`, async ({ res, params }) => {
    const f = await withWatch(res, params.id);
    if (!f) return;
    f.list.splice(f.i, 1);
    await watches.save(f.list);
    send(res, 200, { deleted: params.id });
  }, { ignoreQuery: true });

  post(`/api/watches/:id([^/?]+)/:what(start|stop)`, async ({ res, params }) => {
    const f = await withWatch(res, params.id);
    if (!f) return;
    const { list, i } = f;
    list[i] = { ...list[i], enabled: params.what === 'start', updatedAt: now() };
    await watches.save(list);
    send(res, 200, { enabled: list[i].enabled });
  }, { ignoreQuery: true });

  post(`/api/watches/:id([^/?]+)/test`, async ({ res, params }) => { // a real Telegram message, so the user knows it reaches them
    const f = await withWatch(res, params.id);
    if (!f) return;
    const w = f.list[f.i], a = new Alerts(watches.cfgFor(w), { dir: runtime, botId: w.name, topic: watches.topic(w) });
    if (!a.sendFn) throw new Error('Telegram is not set up: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env and restart.');
    await a.telegram(`🔔 Test: ${w.name} (${w.symbol} ${w.tf}) is watching. Alerts will arrive here.`);
    send(res, 200, { sent: true });
  }, { ignoreQuery: true });

  return router;
}

module.exports = { buildRoutes };
