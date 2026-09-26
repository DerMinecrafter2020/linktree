// Ausgelagert aus index.html (CSP ohne 'unsafe-inline')
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Regelmaessig auf Updates pruefen (alle 5 Minuten)
    setInterval(() => reg.update(), 5 * 60 * 1000);
    // Wenn ein neuer SW bereit ist: sofort aktivieren und Seite neu laden
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
          console.log('[SW] Neue Version erkannt, lade Seite neu …');
          window.location.reload();
        }
      });
    });
  }).catch(console.error);
  // Falls der Controller wechselt (neuer SW uebernimmt), Seite neu laden
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
}
