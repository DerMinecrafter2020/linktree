// =========================================================
// OpenWeb – Admin-Oberflaeche: Rahmen des Design-Systems (css/admin-ds.css)
// ---------------------------------------------------------
// Nur Darstellung, keine Fachlogik (die steckt unveraendert in js/admin.js):
// - Seitenleiste: einklappbare Gruppen (Zustand in localStorage, Gruppe der aktiven Seite immer offen),
//   Offcanvas auf schmalen Bildschirmen, Benutzer-Menue unten
// - Seitentitel mit gedaempfter Unterzeile je Bereich
// - Karten mit Kopfzeile (<h3> als erstes Element) einklappbar, Zustand je Bereich gemerkt
// - Kennzahl-Kacheln bekommen ein Symbol oben rechts
// - Footer: Version (aus ?v= der eingebundenen Skripte) und Ladezeit
// Laedt vor js/admin.js und hoert auf dessen Ereignisse (admin-tab-change, admin-session).
// =========================================================
(function () {
  'use strict';

  var NAV_KEY = 'openweb-admin-nav';
  var CARDS_KEY = 'openweb-admin-cards';
  var SUBTITLES = {
    links: 'Verwalten, sortieren und archivieren',
    stats: 'Klicks, Aufrufe und Hörverlauf',
    profile: 'Name, Bild, Design und Link-Vorschau',
    music: 'Now Playing aus Navidrome, Music Assistant und Spotify',
    apikeys: 'Lesender Zugriff auf die öffentliche API',
    settings: 'Status, Benachrichtigungen, Sicherheit und Rechtliches',
    data: 'Kategorien, Backups, Import und Export',
    audit: 'Protokoll der Admin-Aktionen',
    monitor: 'Ressourcen der letzten Stunde'
  };
  // Symbole der Kennzahl-Kacheln (Beschriftung -> Symbol aus dem Sprite in admin.html)
  var TILE_ICONS = {
    'Gesamtklicks': 'chart', 'Links': 'link', 'Songs gehört': 'music',
    'CPU-Last': 'activity', 'Arbeitsspeicher': 'database', 'Event-Loop': 'activity', 'Anfragen': 'external',
    'Antwortzeit': 'activity', 'Serverfehler': 'x', 'DB-Verbindungen': 'database', 'Laufzeit': 'sparkles'
  };

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* privat/blockiert: egal */ }
  }
  function svgUse(id, cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + id);
    svg.appendChild(use);
    return svg;
  }
  function slug(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  }

  var currentTab = 'links';

  // ---------- Seitenleiste: Gruppen ----------
  function bindGroups() {
    var state = readJson(NAV_KEY);
    document.querySelectorAll('.sb-group').forEach(function (group) {
      var id = group.getAttribute('data-group');
      var toggle = group.querySelector('.sb-group-toggle');
      var open = state[id] !== false;
      setGroup(group, open);
      toggle.addEventListener('click', function () {
        var next = toggle.getAttribute('aria-expanded') !== 'true';
        // Gruppe mit der aktiven Seite bleibt offen
        if (!next && group.querySelector('.side-btn.active')) return;
        setGroup(group, next);
        var s = readJson(NAV_KEY);
        s[id] = next;
        writeJson(NAV_KEY, s);
      });
    });
  }
  function setGroup(group, open) {
    group.querySelector('.sb-group-toggle').setAttribute('aria-expanded', String(open));
    group.classList.toggle('is-collapsed', !open);
  }
  function openActiveGroup() {
    var active = document.querySelector('.side-btn.active');
    var group = active && active.closest('.sb-group');
    if (group) setGroup(group, true);
  }

  // ---------- Offcanvas (schmale Bildschirme) ----------
  var lastFocus = null;
  function setOffcanvas(open) {
    var sidebar = document.getElementById('sidebar');
    var backdrop = document.getElementById('sidebar-backdrop');
    var opener = document.getElementById('sidebar-open');
    if (!sidebar) return;
    document.body.classList.toggle('sidebar-open', open);
    if (backdrop) backdrop.hidden = !open;
    if (opener) opener.setAttribute('aria-expanded', String(open));
    if (open) {
      lastFocus = document.activeElement;
      var first = sidebar.querySelector('.side-btn.active') || sidebar.querySelector('button, a');
      if (first) first.focus({ preventScroll: true });
    } else if (lastFocus && document.body.contains(lastFocus)) {
      lastFocus.focus({ preventScroll: true });
    }
  }
  function bindOffcanvas() {
    var opener = document.getElementById('sidebar-open');
    var closer = document.getElementById('sidebar-close');
    var backdrop = document.getElementById('sidebar-backdrop');
    if (opener) opener.addEventListener('click', function () { setOffcanvas(true); });
    if (closer) closer.addEventListener('click', function () { setOffcanvas(false); });
    if (backdrop) backdrop.addEventListener('click', function () { setOffcanvas(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) setOffcanvas(false);
    });
    // Nach der Auswahl eines Bereichs bzw. Werkzeugs wieder schliessen
    document.querySelectorAll('.sidebar .side-btn, .sidebar .side-link').forEach(function (b) {
      b.addEventListener('click', function () {
        if (document.body.classList.contains('sidebar-open')) setOffcanvas(false);
      });
    });
    window.matchMedia('(min-width: 992px)').addEventListener('change', function (mq) {
      if (mq.matches) setOffcanvas(false);
    });
  }

  // ---------- Benutzer-Menue ----------
  function bindUserMenu() {
    var btn = document.getElementById('user-menu-btn');
    var menu = document.getElementById('user-menu');
    if (!btn || !menu) return;
    function set(open) {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    }
    btn.addEventListener('click', function () { set(menu.hidden); });
    document.addEventListener('pointerdown', function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) set(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { set(false); btn.focus(); }
    });
  }
  function setUser(name) {
    var clean = String(name || '').trim();
    if (!clean) return;
    var nameEl = document.getElementById('user-name');
    var avatar = document.getElementById('user-avatar');
    if (nameEl) { nameEl.textContent = clean; nameEl.title = clean; }
    if (avatar) avatar.textContent = clean.replace(/^@/, '').charAt(0).toUpperCase() || 'A';
  }

  // ---------- Seitentitel ----------
  function setSubtitle(tab) {
    var el = document.getElementById('tab-subtitle');
    if (el) {
      el.textContent = SUBTITLES[tab] || '';
      el.hidden = !SUBTITLES[tab];
    }
  }

  // ---------- Einklappbare Karten ----------
  function bindCards() {
    var state = readJson(CARDS_KEY);
    document.querySelectorAll('section.tab').forEach(function (section) {
      var tab = section.getAttribute('data-tab');
      section.querySelectorAll('.card-block').forEach(function (card) {
        var first = card.firstElementChild;
        if (!first) return;
        var isHeading = first.tagName === 'H3';
        var isMonitorHead = first.classList.contains('monitor-head');
        if (!isHeading && !isMonitorHead) return;
        var title = isHeading ? first : first.querySelector('h3');
        if (!title) return;
        var key = tab + '/' + (card.id || slug(title.textContent));
        var bodyId = 'cb-' + key.replace(/[^a-z0-9-]+/gi, '-');

        var head = document.createElement('div');
        head.className = 'card-head';
        var body = document.createElement('div');
        body.className = 'card-body';
        body.id = bodyId;
        while (first.nextSibling) body.appendChild(first.nextSibling);
        card.insertBefore(head, first);
        head.appendChild(first);
        var chevron = document.createElement('button');
        chevron.type = 'button';
        chevron.className = 'card-toggle';
        chevron.setAttribute('aria-controls', bodyId);
        chevron.appendChild(svgUse('chevron', 'card-chevron'));
        head.appendChild(chevron);
        card.appendChild(body);
        card.classList.add('has-head');

        function set(collapsed, save) {
          card.classList.toggle('is-collapsed', collapsed);
          body.hidden = collapsed;
          chevron.setAttribute('aria-expanded', String(!collapsed));
          chevron.setAttribute('aria-label', (collapsed ? 'Aufklappen: ' : 'Einklappen: ') + title.textContent.trim());
          if (save) {
            var s = readJson(CARDS_KEY);
            if (collapsed) s[key] = true; else delete s[key];
            writeJson(CARDS_KEY, s);
          }
          // Diagramme in aufgeklappten Karten neu zeichnen
          if (!collapsed) window.dispatchEvent(new Event('resize'));
        }
        set(state[key] === true, false);
        head.addEventListener('click', function (e) {
          // Knoepfe, Links und Schalter im Kopf loesen kein Einklappen aus
          if (e.target.closest('a, input, select, textarea, label, button:not(.card-toggle)')) return;
          set(!card.classList.contains('is-collapsed'), true);
        });
      });
    });
  }

  // ---------- Kennzahl-Kacheln ----------
  function decorateTiles(root) {
    root.querySelectorAll('.stat-card').forEach(function (tile) {
      if (tile.querySelector('.tile-icon')) return;
      var label = tile.querySelector('span');
      var icon = label && TILE_ICONS[label.textContent.trim()];
      if (icon) tile.appendChild(svgUse(icon, 'tile-icon'));
    });
  }
  function bindTiles() {
    ['stats-summary', 'monitor-cards'].forEach(function (id) {
      var root = document.getElementById(id);
      if (!root) return;
      decorateTiles(root);
      new MutationObserver(function () { decorateTiles(root); }).observe(root, { childList: true });
    });
  }

  // ---------- Footer ----------
  function bindFooter() {
    var versionEl = document.getElementById('admin-footer-version');
    var loadEl = document.getElementById('admin-footer-load');
    var src = (document.querySelector('script[src*="/js/admin-ui.js"]') || {}).src || '';
    var v = (/[?&]v=([^&]+)/.exec(src) || [])[1];
    if (versionEl && v) versionEl.textContent = 'OpenWeb v' + decodeURIComponent(v);
    window.addEventListener('load', function () {
      setTimeout(function () {
        var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        var ms = nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : performance.now();
        if (loadEl) loadEl.textContent = 'Geladen in ' + (ms / 1000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' s';
      }, 0);
    });
  }

  // ---------- Ereignisse aus js/admin.js ----------
  document.addEventListener('admin-tab-change', function (e) {
    currentTab = e.detail;
    setSubtitle(currentTab);
    openActiveGroup();
  });
  document.addEventListener('admin-session', function (e) {
    var me = e.detail || {};
    if (me.email) setUser(String(me.email).split('@')[0]);
  });
  document.addEventListener('admin-profile', function (e) {
    var p = e.detail || {};
    if (p.handle || p.name) setUser(p.handle || p.name);
  });

  function init() {
    bindGroups();
    bindOffcanvas();
    bindUserMenu();
    bindCards();
    bindTiles();
    bindFooter();
    var active = document.querySelector('.side-btn.active');
    setSubtitle(active ? active.getAttribute('data-tab') : 'links');
    openActiveGroup();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
