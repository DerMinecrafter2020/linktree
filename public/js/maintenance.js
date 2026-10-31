// =========================================================
// OpenWeb – Wartungsseite: Countdown und automatisches Neuladen
// ---------------------------------------------------------
// data-ends-at (ISO) kommt vom Server (lib/maintenance-mode.js). Ist die Zeit abgelaufen, laedt die
// Seite neu: mit data-auto-end="1" nach wenigen Sekunden (dann ist die Startseite wieder da), sonst
// jede Minute, bis der Admin den Wartungsmodus beendet. Leicht gestreut, damit nicht alle Besucher
// gleichzeitig anfragen.
// =========================================================
(function () {
  'use strict';

  var root = document.getElementById('maintenance');
  if (!root) return;
  var endsAt = Date.parse(root.getAttribute('data-ends-at') || '');
  if (!Number.isFinite(endsAt)) return;
  var autoEnd = root.getAttribute('data-auto-end') === '1';

  var i18n = window.OpenWebI18n;
  var units = {};
  ['d', 'h', 'm', 's'].forEach(function (u) {
    var el = root.querySelector('.mt-unit[data-unit="' + u + '"]');
    units[u] = el ? { wrap: el, value: el.querySelector('.mt-value') } : null;
  });
  var countdown = document.getElementById('maintenance-countdown');
  var eta = document.getElementById('maintenance-eta');
  var done = document.getElementById('maintenance-done');
  var timer = null;
  var reloadScheduled = false;

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function renderEta() {
    if (!eta) return;
    var d = new Date(endsAt);
    eta.setAttribute('datetime', d.toISOString());
    try {
      eta.textContent = new Intl.DateTimeFormat(i18n ? i18n.locale() : 'de-DE', {
        weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
      }).format(d);
    } catch (e) {
      eta.textContent = d.toLocaleString();
    }
  }

  function scheduleReload() {
    if (reloadScheduled) return;
    reloadScheduled = true;
    var delay = autoEnd ? 2000 + Math.random() * 6000 : 50000 + Math.random() * 20000;
    setTimeout(function () { location.reload(); }, delay);
  }

  function tick() {
    var left = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
    var d = Math.floor(left / 86400);
    var h = Math.floor((left % 86400) / 3600);
    var m = Math.floor((left % 3600) / 60);
    var s = left % 60;
    if (units.d) {
      units.d.wrap.hidden = d === 0;
      units.d.value.textContent = String(d);
    }
    if (units.h) units.h.value.textContent = pad(h);
    if (units.m) units.m.value.textContent = pad(m);
    if (units.s) units.s.value.textContent = pad(s);
    if (left === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      if (countdown) countdown.classList.add('is-done');
      if (done) done.hidden = false;
      scheduleReload();
    }
  }

  renderEta();
  tick();
  if (endsAt > Date.now()) timer = setInterval(tick, 1000);
  document.addEventListener('openweb:langchange', renderEta);
  // Nach dem Aufwachen aus dem Hintergrund sofort aktualisieren (Timer werden dort gedrosselt)
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
