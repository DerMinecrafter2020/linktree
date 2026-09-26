// =========================================================
// Service-Worker-Registrierung (oeffentliche Seite + Admin)
// =========================================================
// Eigene Datei statt Inline-Skript, damit die CSP ohne 'unsafe-inline' auskommt.

(() => {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // Gab es beim Laden schon einen aktiven Service Worker? Nur dann ist ein neuer SW ein Update.
  // Beim allerersten Installieren wuerde ein Neuladen die Seite sonst grundlos doppelt laden.
  const hadControllerAtStart = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Regelmaessig auf Updates pruefen (alle 5 Minuten)
    setInterval(() => reg.update(), 5 * 60 * 1000);
    // Wenn ein neuer SW (Update) bereit ist: sofort aktivieren und Seite neu laden
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated' && hadControllerAtStart && navigator.serviceWorker.controller) {
          console.log('[SW] Neue Version erkannt, lade Seite neu …');
          window.location.reload();
        }
      });
    });
  }).catch(console.error);

  // Falls der Controller wechselt (neuer SW uebernimmt), Seite neu laden –
  // aber nicht beim allerersten Aktivieren (dann gab es vorher keinen Controller)
  let refreshing = false;
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
})();
