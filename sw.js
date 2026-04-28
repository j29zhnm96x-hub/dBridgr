const CACHE_NAME = 'dbridgr-shell-v3';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/app.js',
  './js/core/storage.js',
  './js/core/theme.js',
  './js/core/pwa.js',
  './js/state/store.js',
  './js/bridge/session.js',
  './js/bridge/signaling.js',
  './js/bridge/transport.js',
  './js/bridge/protocol.js',
  './js/bridge/chunks.js',
  './js/utils/files.js',
  './js/utils/dom.js',
  './assets/icons/favicon.svg',
  './assets/icons/icon.svg',
  './assets/icons/maskable.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET') {
    return;
  }
  if (requestUrl.pathname.startsWith('/api/')) {
    return;
  }
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  const isDocumentRequest = event.request.mode === 'navigate'
    || event.request.destination === 'document'
    || requestUrl.pathname === '/'
    || requestUrl.pathname.endsWith('.html');

  if (isDocumentRequest) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const clonedResponse = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clonedResponse));
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then((cachedResponse) => cachedResponse || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        const clonedResponse = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clonedResponse));
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});