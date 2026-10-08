// Makes the dashboard installable as an app. It deliberately caches and intercepts nothing: prices, positions and orders must
// always come live from the server, and the login keeps working exactly as before.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // present (some browsers require it to offer "install"), but never answers a request
