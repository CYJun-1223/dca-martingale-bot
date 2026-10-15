// The connection settings (server address and sign-in) live in the phone's secure store; on the web build (used for testing) in localStorage.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const KEY = 'connection';
const EMPTY = { url: '', user: '', pass: '' };

export async function loadConnection() {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) : await SecureStore.getItemAsync(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch { return EMPTY; }
}
export async function saveConnection(c) {
  const raw = JSON.stringify(c);
  if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, raw); else await SecureStore.setItemAsync(KEY, raw);
}
export async function clearConnection() {
  if (Platform.OS === 'web') globalThis.localStorage?.removeItem(KEY); else await SecureStore.deleteItemAsync(KEY);
}
