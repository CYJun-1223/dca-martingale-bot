// All bots and alerts: account and P&L cards, then one row per bot (or per alert-only watch).
import { useLayoutEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useData } from '../data';
import { useTheme, dirColor, mono } from '../theme';
import { Card, Faint, Label, Pill, StatusDot, WatchStatus, Button, Banner, Kv } from '../ui';
import { confirm, notify } from '../confirm';
import { fx, money, dir, ago } from '../../../web/src/lib/format.js';
import { entryOf, sigLabel } from '../../../web/src/lib/entry.js';
import { botNumbers } from '../../../web/src/lib/cycle.js';

export const brokerName = (S, b) => (S.brokers && S.brokers[b.broker || 'bitget'] || {}).label || b.broker || 'Bitget';

function Overview() {
  const t = useTheme(), { S, post, load } = useData(), b = S.bots;
  const up = b.reduce((s, v) => s + (v.upnl || 0), 0), re = b.reduce((s, v) => s + botNumbers(v).realized, 0);
  const tot = up + re, capital = b.reduce((s, v) => s + (+v.bot.investment || 0), 0), live = b.some(x => !x.bot.dryRun);

  const setPause = async on => {
    if (on && !await confirm('Pause trading?', 'Live bots stop sending orders and cancel their resting orders (adds and take profit) on the exchange. Open positions stay open, without a take-profit order, until you resume. Resume places the orders again.', 'Pause')) return;
    try { await post('/api/stop-all', { on }); } catch (e) { notify('Could not change it', e.message); }
    load();
  };

  return <View style={{ gap: 12 }}>
    {Object.entries(S.accounts || {}).map(([k, a], i) => <Card key={k} style={{ gap: 6 }}>
      <View style={s.row}><Label>{(S.brokers && S.brokers[k] && S.brokers[k].label) || k} futures account</Label>
        {i === 0 && S.editable && !S.stopAll && live ? <Pressable onPress={() => setPause(true)} style={[s.small, { borderColor: t.line }]}><Text style={{ color: t.ink, fontSize: 13, fontWeight: '600' }}>⏸ Pause</Text></Pressable> : null}
      </View>
      {a.error ? <Faint>Couldn't read the balance: {a.error}</Faint> : <>
        <Text style={[mono, { color: t.ink, fontSize: 34, fontWeight: '600' }]}>{fx(a.equity, 4)} <Text style={{ fontSize: 14, color: t.ink3 }}>USDT</Text></Text>
        <View style={[s.bar, { backgroundColor: t.good }]}><View style={{ height: 6, backgroundColor: t.accent, width: `${a.equity > 0 ? Math.min(100, a.locked / a.equity * 100) : 0}%` }} /></View>
        <View style={s.three}>
          <Kv style={s.third} label="In orders" value={fx(a.locked, 4)} />
          <Kv style={s.third} label="Free" value={fx(a.free, 4)} />
          <Kv style={s.third} label="Unrealized" value={money(a.upl)} color={dirColor(t, a.upl)} />
        </View></>}
    </Card>)}
    {S.stopAll ? <Banner tone="bad">⏸ Trading paused.{S.editable ? ' Tap Resume to place the orders again.' : ''}</Banner> : null}
    {S.stopAll && S.editable ? <Button onPress={() => setPause(false)}>Resume trading</Button> : null}
    {b.length ? <Card style={{ gap: 6 }}>
      <View style={s.row}><Label>Bots P&L</Label>{capital ? <Pill color={dirColor(t, tot)}>{money(tot / capital * 100, 2)}%</Pill> : null}</View>
      <Text style={[mono, { color: dirColor(t, tot), fontSize: 34, fontWeight: '600' }]}>{money(tot)} <Text style={{ fontSize: 14, color: t.ink3 }}>USDT</Text></Text>
      <View style={s.three}>
        <Kv style={s.third} label="Unrealized" value={money(up)} color={dirColor(t, up)} />
        <Kv style={s.third} label="Realized" value={money(re)} color={dirColor(t, re)} />
        <Kv style={s.third} label="Invested" value={fx(capital, 0)} />
      </View>
    </Card> : null}
  </View>;
}

