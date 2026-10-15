import { Alert, Platform } from 'react-native';

// "Are you sure?" as a promise (Alert on the phone, window.confirm in the web test build)
export const confirm = (title, message, ok = 'OK') => new Promise(resolve => {
  if (Platform.OS === 'web') return resolve(globalThis.confirm ? globalThis.confirm(`${title}\n\n${message}`) : true);
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) }, { text: ok, onPress: () => resolve(true) }], { cancelable: true, onDismiss: () => resolve(false) });
});
export const notify = (title, message) => {
  if (Platform.OS === 'web') globalThis.alert?.(message ? `${title}\n${message}` : title); else Alert.alert(title, message);
};
