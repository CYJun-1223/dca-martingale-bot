// Sign in the way the browser does: Cloudflare Access page, email, code. The page runs in an in-app browser; the sign-in cookie it
// receives is shared with the app's own requests (React Native's fetch uses the same cookie store), so once the dashboard's own
// host loads and /api/bots answers, we are in.
import { useRef, useState } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useData } from '../data';
import { request, cleanUrl } from '../api';
import { useTheme } from '../theme';
import { Button, Faint } from '../ui';

const hostOf = u => (/^https?:\/\/([^/?#]+)/i.exec(u || '') || [])[1] || '';

export default function LoginScreen({ navigation }) {
  const t = useTheme(), { conn, connect } = useData();
  const probing = useRef(false), [msg, setMsg] = useState('Opening the sign-in page…'), [failed, setFailed] = useState(null);
  const base = cleanUrl(conn?.url);

  if (Platform.OS === 'web') return <View style={{ flex: 1, backgroundColor: t.page, padding: 16 }}><Faint>Browser sign-in works in the phone app only. In a browser, just open the dashboard address directly.</Faint></View>;

  // the dashboard's own host loaded (not Cloudflare's login page): ask the API whether we are in
  const check = async url => {
    if (probing.current || hostOf(url) !== hostOf(base)) return;
    probing.current = true; setMsg('Checking the sign-in…');
    try {
      await request({ ...conn, mode: 'browser' }, '/api/bots', { timeout: 12000 });
      await connect({ ...conn, mode: 'browser' });
      navigation.reset({ index: 0, routes: [{ name: 'Bots' }] });
    } catch (e) {
      probing.current = false; setMsg('Sign in with your email and the code.'); setFailed(e.kind === 'auth' ? null : e.message);
    }
  };

  return <View style={{ flex: 1, backgroundColor: t.page }}>
    <View style={{ padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}><ActivityIndicator size="small" /><Text style={{ color: t.ink2, flex: 1 }}>{msg}</Text></View>
    {failed ? <Text style={{ color: t.down, paddingHorizontal: 12, paddingBottom: 6 }}>{failed}</Text> : null}
    <WebView source={{ uri: base }} style={{ flex: 1 }} sharedCookiesEnabled thirdPartyCookiesEnabled domStorageEnabled
      onNavigationStateChange={s => { if (!s.loading) check(s.url); }} onLoadEnd={e => check(e.nativeEvent.url)} />
    <View style={{ padding: 10 }}><Button onPress={() => navigation.goBack()}>Cancel</Button></View>
  </View>;
}