function BotRow({ v, onOpen }) {
  const t = useTheme(), { S } = useData(), b = v.bot, N = botNumbers(v), n = v.pos ? v.pos.orders.filter(o => !o.manual).length : 0;
  return <Card onPress={onOpen} style={{ gap: 8 }}>
    <View style={s.row}><Text style={{ color: t.ink, fontSize: 16, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>{b.name}</Text><StatusDot status={v.status} halted={v.state && v.state.halted} /></View>
    <Faint>{b.symbol} · {brokerName(S, b)} · Martingale · {b.leverage}x</Faint>
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
      <Label>P&L</Label><Text style={[mono, { color: dirColor(t, N.total), fontSize: 20, fontWeight: '700' }]}>{money(N.total)}</Text><Faint>USDT</Faint>
      {N.capital ? <Pill color={dirColor(t, N.total)}>{money(N.total / N.capital * 100, 2)}%</Pill> : null}
    </View>
    <View style={s.four}>
      <Kv style={s.fourth} label="Price" value={fx(v.price)} />
      <Kv style={s.fourth} label={v.pos ? `Cycle #${v.pos.id}` : 'No cycle'} value={`${n} | ${N.max}`} />
      <Kv style={s.fourth} label="Unrealized" value={money(v.upnl)} color={dirColor(t, v.upnl)} />
      <Kv style={s.fourth} label="Realized" value={money(N.realized)} color={dirColor(t, N.realized)} />
    </View>
  </Card>;
}

function WatchRow({ v }) {
  const t = useTheme(), { S, post, load } = useData(), w = v.watch, last = v.signals && v.signals[0];
  const toggle = async () => {
    try { await post(`/api/watches/${w.id}/${v.enabled ? 'stop' : 'start'}`); } catch (e) { notify('Could not change it', e.message); }
    load();
  };
  return <Card style={{ gap: 8 }}>
    <View style={s.row}><Text style={{ color: t.ink, fontSize: 16, fontWeight: '700', flexShrink: 1 }} numberOfLines={2}>{w.name}</Text><WatchStatus status={v.status} /></View>
    <Faint>{w.symbol} · {brokerName(S, w)} · {entryOf(w).groups.flatMap(g => g.signals).map(sigLabel).join(' · ')}</Faint>
    <View style={s.row}>
      <View style={{ flexDirection: 'row', gap: 20 }}><Kv label="Price" value={fx(v.price)} /><Kv label="Last alert" value={last ? ago(last.ts) : 'none yet'} /></View>
      {S.editable ? <Button onPress={toggle} style={{ flex: 0, paddingHorizontal: 14, paddingVertical: 8 }}>{v.enabled ? 'Turn off' : 'Turn on'}</Button> : null}
    </View>
  </Card>;
}

export default function ListScreen({ navigation }) {
  const t = useTheme(), { S, load } = useData();
  const [tab, setTab] = useState('bots'), [refreshing, setRefreshing] = useState(false);
  useLayoutEffect(() => {
    navigation.setOptions({ headerRight: () => <Pressable onPress={() => navigation.navigate('Connect')} hitSlop={10}><Text style={{ color: t.accent, fontSize: 15 }}>Server</Text></Pressable> });
  }, [navigation, t]);
  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const stale = S.lastOk && Date.now() - S.lastOk > 45e3;

  return <ScrollView style={{ backgroundColor: t.page }} contentContainerStyle={{ padding: 12, gap: 12 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
    {S.error ? <Banner tone="bad">{S.error.message}{S.lastOk ? ` Last update ${ago(S.lastOk)}.` : ''}</Banner> : stale ? <Banner>Offline · last update {ago(S.lastOk)}</Banner> : null}
    <View style={[s.seg, { backgroundColor: t.chip }]}>
      {[['bots', `Bots (${S.bots.length})`], ['alerts', `Alerts (${S.watches.length})`]].map(([k, l]) =>
        <Pressable key={k} onPress={() => setTab(k)} style={[s.segBtn, tab === k && { backgroundColor: t.surface }]}><Text style={{ color: t.ink, fontWeight: tab === k ? '700' : '400' }}>{l}</Text></Pressable>)}
    </View>
    {tab === 'alerts'
      ? <>{!S.telegram && S.lastOk ? <Banner>Telegram is not set up on the server, so alerts cannot reach you there.</Banner> : null}
        {S.watches.length ? S.watches.map(v => <WatchRow key={v.watch.id} v={v} />) : S.lastOk ? <Card><Faint>No alerts yet. Create them in the web dashboard.</Faint></Card> : null}</>
      : <>{S.lastOk ? <Overview /> : null}
        {S.bots.map(v => <BotRow key={v.bot.id} v={v} onOpen={() => navigation.navigate('Bot', { id: v.bot.id })} />)}
        {S.lastOk && !S.bots.length ? <Card><Faint>No bots yet. Create one in the web dashboard.</Faint></Card> : null}
        {!S.lastOk && S.loading ? <Faint>Connecting…</Faint> : null}</>}
  </ScrollView>;
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  three: { flexDirection: 'row', gap: 8 }, third: { flex: 1 },
  four: { flexDirection: 'row', gap: 6 }, fourth: { flex: 1 },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden', marginVertical: 4 },
  small: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  seg: { flexDirection: 'row', borderRadius: 99, padding: 3 }, segBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 99 },
});
