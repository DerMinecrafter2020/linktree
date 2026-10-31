// =========================================================
// OpenWeb – Theme frueh setzen (im <head>, synchron, vor dem ersten Zeichnen)
// ---------------------------------------------------------
// - Liste aller Themes fuer Startseite und Admin (window.OpenWebThemes)
// - Setzt data-theme auf <html> aus der gespeicherten Wahl, damit beim Laden nicht
//   kurz das Standard-Theme aufblitzt.
// - Startseite: Der Server setzt data-theme / data-default-theme (Standard-Design aus dem
//   Admin) und data-visitor-theme="0", wenn Besucher kein eigenes Theme waehlen duerfen.
// - Admin/Login: <script ... data-scope="admin"> nutzt einen eigenen Speicher-Schluessel.
// Theme-Farben stehen in css/themes.css – hier keine Farbwerte.
// =========================================================
(function () {
  'use strict';

  var THEMES = [
    { id: 'dark', label: 'Dunkel', hint: 'Material 3, violett' },
    { id: 'midnight', label: 'Midnight', hint: 'Material 3, blau' },
    { id: 'sunset', label: 'Sunset', hint: 'Material 3, orange' },
    { id: 'light', label: 'Hell', hint: 'Material 3, hell' },
    { id: 'win11', label: 'Windows 11', hint: 'Mica & Fluent' },
    { id: 'glass', label: 'Liquid Glass', hint: 'Glas auf Farbe' }
  ];
  var IDS = THEMES.map(function (t) { return t.id; });

  var script = document.currentScript;
  var scope = script && script.getAttribute('data-scope') === 'admin' ? 'admin' : 'public';
  var storageKey = scope === 'admin' ? 'openweb-admin-theme' : 'openweb-theme';
  var root = document.documentElement;

  function isTheme(id) { return IDS.indexOf(id) !== -1; }

  function read() {
    try { return localStorage.getItem(storageKey) || ''; } catch (e) { return ''; }
  }
  function write(id) {
    try {
      if (id) localStorage.setItem(storageKey, id);
      else localStorage.removeItem(storageKey);
    } catch (e) { /* gilt dann nur fuer diese Seite */ }
  }

  function defaultTheme() {
    var d = root.getAttribute('data-default-theme');
    return isTheme(d) ? d : 'dark';
  }

  // Theme anwenden ("dark" = kein Attribut, Werte aus :root)
  function apply(id) {
    var theme = isTheme(id) ? id : 'dark';
    if (theme === 'dark') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && document.body) {
      var color = getComputedStyle(root).getPropertyValue('--ow-theme-color').trim();
      if (color) meta.setAttribute('content', color);
    }
    return theme;
  }

  function visitorChoiceAllowed() {
    return scope === 'admin' || root.getAttribute('data-visitor-theme') !== '0';
  }

  function current() {
    var t = root.getAttribute('data-theme');
    return isTheme(t) ? t : 'dark';
  }

  // Waehlen + speichern; mit weichem Uebergang, wo der Browser View Transitions kann
  function choose(id) {
    var theme = isTheme(id) ? id : 'dark';
    if (scope === 'public' && theme === defaultTheme()) write('');
    else write(theme);
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !reduce) {
      document.startViewTransition(function () { apply(theme); });
    } else {
      apply(theme);
    }
    return theme;
  }

  var stored = read();
  if (visitorChoiceAllowed() && isTheme(stored)) apply(stored);
  else if (scope === 'public' && !root.hasAttribute('data-theme')) apply(defaultTheme());

  // theme-color nach dem Laden der Styles nachziehen
  document.addEventListener('DOMContentLoaded', function () { apply(current()); });

  window.OpenWebThemes = {
    list: THEMES.slice(),
    isTheme: isTheme,
    current: current,
    defaultTheme: defaultTheme,
    choose: choose,
    apply: apply,
    visitorChoiceAllowed: visitorChoiceAllowed
  };
})();
