/* ─────────────────────────────────────────────────────────────
   Poker Tracker — Service Worker
   Strategy: network-first for the app shell (so frequent deploys
   are picked up immediately), with cache fallback for offline use.
   API requests (cross-origin Worker) are never intercepted.
   ───────────────────────────────────────────────────────────── */

const CACHE = 'poker-tracker-v28';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './settlement.js',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

// Precache the shell, then take over immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// Drop old caches on activation
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only manage same-origin requests — let the API & CDN scripts pass through
  if (url.origin !== location.origin) return;

  e.respondWith(
    // Revalidate against the server (bypass the browser HTTP cache) so a new
    // deploy is picked up immediately — plain fetch() can return a stale,
    // still-cached shell asset and the SW would then re-cache the stale copy.
    fetch(request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then(r => r || caches.match('./index.html')))
  );
});
