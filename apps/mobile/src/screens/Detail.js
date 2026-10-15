// One bot: header, then Overview / Parameters / Orders / History, and Start / Stop.
import { Fragment, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { useData } from '../data';
import { useTheme, dirColor, mono } from '../theme';
import { Banner, Button, Card, Faint, Kv, Label, StatusDot, Tag } from '../ui';
import { confirm, notify } from '../confirm';
import { brokerName } from './List';
import { fx, money, ago, when, heldFor, feeFx, coinOf } from '../../../web/src/lib/format.js';
import { entryOf, entryText, sigLabel, usesAnd } from '../../../web/src/lib/entry.js';
import { botNumbers, cycleRows, cycleTx, cycleNet, restState } from '../../../web/src/lib/cycle.js';
import { firstMargin, planRows } from '../../../server/dca.mjs';

const TABS = [['overview', 'Overview'], ['settings', 'Parameters'], ['orders', 'Orders'], ['history', 'History']];

function Head({ v }) {
  const t = useTheme(), { S } = useData(), b = v.bot, created = Date.parse(b.createdAt), e = entryOf(b);
  const tags = [brokerName(S, b), 'Martingale', 'Long', `${b.leverage}x`, b.dryRun ? '' : 'LIVE'].filter(Boolean);
  return <View style={{ gap: 8 }}>
    <View style={s.row}><Text style={{ color: t.ink, fontSize: 24, fontWeight: '700', flexShrink: 1 }}>{b.name}</Text><StatusDot status={v.status} halted={v.state && v.state.halted} /></View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{tags.map(x => <Tag key={x} color={x === 'Long' ? t.up : x === 'LIVE' ? t.down : undefined}>{x}</Tag>)}</View>
    <Faint>{b.symbol} · {entryText(e)}{e.mode ? '' : ` · ${b.tf}`}</Faint>
    {created ? <Faint>Created {when(created)}, running {heldFor(Date.now() - created)}</Faint> : null}
    {['stop', 'close'].filter(k => v.armed && v.armed[k]).map(k => {
      const a = v.armed[k], at = a.now ? 'at the next check' : `when the price ${a.dir === 'up' ? 'rises to' : 'falls to'} ${fx(a.px)}`;
      return <Banner key={k}>{k === 'stop' ? 'Stop' : 'Close'} set {at}{a.queued ? ' (sending…)' : ''}. Cancel it in the web dashboard.</Banner>;
    })}
    {v.short ? <Banner>Order #{v.short.n} can't open: the exchange minimum needs at least {fx(v.short.need)} USDT margin. Until then it is skipped and the bot keeps running.</Banner> : null}
    {v.status === 'closed' ? <Banner>This bot was closed{b.closedAt ? ` on ${when(Date.parse(b.closedAt))}` : ''}. It cannot be started again.</Banner> : null}
    {v.status === 'down' ? <Banner tone="bad">No check since {ago(v.lastSeen)}. The computer running the bots may be asleep or offline.</Banner> : null}
    {v.state && v.state.halted ? <Banner tone="bad">The exchange position doesn't match the bot's records. New entries are paused until they match.</Banner> : null}
  </View>;
}

function PnlChart({ v, n }) {
  const t = useTheme();
  const pts = [[Date.parse(n.b.createdAt) || (v.history.length ? v.history[v.history.length - 1].openedAt : Date.now() - 864e5), 0]];
  let cum = 0;
  for (const h of v.history.slice().reverse()) { cum += cycleNet(h); pts.push([h.closedAt, cum]); }
  pts.push([Date.now(), n.total]);
  const W = 320, H = 150, L = 44, B = 20, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys), pad = (yMax - yMin || 1) * 0.1;
  const X = u => L + (u - x0) / ((x1 - x0) || 1) * (W - L - 6), Y = y => 6 + (yMax + pad - y) / ((yMax - yMin) + 2 * pad || 1) * (H - B - 6);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const day = u => new Date(u).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
  return <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
    <Line x1={L} x2={W} y1={Y(0)} y2={Y(0)} stroke={t.line} strokeDasharray="3 3" />
    <SvgText x={L - 6} y={Y(yMax + pad) + 4} fontSize="10" fill={t.ink3} textAnchor="end">{fx(yMax, 2)}</SvgText>
    <SvgText x={L - 6} y={Y(yMin - pad)} fontSize="10" fill={t.ink3} textAnchor="end">{fx(yMin, 2)}</SvgText>
    <SvgText x={L} y={H - 4} fontSize="10" fill={t.ink3}>{day(x0)}</SvgText>
    <SvgText x={W - 6} y={H - 4} fontSize="10" fill={t.ink3} textAnchor="end">{day(x1)}</SvgText>
    <Path d={d} stroke={t.accent} strokeWidth="2" fill="none" />
    {pts.map((p, i) => <Circle key={i} cx={X(p[0])} cy={Y(p[1])} r="2.5" fill={t.accent} />)}
  </Svg>;
}

const Grid = ({ children }) => <View style={s.grid}>{Children2(children)}</View>;
const Children2 = c => (Array.isArray(c) ? c : [c]).filter(Boolean).map((x, i) => <View key={i} style={s.cell}>{x}</View>);

function OverviewPane({ v }) {
  const t = useTheme(), n = botNumbers(v), p = n.p, sym = coinOf(n.b.symbol), R = v.resting;
  const list = R ? [R.tp, ...Object.values(R.adds)].filter(Boolean) : [], open = list.filter(o => o.onExchange === true).length, bad = list.length - open;
  return <View style={{ gap: 14 }}>
    <Card><Grid>
      <Kv label="Total P&L" value={money(n.total, 4)} unit="USDT" color={dirColor(t, n.total)} />
      <Kv label="Return" value={`${money(n.capital ? n.total / n.capital * 100 : 0, 2)}%`} sub={`on ${fx(n.capital, 2)} USDT`} color={dirColor(t, n.total)} />
      <Kv label="Unrealized" value={money(v.upnl, 4)} unit="USDT" sub={p && p.pnlPct != null ? `${money(p.pnlPct, 1)}% on margin` : ''} color={dirColor(t, v.upnl)} />
      <Kv label="Average price" value={p ? fx(p.avg) : '–'} unit={p ? 'USDT' : ''} />
      <Kv label="Margin used" value={fx(p ? p.margin : 0, 4)} unit="USDT" sub={`investment ${fx(n.mg.investment, 0)}${n.manual ? ` + manual ${fx(n.manual)}` : ''}`} />
      <Kv label="Position" value={p ? `${p.qty}` : '–'} unit={p ? sym : ''} />
      <Kv label="Add orders" value={`${Math.max(0, n.planN - 1)} | ${n.b.maxAdds}`} sub={n.manual ? '+ manual order' : ''} />
      <Kv label="Cycles closed" value={`${v.history.length}`} sub={`realized ${money(n.realized, 4)} USDT`} />
      <Kv label="Take profit" value={p ? fx(p.tp) : '–'} sub={n.toTp !== null ? `+${fx(n.toTp, 2)}% away` : `${n.b.tpPct}% above average`} />
      <Kv label="Next add" value={p ? (p.nextAdd ? fx(p.nextAdd) : 'none left') : '–'} sub={n.toAdd !== null ? `−${fx(n.toAdd, 2)}% away` : ''} />
      {R ? <Kv label="Orders on Bitget" value={`${open}`} unit="pending" color={R.error || bad ? t.down : t.up}
        sub={R.error ? `can't read Bitget: ${R.error}` : `${Object.keys(R.adds).length} buys + ${R.tp ? '1 take profit' : 'no take profit'}${bad ? ` · ${bad} not found` : ''}`} /> : null}
      <Kv label="Funding rate" value={v.funding ? `${fx(v.funding.rate * 100, 4)}%` : '–'} sub={v.funding ? `every ${v.funding.hours}h` : ''} />
      <Kv label="Price" value={fx(v.price)} sub={`checked ${ago(v.lastCheck ? v.lastCheck.ts : v.lastSeen)}`} />
    </Grid></Card>
    <Card style={{ gap: 6 }}><Label>P&L over time</Label><PnlChart v={v} n={n} /></Card>
  </View>;
}

function ParamsPane({ v }) {
  const t = useTheme(), { S } = useData(), b = v.bot, e = entryOf(b), mg = botNumbers(v).mg;
  const G = ({ title, rows }) => <Card style={{ gap: 8 }}><Text style={{ color: t.ink, fontWeight: '700' }}>{title}</Text>
    {rows.map(([k, x]) => <View key={k} style={s.row}><Text style={{ color: t.ink2, fontSize: 14, flex: 1 }}>{k}</Text><Text style={[mono, { color: t.ink, fontSize: 14, fontWeight: '600', flex: 1.4, textAlign: 'right' }]}>{x}</Text></View>)}</Card>;
  return <View style={{ gap: 12 }}>
    <G title="Market" rows={[['Broker', brokerName(S, b)], ['Symbol', b.symbol], ...(e.mode ? [] : [['K-line', b.tf]]), ['Hours', b.usMarketHoursOnly ? 'US market only' : '24/7']]} />
    <G title="Entry" rows={e.mode ? [['First order', entryText(e)]] : [
      ...e.groups.map((gr, i) => [`Group ${i + 1}${gr.signals.length > 1 ? ` (${gr.logic === 'and' ? 'all' : 'any'})` : ''}`, gr.signals.map(sigLabel).join(gr.logic === 'and' ? ' AND ' : ' OR ')]),
      ...(e.groups.length > 1 ? [['Groups combine', e.logic === 'and' ? 'All (AND)' : 'Any (OR)']] : []), ...(usesAnd(e) ? [['AND window', `${e.window} bars`]] : [])]} />
    <G title="Martingale" rows={[['Investment', `${fx(mg.investment, 0)} USDT`], ['Leverage', `${mg.leverage}x ${b.marginMode === 'isolated' ? 'isolated' : 'cross'}`], ['First order', `${fx(firstMargin(mg))} USDT`],
      ['Max add orders', mg.maxAdds], ['Price step', `${mg.stepPct}% × ${mg.stepMult}`], ['Amount multiple', `× ${mg.amountMult}`], ['Take profit', `${mg.tpPct}% above average`], ['Stop loss', 'None']]} />
    <Faint>To change parameters, use the web dashboard.</Faint>
  </View>;
}

function OrdersPane({ v }) {
  const t = useTheme(), n = botNumbers(v), p = n.p, px = v.price;
  const rows = p ? cycleRows(p, n.mg, v.contract) : px ? planRows(n.mg, px, v.contract) : [];
  const R = v.resting;
  const bar = !R || !v.pos ? null : R.error ? <Banner>Can't read Bitget right now ({R.error}). Orders may still be resting there.</Banner>
    : !v.enabled ? <Banner>Bot stopped. {R.tp && R.tp.onExchange ? 'The take profit is still pending on Bitget; the buys were cancelled.' : 'Nothing is pending on Bitget for this position.'}</Banner>
    : null;
  return <View style={{ gap: 10 }}>
    {bar}
    {p ? <Card style={{ gap: 4 }}><Label>Take profit</Label><Text style={[mono, { color: t.up, fontSize: 18, fontWeight: '700' }]}>{p.qty} @ {fx(p.tp)}</Text>
      <Faint>average {fx(p.avg)}{px ? ` · now ${fx(px)}` : ''}</Faint></Card> : null}
    <Text style={{ color: t.ink2, fontWeight: '600' }}>{p ? 'Ladder' : 'Plan (no open cycle)'}</Text>
    {rows.map((r, i) => {
      const st = p && !r.filled && !r.manual ? restState(v, R && R.adds ? R.adds[r.n] : null) : '';
      const mark = r.filled ? '✓' : st === 'pend' ? '●' : st === 'miss' ? '!' : '○';
      const c = r.filled ? t.up : st === 'pend' ? t.up : st === 'miss' ? t.down : t.ink3;
      return <Card key={`${r.n}-${i}`} style={{ gap: 4, opacity: r.filled ? 1 : 0.95 }}>
        <View style={s.row}><Text style={{ color: t.ink, fontWeight: '700' }}><Text style={{ color: c }}>{mark} </Text>{r.manual ? 'Manual' : r.n === 0 ? 'Open' : `Add #${r.n}`}</Text>
          <Text style={[mono, { color: t.ink, fontWeight: '700' }]}>{r.qty} @ {fx(r.px)}</Text></View>
        <View style={s.row}><Faint>drop {fx(r.drop, 2)}% · margin {fx(r.m, 2)}</Faint><Faint>avg {fx(r.avg)} · TP {fx(r.tp)}</Faint></View>
      </Card>;
    })}
  </View>;
}

function HistoryPane({ v }) {
  const t = useTheme(), [openId, setOpenId] = useState(null), coin = coinOf(v.bot.symbol);
  if (!v.history.length) return <Card><Faint>No closed cycles yet.</Faint></Card>;
  return <View style={{ gap: 10 }}>
    {v.history.map((h, i) => {
      const net = cycleNet(h), isOpen = openId === i, tx = isOpen ? cycleTx(h) : [];
      return <Card key={i} style={{ gap: 6 }} onPress={() => setOpenId(isOpen ? null : i)}>
        <View style={s.row}><Text style={{ color: t.ink, fontWeight: '700' }}>Cycle #{h.id}</Text><Text style={[mono, { color: dirColor(t, net), fontWeight: '700' }]}>{money(net)} USDT</Text></View>
        <Faint>closed {when(h.closedAt)} · held {heldFor(h.closedAt - h.openedAt)} · {h.closedBy === 'closed' ? 'closed by you' : h.closedBy === 'reset' ? 'reset' : 'take profit'}</Faint>
        {isOpen ? <View style={{ gap: 6, marginTop: 6 }}>
          {tx.map((x, j) => <View key={j} style={[s.row, { borderTopWidth: 1, borderTopColor: t.line, paddingTop: 6 }]}>
            <View><Text style={{ color: x.cls === 'up' ? t.up : t.down, fontWeight: '600' }}>{x.side}{x.orderType ? ` · ${x.orderType}` : ''}</Text><Faint>{new Date(x.ts).toLocaleString('sv-SE').slice(0, 16)}</Faint></View>
            <View style={{ alignItems: 'flex-end' }}><Text style={[mono, { color: t.ink }]}>{x.qty} {coin} @ {fx(x.px)}</Text><Faint>fee {x.fee === null ? '–' : `−${feeFx(x.fee)}${x.feeEst ? ' est.' : ''}`}</Faint></View>
          </View>)}
        </View> : <Faint>Tap for transactions</Faint>}
      </Card>;
    })}
  </View>;
}

const PANES = { overview: OverviewPane, settings: ParamsPane, orders: OrdersPane, history: HistoryPane };

export default function DetailScreen({ route, navigation }) {
  const t = useTheme(), { S, post, load } = useData(), [tab, setTab] = useState('overview'), [busy, setBusy] = useState(false);
  const v = S.bots.find(x => x.bot.id === route.params.id);
  if (!v) return <View style={{ flex: 1, backgroundColor: t.page, padding: 16 }}><Faint>This bot is no longer in the list.</Faint></View>;
  const Pane = PANES[tab];

  const startStop = async on => {
    const b = v.bot;
    if (!on && !await confirm(`Stop ${b.name}?`, 'The bot stops checking and its resting buy orders are cancelled. An open position and its take profit stay on the exchange.', 'Stop')) return;
    if (on && !b.dryRun && !await confirm(`Start ${b.name}?`, 'This is a LIVE bot: it will send real orders.', 'Start')) return;
    setBusy(true);
    try { await post(`/api/bots/${b.id}/${on ? 'start' : 'stop'}`); } catch (e) { notify('Could not change it', e.message); }
    setBusy(false); load();
  };

  return <View style={{ flex: 1, backgroundColor: t.page }}>
    <ScrollView contentContainerStyle={{ padding: 12, gap: 14, paddingBottom: 90 }}>
      <Head v={v} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 18 }} style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: t.line }}>
        {TABS.map(([k, l]) => <Pressable key={k} onPress={() => setTab(k)} style={{ paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: tab === k ? t.accent : 'transparent' }}>
          <Text style={{ color: tab === k ? t.ink : t.ink2, fontWeight: tab === k ? '700' : '400', fontSize: 15 }}>{l}{k === 'history' && v.history.length ? ` (${v.history.length})` : ''}</Text></Pressable>)}
      </ScrollView>
      <Pane v={v} />
    </ScrollView>
    {S.editable && !v.bot.closedAt ? <View style={[s.bar, { backgroundColor: t.page, borderTopColor: t.line }]}>
      {v.enabled ? <Button disabled={busy} onPress={() => startStop(false)}>Stop</Button> : <Button primary disabled={busy} onPress={() => startStop(true)}>Start</Button>}
    </View> : null}
  </View>;
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 }, cell: { width: '50%', paddingRight: 8 },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, flexDirection: 'row', gap: 10, borderTopWidth: 1 },
});
