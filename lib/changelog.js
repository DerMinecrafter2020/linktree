// =========================================================
// OpenWeb – Changelog als Daten (fuer "Was ist neu?" im Admin)
// ---------------------------------------------------------
// Liest public/changelog.html (eigene, vertrauenswuerdige Datei) einmal ein und zerlegt die
// Eintraege <div class="changelog-entry"><h2>DATUM — OpenWeb vX.Y.Z (Titel)</h2><ul><li>…</li></ul>.
// Als "groessere Aenderung" gelten Feature-Versionen (X.Y.0, also Minor/Major), siehe AGENTS.md.
// Ausgegeben wird nur reiner Text (Label aus <strong>…:</strong> + Rest); das Frontend setzt ihn per
// textContent.
// =========================================================
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'changelog.html');
let cache = null;

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function plain(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim().replace(/^v/i, ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const x = Array.isArray(a) ? a : parseVersion(a);
  const y = Array.isArray(b) ? b : parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function parse(html) {
  const entries = [];
  const re = /<div class="changelog-entry">\s*<h2>([\s\S]*?)<\/h2>\s*<ul>([\s\S]*?)<\/ul>/g;
  let m;
  while ((m = re.exec(html))) {
    const heading = plain(m[1]);
    const versions = [...heading.matchAll(/v(\d+\.\d+\.\d+)/g)].map((x) => x[1]);
    if (!versions.length) continue;
    // Bei Bereichen ("v3.0.6 – v3.0.8") zaehlt die hoechste Version
    const version = versions.sort(compareVersions).pop();
    const date = (/^(\d{4}-\d{2}-\d{2})/.exec(heading) || [])[1] || null;
    const title = (/\(([^)]*)\)\s*$/.exec(heading) || [])[1] || '';
    const items = [...m[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((li) => {
      const label = /^\s*<strong>([\s\S]*?)<\/strong>/.exec(li[1]);
      const text = plain(label ? li[1].slice(label[0].length) : li[1]);
      return { label: label ? plain(label[1]).replace(/:\s*$/, '') : '', text };
    }).filter((it) => it.text || it.label);
    const v = parseVersion(version);
    entries.push({ version, date, title, items, feature: Boolean(v && v[2] === 0) });
  }
  return entries;
}

function getEntries() {
  if (!cache) {
    try {
      cache = parse(fs.readFileSync(FILE, 'utf8'));
    } catch (err) {
      console.warn('[changelog] nicht lesbar:', err.message);
      cache = [];
    }
  }
  return cache;
}

/**
 * Feature-Versionen fuer "Was ist neu?".
 * since: zuletzt gesehene Version → alle Feature-Versionen danach (bis current);
 * ohne since: die neuesten `limit` Feature-Versionen.
 */
function highlights({ since = null, current, limit = 5 } = {}) {
  const sinceV = parseVersion(since);
  const list = getEntries()
    .filter((e) => e.feature && (!current || compareVersions(e.version, current) <= 0))
    .filter((e) => !sinceV || compareVersions(e.version, sinceV) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return { entries: list.slice(0, limit), more: Math.max(0, list.length - limit) };
}

module.exports = { parse, highlights, parseVersion, compareVersions, getEntries };
