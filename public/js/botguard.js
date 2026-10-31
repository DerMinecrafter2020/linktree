// =========================================================
// OpenWeb – Bot-Pruefung (Proof-of-Work), Gegenstueck zu lib/botguard.js
// ---------------------------------------------------------
// Sucht eine Zahl n, sodass SHA-256("<challenge>:<n>") mit <bits> Null-Bits beginnt, und schickt
// sie an /__botguard/verify. Der Server setzt dann ein Freigabe-Cookie und wir laden die Seite.
// Gerechnet wird in einem Web Worker (js/botguard-worker.js), sonst in kleinen Bloecken.
// =========================================================
(function () {
  'use strict';

  var root = document.getElementById('botguard');
  if (!root) return;
  var challenge = root.getAttribute('data-challenge') || '';
  var bits = Number(root.getAttribute('data-bits')) || 17;
  var returnTo = root.getAttribute('data-return') || '/';
  var statusEl = document.getElementById('botguard-status');
  var progressEl = document.getElementById('botguard-progress');
  // Texte kommen vom Server in der Sprache des Besuchers (lib/i18n.js), Deutsch als Rueckfall
  function msg(name, fallback) { return root.getAttribute('data-msg-' + name) || fallback; }

  // ---------- SHA-256 (kompakt, synchron) ----------
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var W = new Uint32Array(64);

  // Liefert die ersten 32 Bit des Hashes (mehr brauchen wir fuer die Null-Bits nicht; bits <= 32)
  function sha256First32(bytes) {
    var len = bytes.length;
    var total = ((len + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    var bitLen = len * 8;
    buf[total - 4] = (bitLen >>> 24) & 255;
    buf[total - 3] = (bitLen >>> 16) & 255;
    buf[total - 2] = (bitLen >>> 8) & 255;
    buf[total - 1] = bitLen & 255;
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    for (var off = 0; off < total; off += 64) {
      for (var i = 0; i < 16; i++) {
        var j = off + i * 4;
        W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
      }
      for (i = 16; i < 64; i++) {
        var w15 = W[i - 15], w2 = W[i - 2];
        var s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
        var s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return h0 >>> 0;
  }

  var prefix = new TextEncoder().encode(challenge + ':');
  var expected = Math.pow(2, bits);
  var mask = bits >= 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);

  function digits(n) {
    var s = String(n);
    var out = new Uint8Array(prefix.length + s.length);
    out.set(prefix);
    for (var i = 0; i < s.length; i++) out[prefix.length + i] = s.charCodeAt(i);
    return out;
  }

  function setStatus(text) { if (statusEl) statusEl.textContent = text; }
  function setProgress(p) { if (progressEl) progressEl.style.width = Math.min(96, Math.round(p * 100)) + '%'; }

  var started = Date.now();

  // Bevorzugt im Web Worker rechnen (Seite bleibt fluessig), sonst in Bloecken mit Pausen
  function startWorker() {
    try {
      var worker = new Worker('/js/botguard-worker.js');
      worker.onmessage = function (e) {
        if (e.data && e.data.done) { worker.terminate(); done(e.data.solution); }
        else if (e.data && e.data.progress) setProgress(1 - Math.exp(-e.data.progress / expected));
      };
      worker.onerror = function () { worker.terminate(); fallback(); };
      worker.postMessage({ challenge: challenge, bits: bits });
    } catch (err) {
      fallback();
    }
  }

  var n = 0;
  function fallback() {
    var until = Date.now() + 25;
    while (Date.now() < until) {
      for (var k = 0; k < 300; k++, n++) {
        if ((sha256First32(digits(n)) & mask) === 0) return done(n);
      }
    }
    setProgress(1 - Math.exp(-n / expected));
    setTimeout(fallback, 16); // Zeit zum Zeichnen lassen
  }

  function done(solution) {
    setProgress(1);
    setStatus(msg('done', 'Geschafft – einen Augenblick …'));
    fetch('/__botguard/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ challenge: challenge, solution: solution, return: returnTo, ms: Date.now() - started })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) { return { res: res, json: json }; });
    }).then(function (r) {
      if (r.res.ok && r.json && r.json.ok) {
        var target = (r.json.data && r.json.data.redirect) || '/';
        location.replace(target.charAt(0) === '/' && target.charAt(1) !== '/' ? target : '/');
      } else {
        setStatus((r.json && r.json.error) || msg('failed', 'Die Prüfung ist fehlgeschlagen. Bitte lade die Seite neu.'));
        if (progressEl) progressEl.parentNode.classList.add('error');
      }
    }).catch(function () {
      setStatus(msg('offline', 'Keine Verbindung. Bitte lade die Seite neu.'));
    });
  }

  if (!window.TextEncoder) {
    setStatus(msg('old', 'Dein Browser ist zu alt für diese Prüfung.'));
    return;
  }
  if (window.Worker) startWorker(); else setTimeout(fallback, 50);
})();
