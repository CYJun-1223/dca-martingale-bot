import { useColorScheme } from 'react-native';

const light = { page: '#f6f6f3', surface: '#ffffff', line: '#e3e3dd', ink: '#16181d', ink2: '#555a64', ink3: '#8a8f99', up: '#1a8f4c', down: '#c9372c', warn: '#9a6700', accent: '#2b6fd6', accentInk: '#ffffff', chip: '#eeeee8', bad: '#fdecea', good: '#e8f5ec' };
const dark = { page: '#161616', surface: '#232323', line: '#343434', ink: '#f2f2f2', ink2: '#b8bcc4', ink3: '#80858f', up: '#4cc774', down: '#ff7b6e', warn: '#e0b341', accent: '#4a8ff0', accentInk: '#ffffff', chip: '#2e2e2e', bad: '#3a1f1d', good: '#1d3326' };

export const useTheme = () => (useColorScheme() === 'dark' ? dark : light);
export const dirColor = (t, v) => (v > 0 ? t.up : v < 0 ? t.down : t.ink);
export const mono = { fontVariant: ['tabular-nums'] };
