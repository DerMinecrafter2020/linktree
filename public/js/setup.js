(() => {
  'use strict';

  const form = document.getElementById('setup-form');
  const testDbBtn = document.getElementById('test-db-btn');
  const dbStatus = document.getElementById('db-status');
  const messageEl = document.getElementById('message');
  const passwordInput = form?.adminPassword;
  const strengthBar = document.getElementById('password-strength')?.querySelector('span');
  const passwordHints = document.querySelectorAll('#password-hint li');

  function showMessage(text, isError = false) {
    messageEl.className = isError ? 'error' : 'success';
    messageEl.textContent = text;
  }

  function safeText(s, max = 200) {
    return typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
  }

  function checkPasswordStrength(pw) {
    const rules = {
      length: pw.length >= 8,
      upper: /[A-Z]/.test(pw),
      lower: /[a-z]/.test(pw),
      digit: /\d/.test(pw),
      special: /[^A-Za-z0-9]/.test(pw),
    };
    const score = Object.values(rules).filter(Boolean).length;
    return { score, rules };
  }

  function updatePasswordStrength() {
    const pw = passwordInput?.value || '';
    const { score, rules } = checkPasswordStrength(pw);
    passwordHints?.forEach(li => {
      li.classList.toggle('met', rules[li.dataset.rule]);
    });
    if (strengthBar) {
      const pct = (score / 5) * 100;
      strengthBar.style.width = pct + '%';
      strengthBar.style.background =
        score <= 2 ? '#ff4d6d' : score === 3 ? '#ffcc00' : score === 4 ? '#00f0ff' : '#00ff88';
    }
  }
  passwordInput?.addEventListener('input', updatePasswordStrength);

  function safeUrl(u) {
    if (typeof u !== 'string') return null;
    const t = u.trim();
    if (!t) return null;
    if (/^(javascript|data|vbscript|file|about):/i.test(t)) return null;
    if (/^mailto:/i.test(t)) return t.slice(0, 200);
    try {
      const url = new URL(t);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      return url.toString().slice(0, 500);
    } catch { return null; }
  }

  async function api(method, path, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body !== null) opts.body = JSON.stringify(body);
    const r = await fetch('/api' + path, opts);
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { ok: false, error: text }; }
    if (r.status === 404) {
      throw new Error('Setup-API nicht erreichbar. Das Setup wurde bereits abgeschlossen oder der Server ist noch am Starten.');
    }
    if (!r.ok || !json.ok) throw new Error(json.error || 'HTTP ' + r.status);
    return json.data;
  }

  async function loadExistingConfig() {
    try {
      const cfg = await api('GET', '/setup/config');
      if (!cfg) return;
      if (cfg.databaseUrl) form.databaseUrl.value = cfg.databaseUrl;
      if (cfg.port) form.port.value = cfg.port;
      if (cfg.appUrl) form.appUrl.value = cfg.appUrl;
      if (cfg.adminEmail) form.adminEmail.value = cfg.adminEmail;
      if (cfg.navidromeUrl) form.navidromeUrl.value = cfg.navidromeUrl;
      if (cfg.navidromeUsername) form.navidromeUsername.value = cfg.navidromeUsername;
      if (cfg.databaseUrl) {
        dbStatus.textContent = 'Vorhandene Datenbank-URL geladen.';
      }
    } catch (err) {
      console.warn('Konnte vorhandene Config nicht laden:', err.message);
      if (String(err.message).includes('Setup-API nicht erreichbar')) {
        showMessage('Das Setup ist bereits abgeschlossen. Du wirst zur Login-Seite weitergeleitet…', true);
        setTimeout(() => { location.href = '/login'; }, 3000);
      }
    }
  }

  testDbBtn.addEventListener('click', async () => {
    const url = form.databaseUrl.value.trim();
    if (!url) { dbStatus.textContent = 'Bitte eine URL eingeben.'; return; }
    testDbBtn.disabled = true;
    dbStatus.textContent = 'Teste…';
    try {
      const res = await api('POST', '/setup/test-database', { databaseUrl: url });
      dbStatus.textContent = res.ok ? '✅ Verbindung OK' : '❌ Fehler: ' + res.error;
    } catch (err) {
      dbStatus.textContent = '❌ Fehler: ' + err.message;
      if (String(err.message).includes('Setup-API nicht erreichbar')) {
        setTimeout(() => { location.href = '/login'; }, 2500);
      }
    } finally {
      testDbBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showMessage('');

    const adminPassword = form.adminPassword.value;
    if (adminPassword !== form.adminPasswordConfirm.value) {
      showMessage('Passwörter stimmen nicht überein.', true);
      return;
    }
    const { score } = checkPasswordStrength(adminPassword);
    if (score < 3) {
      showMessage('Admin-Passwort ist zu schwach. Bitte erfülle mindestens 3 der 5 Kriterien.', true);
      return;
    }

    const databaseUrl = form.databaseUrl.value.trim();
    if (!databaseUrl) {
      showMessage('DATABASE_URL ist Pflicht.', true);
      return;
    }

    const links = [];
    document.querySelectorAll('.link-row').forEach(row => {
      const title = safeText(row.querySelector('[data-field="title"]').value, 80);
      const url = safeUrl(row.querySelector('[data-field="url"]').value);
      const icon = safeText(row.querySelector('[data-field="icon"]').value, 8) || '🔗';
      if (title && url) links.push({ title, url, icon });
    });

    const payload = {
      databaseUrl,
      adminEmail: form.adminEmail.value.trim().toLowerCase(),
      adminPassword,
      port: form.port.value || '3000',
      appUrl: safeUrl(form.appUrl.value) || 'http://localhost:' + (form.port.value || '3000'),
      profile: {
        name: safeText(form.profileName.value, 80),
        handle: safeText(form.profileHandle.value, 80),
        bio: safeText(form.profileBio.value, 280),
        avatar: safeText(form.profileAvatar.value, 2).toUpperCase() || 'CA',
      },
      links,
      navidromeUrl: safeUrl(form.navidromeUrl.value),
      navidromeUsername: safeText(form.navidromeUsername.value, 120),
      navidromePassword: String(form.navidromePassword.value || ''),
      navidromePollIntervalSec: 30,
    };

    try {
      const result = await api('POST', '/setup', payload);
      showMessage(result.message + ' Server startet neu… Bitte warte 10 Sekunden, dann aktualisiere die Seite.');
      setTimeout(() => { location.href = '/login'; }, 10000);
    } catch (err) {
      showMessage(err.message, true);
    }
  });

  loadExistingConfig();
})();
