// Small building blocks shared by the screens.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, mono } from './theme';

export const Card = ({ children, style, onPress }) => {
  const t = useTheme();
  const body = [s.card, { backgroundColor: t.surface, borderColor: t.line }, style];
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => [...body, pressed && { opacity: 0.7 }]}>{children}</Pressable> : <View style={body}>{children}</View>;
};
export const Label = ({ children, style }) => { const t = useTheme(); return <Text style={[s.label, { color: t.ink3 }, style]}>{children}</Text>; };
export const Value = ({ children, color, size = 15, style }) => { const t = useTheme(); return <Text style={[mono, { color: color || t.ink, fontSize: size, fontWeight: '600' }, style]}>{children}</Text>; };
export const Faint = ({ children, style }) => { const t = useTheme(); return <Text style={[{ color: t.ink3, fontSize: 12 }, style]}>{children}</Text>; };

// a label over a value (and an optional small line under it)
export const Kv = ({ label, value, unit, sub, color, style }) => {
  const t = useTheme();
  return <View style={[{ gap: 2 }, style]}>
    <Label>{label}</Label>
    <Text style={[mono, { color: color || t.ink, fontSize: 17, fontWeight: '600' }]}>{value}{unit ? <Text style={{ fontSize: 12, fontWeight: '500', color: t.ink2 }}> {unit}</Text> : null}</Text>
    {sub ? <Faint>{sub}</Faint> : null}
  </View>;
};

export const Pill = ({ children, color }) => {
  const t = useTheme(), c = color || t.ink2;
  return <View style={[s.pill, { backgroundColor: c + '22' }]}><Text style={{ color: c, fontSize: 12, fontWeight: '700' }}>{children}</Text></View>;
};
export const Tag = ({ children, color }) => {
  const t = useTheme(), c = color || t.ink2;
  return <View style={[s.tag, { borderColor: color ? c : t.line }]}><Text style={{ color: c, fontSize: 12 }}>{children}</Text></View>;
};

export const Button = ({ children, onPress, primary, danger, disabled, style }) => {
  const t = useTheme();
  const bg = primary ? t.accent : t.surface, fg = primary ? t.accentInk : danger ? t.down : t.ink;
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: primary ? t.accent : t.line, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }, style]}>
    <Text style={{ color: fg, fontSize: 15, fontWeight: '600' }}>{children}</Text>
  </Pressable>;
};

export const StatusDot = ({ status, halted }) => {
  const t = useTheme();
  const [text, color] = halted ? ['Paused', t.warn] : ({ running: ['Running', t.up], starting: ['Starting…', t.warn], down: ['Not responding', t.warn], closed: ['Closed', t.ink3] }[status] || ['Stopped', t.ink3]);
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /><Text style={{ color, fontSize: 12, fontWeight: '600' }}>{text}</Text>
  </View>;
};
export const WatchStatus = ({ status }) => {
  const t = useTheme();
  const [text, color] = { running: ['Watching', t.up], starting: ['Starting…', t.warn], down: ['Not responding', t.warn] }[status] || ['Off', t.ink3];
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} /><Text style={{ color, fontSize: 12, fontWeight: '600' }}>{text}</Text>
  </View>;
};

export const Banner = ({ children, tone }) => {
  const t = useTheme();
  return <View style={[s.banner, { backgroundColor: tone === 'bad' ? t.bad : t.chip }]}><Text style={{ color: t.ink, fontSize: 13, lineHeight: 18 }}>{children}</Text></View>;
};

const s = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 14, padding: 14 },
  label: { fontSize: 12 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, alignSelf: 'flex-start' },
  tag: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  btn: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', flex: 1 },
  banner: { borderRadius: 10, padding: 10 },
});
