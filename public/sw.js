const CACHE_NAME = 'cornyriegel-v1';
const PRECACHE = [
  '/',
  '/admin',
  '/admin.html',
  '/styles.css',
  '/admin.css',
  '/js/app.js',
  '/js/admin.js',
  '/js/api-client.js',
  '/icons/icon.svg',
  '/manifest.json',
  '/images/default-avatar.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of PRECACHE) {
        try { await cache.add(url); } catch (e) { console.warn('[SW] precache failed', url); }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached =>
      cached || fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => cached)
    )
  );
});
