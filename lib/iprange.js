// =========================================================
// OpenWeb — IP-Adressen und Netze (IPv4/IPv6, CIDR) schnell pruefen
// ---------------------------------------------------------
// Fuer den Bot-Schutz (lib/botguard.js): Sperr- und Freigabelisten mit vielen Eintraegen.
// Eintraege werden zu sortierten, zusammengefassten Bereichen [start, end] (BigInt) und per
// binaerer Suche geprueft. IPv4-mapped IPv6 (::ffff:1.2.3.4) zaehlt als IPv4.
// =========================================================

const net = require('net');

function v4ToBig(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
}

function v6ToBig(ip) {
  let addr = ip;
  // eingebettete IPv4 am Ende (z. B. ::ffff:1.2.3.4)
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = v4ToBig(v4[1]);
    addr = addr.slice(0, -v4[1].length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) return null;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

/**
 * Normalisiert eine Client-IP: liefert { family: 4|6, value: BigInt } oder null.
 * Zonen-IDs (fe80::1%eth0) werden entfernt, IPv4-mapped IPv6 wird zu IPv4.
 */
function parseIp(raw) {
  if (typeof raw !== 'string') return null;
  const ip = raw.trim().replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  const kind = net.isIP(ip);
  if (kind === 4) return { family: 4, value: v4ToBig(ip) };
  if (kind === 6) {
    const value = v6ToBig(ip.toLowerCase());
    if (value === null) return null;
    if (value >> 32n === 0xffffn) return { family: 4, value: value & 0xffffffffn };
    return { family: 6, value };
  }
  return null;
}

/**
 * Eintrag "1.2.3.4", "1.2.3.0/24", "2001:db8::/32" -> { family, start, end } oder null.
 * Ungueltiges (z. B. "any", Hostnamen, Bereiche mit "-") wird ignoriert.
 */
function parseEntry(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.length > 64) return null;
  const [addr, bitsRaw, extra] = text.split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.family === 4 ? 32 : 128;
  let bits = max;
  if (bitsRaw !== undefined) {
    if (!/^\d{1,3}$/.test(bitsRaw)) return null;
    bits = Number(bitsRaw);
    // IPv4-mapped mit /96+ Praefix (z. B. ::ffff:1.2.3.0/120)
    if (ip.family === 4 && net.isIP(addr.replace(/^\[|\]$/g, '')) === 6) bits -= 96;
    if (bits < 0 || bits > max) return null;
  }
  const hostBits = BigInt(max - bits);
  const start = (ip.value >> hostBits) << hostBits;
  const end = start + (1n << hostBits) - 1n;
  return { family: ip.family, start, end };
}

/**
 * Baut eine Liste fuer schnelle Abfragen. Gibt { has(ip), size, invalid } zurueck.
 */
function buildSet(entries) {
  const ranges = { 4: [], 6: [] };
  let invalid = 0;
  for (const e of entries || []) {
    const r = parseEntry(String(e));
    if (r) ranges[r.family].push([r.start, r.end]);
    else if (String(e).trim()) invalid += 1;
  }
  const merged = {};
  for (const fam of [4, 6]) {
    const list = ranges[fam].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out = [];
    for (const [s, e] of list) {
      const last = out[out.length - 1];
      if (last && s <= last[1] + 1n) { if (e > last[1]) last[1] = e; } else out.push([s, e]);
    }
    merged[fam] = out;
  }
  const size = merged[4].length + merged[6].length;
  return {
    size,
    invalid,
    has(rawIp) {
      const ip = typeof rawIp === 'object' && rawIp ? rawIp : parseIp(rawIp);
      if (!ip) return false;
      const list = merged[ip.family];
      let lo = 0, hi = list.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ip.value < list[mid][0]) hi = mid - 1;
        else if (ip.value > list[mid][1]) lo = mid + 1;
        else return true;
      }
      return false;
    },
  };
}

// Interne, private und besondere Netze: nie sperren oder pruefen (Proxys, NetBird/Tailscale, LAN)
const INTERNAL = buildSet([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.168.0.0/16', '::/128', '::1/128', 'fc00::/7', 'fe80::/10',
]);
function isInternal(ip) {
  return INTERNAL.has(ip);
}

// Text (Zeilen, Kommas, Leerzeichen, #-Kommentare) -> Eintraege
function splitList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .join(' ')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { parseIp, parseEntry, buildSet, isInternal, splitList };
