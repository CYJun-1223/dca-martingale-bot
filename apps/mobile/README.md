# Phone app (Expo / React Native)

A native app for Android and iOS that talks to the dashboard server (`apps/server/web.js`) through its JSON API.
It replaces the earlier Capacitor wrapper, which bundled the web dashboard but had no way to reach the server.

## What it does

- **Connect** screen: server address plus a sign-in (stored in the phone's secure store).
- **Bots / Alerts** list: account card, Bots P&L card, one row per bot or alert watch. Pull down to refresh; data is polled every 15 s.
- **Bot page**: Overview, Parameters, Orders (ladder) and History (cycles and their transactions), same numbers as the web dashboard.
- **Controls**: Start / Stop a bot, Pause / Resume all trading, turn an alert on or off. They appear only when the server is not `--readonly`.

Not in the app (use the web dashboard): creating or editing bots and alerts, manual orders, closing a bot at a price, strategies.
Alerts still arrive through Telegram; the app has no push notifications.

## Signing in

The app sends whatever you enter on the Connect screen:

| Server setup | Enter |
|---|---|
| Dashboard on your LAN / VPN (`node apps/server/web.js --host=0.0.0.0`) | `http://<pc-ip>:8787`, user `WEB_USER` (default `admin`), password `WEB_PASSWORD` |
| Public through a Cloudflare Tunnel **without** Access | the https address, user and password |
| Public through a Cloudflare Tunnel **with** Access | the https address, user and password, plus a Cloudflare Access **service token** (Client ID and secret). In Zero Trust add a "Service Auth" policy for that token to the Access application |

Browser sign-in (one-time PIN, Google) cannot be completed inside an app, so Access needs the service token.

## Run it

```
cd apps/mobile
npm install
npx expo start            # scan the QR code with Expo Go, or press a for an Android emulator
npx expo start --web      # try it in a browser
npm run bundle:android    # check that the app compiles
```

An installable APK (needs an Expo account): `npx eas build --platform android --profile preview`.
Without Expo's cloud: `npx expo prebuild --platform android` then build `android/` with Gradle (needs Android Studio / the SDK).

## Shared code

The app imports plain JS from the dashboard (`apps/web/src/lib/*`) and the bot's order math (`apps/server/dca.mjs`),
so the numbers match the web page and the bot. `metro.config.js` lets Metro read those folders.
`test/mobile.js` (run by `npm test`) checks the server client.
