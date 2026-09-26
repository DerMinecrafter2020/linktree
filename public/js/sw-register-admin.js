// Ausgelagert aus admin.html (CSP ohne 'unsafe-inline')
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    setInterval(() => reg.update(), 5 * 60 * 1000);
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
          window.location.reload();
        }
      });
    });
  }).catch(console.error);
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
