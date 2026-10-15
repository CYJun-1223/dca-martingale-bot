// Where the app learns which dashboard server to talk to, and how to sign in.
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useData } from '../data';
import { request, cleanUrl } from '../api';
import { useTheme } from '../theme';
import { Button, Card, Faint, Label } from '../ui';

function Field({ label, value, onChange, placeholder, secure, hint, keyboard }) {
  const t = useTheme();
  return <View style={{ gap: 4 }}>
    <Label>{label}</Label>
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={t.ink3} secureTextEntry={secure} autoCapitalize="none" autoCorrect={false}
      keyboardType={keyboard} style={[s.input, { color: t.ink, borderColor: t.line, backgroundColor: t.page }]} />
    {hint ? <Faint>{hint}</Faint> : null}
  </View>;
}

export default function ConnectScreen({ navigation }) {
  const t = useTheme(), { conn, connect, disconnect, S } = useData();
  const [f, setF] = useState({ url: conn?.url || '', user: conn?.user || '', pass: conn?.pass || '' });
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
  const set = k => v => setF(x => ({ ...x, [k]: v }));
  const connected = !!(conn && conn.url) && !S.error && S.lastOk > 0;

  const save = async () => {
    const c = { ...f, url: cleanUrl(f.url) };
    setBusy(true); setMsg(null);
    try {
      const d = await request(c, '/api/bots', { timeout: 12000 });
      await connect(c);
      setMsg({ ok: true, text: `Connected: ${(d.bots || []).length} bot(s), ${(d.watches || []).length} alert(s).${d.editable ? '' : ' View-only server.'}` });
      if (navigation.canGoBack()) navigation.goBack(); else navigation.replace('Bots');
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.page }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: t.ink, fontSize: 22, fontWeight: '700' }}>Connect to your bots</Text>
      <Faint>The app talks to your dashboard over Tailscale (keep the Tailscale app on, on the phone). It shows the same bots and lets you start, stop and pause them.</Faint>
      <Card style={{ gap: 12 }}>
        <Field label="Server address" value={f.url} onChange={set('url')} placeholder="http://100.x.x.x:8787" keyboard="url" hint="Your PC's Tailscale address and the dashboard port." />
        <Field label="User" value={f.user} onChange={set('user')} placeholder="admin" hint="WEB_USER from the bot's .env file." />
        <Field label="Password" value={f.pass} onChange={set('pass')} secure hint="WEB_PASSWORD from the bot's .env file." />
      </Card>
      {msg ? <Text style={{ color: msg.ok ? t.up : t.down, fontSize: 14 }}>{msg.text}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {connected ? <Button danger onPress={async () => { await disconnect(); setF({ url: '', user: '', pass: '' }); setMsg(null); }}>Forget</Button> : null}
        <Button primary disabled={busy || !f.url.trim()} onPress={save}>{busy ? 'Checking…' : 'Connect'}</Button>
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const s = StyleSheet.create({ input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 } });
