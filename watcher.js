// One alert-only watch: it looks right after a candle closes (on the shortest K-line its indicators use). Every
// candle on which any of its indicators fires is sent to Telegram (and the alert log) and remembered.
// Never places orders.
const fs = require('fs');
const path = require('path');
const { createMarket, nextCheckAt, TF_MS } = require('./market');
const { Alerts } = require('./alerts');
const S = require('./strategy');
const watches = require('./watches');
const db = require('./db');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const localTime = ts => new Date(ts).toLocaleString('sv-SE').slice(0, 16);


// look at the candles that closed since the last look; one alert per candle on which something fired.
// Returns the alerts it sent.
async function checkOnce({ cfg, market, alerts, st, pdp }) {
  const tf = watches.watchTf(cfg), entry = watches.explicitEntry(cfg); // the shortest K-line is the timeline
  const bars = await market.closedBars(tf, 300);
  const price = await market.lastPrice();
  st.lastCheck = { ts: Date.now(), price };
  const last = bars[bars.length - 1];
  if (!last || last.ts <= st.lastBarTs) return [];
  const first = st.lastBarTs === 0; // on the very first look only remember the candle: no alert for something that happened before the watch existed
  const from = Math.max(bars.findIndex(b => b.ts > st.lastBarTs), bars.length - 12, 1); // a few candles back at most, after a gap
  st.lastBarTs = last.ts;
  if (first) return [];
  const sigs = entry.groups[0].signals, extra = {};
  for (const t of S.distinctTfs(entry, tf)) if (t !== tf) extra[t] = await market.closedBars(t, 300);
  const barsBy = { ...extra, [tf]: bars }, tests = sigs.map(s => S.signalTest(s, barsBy, bars, tf));
  const sent = [];
  for (let i = from; i < bars.length; i++) {
    const fired = sigs.filter((_, k) => tests[k](i));
    if (!fired.length) continue;
    const rec = { ts: bars[i].ts, price: bars[i].c, text: `${fired.map(S.describe).join(' + ')}\n${tf} candle ${localTime(bars[i].ts)} closed at ${bars[i].c.toFixed(pdp)}` };
    st.signals.unshift(rec);
    st.signals.length = Math.min(st.signals.length, 100);
    await alerts.send('signal', rec.text);
    sent.push(rec);
  }
  return sent;
}

async function runWatch(record, wanted, { api, dir }) {
  let w = record, cfg = watches.cfgFor(w);
  const market = createMarket(cfg, api);
  const alerts = new Alerts(cfg, { dir, botId: w.name, topic: watches.topic(w) });
  const st = { lastBarTs: 0, signals: [], ...(await db.loadWatchState(w.id)) };
  const pdp = +(await market.contract()).pricePlace || 2;
  const save = () => db.saveWatchState(w.id, st);
  fs.appendFileSync(path.join(dir, cfg.logFile), `${localTime(Date.now())} started watching ${cfg.symbol} (${watches.watchTf(cfg)} candles): ${S.describeEntry(S.entryOf(cfg))}\n`);
  let errors = 0;
  while (wanted()) {
    const fresh = (await watches.list()).find(x => x.id === w.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(w)) { // edits from the dashboard (symbol and broker never change)
      const keep = { symbol: cfg.symbol, broker: cfg.broker };
      Object.assign(cfg, watches.cfgFor(fresh), keep);
      alerts.cfg = cfg; alerts.botId = fresh.name;
      w = fresh;
    }
    try {
      await checkOnce({ cfg, market, alerts, st, pdp });
      await save();
      errors = 0;
    } catch (err) {
      errors++;
      fs.appendFileSync(path.join(dir, cfg.logFile), `${localTime(Date.now())} check failed (${errors}): ${err.message}\n`);
    }
    // next look: right after the next candle closes. If the candle that just closed isn't listed yet, look again in 15 s (for up to 3 min)
    const tf = watches.watchTf(cfg), ms = TF_MS[tf], now = Date.now(), due = Math.floor(now / ms) * ms - ms;
    const late = st.lastBarTs > 0 && st.lastBarTs < due && now - (due + ms) < 180e3;
    const wait = errors ? Math.min(15e3 * 2 ** errors, 10 * 60e3) : late ? 15e3 : nextCheckAt(now, tf) - now;
    for (let t = 0; t < wait && wanted(); t += 1000) {
      await sleep(Math.min(1000, wait - t));
      const f = t % 5000 ? null : (await watches.list()).find(x => x.id === w.id); // look for edits every 5 s
      if (!errors && f && JSON.stringify(f) !== JSON.stringify(w)) break; // edited: apply now
    }
  }
}

module.exports = { runWatch, checkOnce };
