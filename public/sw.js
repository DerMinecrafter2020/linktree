// =========================================================
// OpenWeb Service Worker — Network-First mit Offline-Fallback
// =========================================================
// Der Cache-Name enthaelt die App-Version. Bei jedem Update
// wird der alte Cache automatisch geloescht.

const CACHE_NAME = 'openweb-cache-v3.0.4';
const PRECACHE = [
  '/',
  '/styles.css',
  '/js/app.js',
  '/js/api-client.js',
  '/js/icons.js',
  '/js/navidrome.js',
  '/icons/icon.svg',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of PRECACHE) {
        try { await cache.add(url); } catch (e) { console.warn('[SW] precache failed', url); }
      }
    })
  );
  // Sofort aktivieren, ohne auf offene Tabs zu warten
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => {
          console.log('[SW] Loesche alten Cache:', key);
          return caches.delete(key);
        })
      )
    )
  );
  // Alle offenen Tabs sofort uebernehmen
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // API-Requests nie cachen
  const url = new URL(event.request.url);
  
  // Nur same-origin Anfragen verarbeiten, um Probleme mit externen CDNs (jsdelivr) zu vermeiden
  if (url.origin !== self.location.origin) return;
  
  if (url.pathname.startsWith('/api/')) return;

  // Network-First: Versuche immer zuerst vom Server zu laden
  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Erfolgreiche Antwort im Cache speichern fuer Offline-Nutzung
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline: Aus dem Cache servieren
        return caches.match(event.request);
      })
  );
});

// Nachricht an alle Clients senden wenn ein neuer SW aktiv wird
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
