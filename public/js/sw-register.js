// =========================================================
// Service-Worker-Registrierung (oeffentliche Seite + Admin)
// =========================================================
// Eigene Datei statt Inline-Skript, damit die CSP ohne 'unsafe-inline' auskommt.
//
// Kein automatisches Neuladen bei einem SW-Update: Der SW arbeitet Network-First und alle
// eigenen CSS/JS-Dateien tragen ?v=<Version> – die gerade geladene Seite ist also schon die
// neue Version. Ein Neuladen hat nach jedem Update nur ein sichtbares zweites Laden erzeugt.
// Stattdessen meldet das Ereignis "openweb:sw-updated", dass waehrend der Sitzung eine neue
// Version aktiv wurde (der Admin zeigt dann einen Hinweis mit "Neu laden").

(() => {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // Gab es beim Laden schon einen aktiven Service Worker? Nur dann ist ein neuer SW ein Update.
  const hadControllerAtStart = !!navigator.serviceWorker.controller;
  // Updates direkt beim Laden betreffen die gerade geladene (bereits neue) Seite nicht
  const loadedAt = Date.now();
  let notified = false;

  function notifyUpdate() {
    if (notified || !hadControllerAtStart) return;
    if (Date.now() - loadedAt < 15000) return;
    notified = true;
    window.dispatchEvent(new CustomEvent('openweb:sw-updated'));
  }

  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Regelmaessig auf Updates pruefen (alle 5 Minuten)
    setInterval(() => reg.update(), 5 * 60 * 1000);
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated') notifyUpdate();
      });
    });
  }).catch(console.error);
})();
