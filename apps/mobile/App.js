import { ActivityIndicator, View, useColorScheme } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { DataProvider, useData } from './src/data';
import { useTheme } from './src/theme';
import ConnectScreen from './src/screens/Connect';
import LoginScreen from './src/screens/Login';
import ListScreen from './src/screens/List';
import DetailScreen from './src/screens/Detail';

const Stack = createNativeStackNavigator();

function Root() {
  const t = useTheme(), { conn, S } = useData();
  if (conn === null) return <View style={{ flex: 1, backgroundColor: t.page, justifyContent: 'center' }}><ActivityIndicator /></View>;
  const needsSetup = !conn.url;
  return <Stack.Navigator initialRouteName={needsSetup ? 'Connect' : 'Bots'} screenOptions={{ headerStyle: { backgroundColor: t.page }, headerTintColor: t.ink, headerShadowVisible: false }}>
    <Stack.Screen name="Bots" component={ListScreen} options={{ title: 'Bots' }} />
    <Stack.Screen name="Bot" component={DetailScreen} options={{ title: '' }} />
    <Stack.Screen name="Connect" component={ConnectScreen} options={{ title: 'Server' }} />
    <Stack.Screen name="Login" component={LoginScreen} options={{ title: 'Sign in' }} />
  </Stack.Navigator>;
}

export default function App() {
  const dark = useColorScheme() === 'dark';
  return <SafeAreaProvider>
    <DataProvider>
      <NavigationContainer theme={dark ? DarkTheme : DefaultTheme}><Root /></NavigationContainer>
    </DataProvider>
    <StatusBar style="auto" />
  </SafeAreaProvider>;
}
