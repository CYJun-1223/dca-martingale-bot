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

One way: the dashboard's own login over Tailscale.

1. PC `.env`: `WEB_HOST=0.0.0.0` (dashboard also listens on Tailscale / LAN), `WEB_USER`, `WEB_PASSWORD`. Allow port 8787 from Tailscale (`100.64.0.0/10`) in the Windows firewall, restart the dashboard task.
2. Phone: Tailscale on. In the app: server `http://<pc-tailscale-ip>:8787`, user, password, **Connect**.

The Cloudflare address (browser, email code) stays for the browser; the app does not use it.

## Run it

```
cd apps/mobile
npm install
npx expo start            # scan the QR code with Expo Go, or press a for an Android emulator
npx expo start --web      # try it in a browser
npm run bundle:android    # check that the app compiles
```

## Build an installable APK

Expo Go is only a test viewer. For a real app on your phone (no dev server, no Expo Go):

**Option 1: Expo's cloud build (no Android tools on your PC).** Needs a free Expo account.
```
cd apps\mobile
npx eas-cli login
npx eas-cli build --platform android --profile preview
```
The first run offers to create the project (`eas init`); accept it and commit the `projectId` it adds to `app.json`.
After 10-20 minutes it prints a link to the `.apk`. Open it on the phone and allow "install unknown apps".

**Option 2: build on your PC.** Needs Android Studio (SDK) and JDK 17.
```
cd apps\mobile
npx expo prebuild --platform android
cd android
.\gradlew assembleRelease
```
The APK is in `android\app\build\outputs\apk\release\`. `android/` is generated, so it is not committed.

`app.json` allows plain `http` (`usesCleartextTraffic`) so the app can reach a dashboard on your LAN; an `https` address is safer.

## Shared code

The app imports plain JS from the dashboard (`apps/web/src/lib/*`) and the bot's order math (`apps/server/dca.mjs`),
so the numbers match the web page and the bot. `metro.config.js` lets Metro read those folders.
`test/mobile.js` (run by `npm test`) checks the server client.
