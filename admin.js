// =========================================================
// Admin-Logik
// =========================================================
// Funktionen:
//   - Login mit Passwort (client-seitig)
//   - Tab-Navigation
//   - Profil bearbeiten
//   - Links: CRUD + Drag & Drop + Pfeile
//   - Export / Import / Reset (JSON)
//   - Passwort ändern
//   - Realtime-Update über Supabase
// =========================================================

(() => {
  'use strict';

  // =========================================================
  // KONFIGURATION
  // =========================================================
  // ⚠️ Nur Client-Schutz! Wer den Browser DevTools öffnet,
  //    kann den Hash (nicht das Klartext-Passwort) auslesen.
  //    Für echte Sicherheit aktiviere Supabase Auth (siehe README).
  //
  //    Schutzmechanismen hier:
  //    • PBKDF2-Hash mit 210 000 Iterationen + zufälligem Salt
  //    • Vergleich erfolgt konstant (timing-safe)
  //    • Passwort wird nirgends im Klartext gespeichert
  // =========================================================
  // KEIN localStorage mehr!
  // =========================================================
  // Das Admin-Passwort wird auf dem SERVER gehasht und geprueft
  // (auth-login Edge-Function). Sobald das Login erfolgreich ist,
  // bekommen wir ein JWT-Token zurueck, das wir nur in sessionStorage
  // halten (verschwindet beim Tab-Schliessen).
  const SESSION_KEY = 'linktree-admin-session';   // nur Ablaufzeit
  const TAB_STORAGE_KEY = 'linktree-admin-active-tab';
  const DEFAULT_PASSWORD = 'admin123';  // nur Anzeige im Form

  // =========================================================
  // STATE
  // =========================================================
  let state = {
    profile: null,
    links: []
  };

  // =========================================================
  // AUTH (server-side via auth-login Edge-Function)
  // =========================================================
  // Das JWT-Token wird von supabase-client.js in sessionStorage
  // gespeichert (TOKEN_KEY = 'admin-token'). Wir greifen hier
  // nur lesend darauf zu, weil supabase-client.js schreibt.
  const TOKEN_KEY = 'admin-token';
  const TOKEN_EXP = 'admin-token-exp';

  function setSession() {
    // Supabase-client hat das Token bereits in sessionStorage gesetzt.
    // Diese Funktion ist ein no-op für Kompatibilitaet.
  }
  function hasValidSession() {
    const tok = sessionStorage.getItem(TOKEN_KEY);
    if (!tok) return false;
    const exp = parseInt(sessionStorage.getItem(TOKEN_EXP) || '0', 10);
    if (!exp) return true;  // ungültiges Format, aber Token existiert
    return Date.now() < (exp * 1000) - 60_000;
  }
  function getAuthHeader() {
    const tok = sessionStorage.getItem(TOKEN_KEY);
    return tok ? `Bearer ${tok}` : '';
  }
  function clearSession() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_EXP);
    sessionStorage.removeItem(SESSION_KEY);
  }

  // Login via Supabase Edge-Function (auth-login)
  // Antwort: { ok: true, token: 'eyJ...', expiresAt: 1234567890 }
  async function loginServer(password) {
    return await window.SupabaseAPI.authLogin({ password: password, honeypot: '' });
  }

  // Alte PW-Funktionen (bleiben fuer Migration / Force-Change-Fallback)
  // === REMOVED: localStorage-Password-Logik ===
  // Wir speichern KEIN Passwort mehr client-seitig. setPassword ruft
  // die Server-Edge-Function auth-change-password.
  async function setPassword(newPw) {
    return await window.SupabaseAPI.authChangePassword({
      oldPassword: '',  // bei Force-Change weiss der Server das schon
      newPassword: newPw
    });
  }

  // Force-Change-Check: server liefert ein Flag im Token
  function mustChangePassword() {
    const tok = sessionStorage.getItem(TOKEN_KEY);
    if (!tok) return false;
    try {
      const parts = tok.split('.');
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.must_change === true;
    } catch { return false; }
  }

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // =========================================================
  // TOAST
  // =========================================================
  let toastTimer;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2500);
  }

  // =========================================================
  // LOGIN
  // =========================================================
  // -- Strategie:
  //   Wenn config.js authEnabled: true UND Edge-Function auth-login
  //   existiert → Passwort wird SERVER-seitig gegen den DB-Hash
  //   verifiziert, App bekommt ein signiertes JWT (1h TTL) zurück.
  //
  //   Sonst (authEnabled: false / fehlend): lokaler PBKDF2-Vergleich
  //   aus localStorage (klassisches Verhalten).
  function bindLogin() {
    const form = $('#login-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = $('#login-password').value;
      const honeypot = form.querySelector('input[name="website"]')?.value;
      const errEl = $('#login-error');
      const submitBtn = form.querySelector('button[type="submit"]');

      // Honeypot-Trip: Bot erkannt → still ablehnen
      if (honeypot) {
        errEl.textContent = 'Falsches Passwort';
        return;
      }

      // UI: busy
      submitBtn.disabled = true;
      submitBtn.textContent = 'Prüfe…';
      errEl.textContent = '';

      // Rate-Limit-Check (clientseitig, Defense-in-Depth)
      if (!consumeLoginAttempt()) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Anmelden';
        errEl.textContent = `Zu viele Versuche. Warte ${Math.ceil(getLockoutRemaining()/1000)}s.`;
        return;
      }

      const start = performance.now();

// ---- Auth-Modus wählen ----
      // IMMER server-side (auth-login Edge-Function). Wir speichern
      // kein Passwort im Browser, daher ist das die einzige Option.
      const useEdgeAuth = !!window.SUPABASE_CONFIG?.authLoginUrl;

      let ok = false;
      try {
        if (useEdgeAuth) {
          // Server-side verify via Edge Function
          await window.db.login(pw, honeypot);
          ok = true;
        } else {
          // Kein Server-Login konfiguriert -> Login nicht moeglich
          throw new Error('auth-login nicht konfiguriert');
        }
      } catch (e) {
        console.warn('[login] failed:', e.message);
        ok = false;
      }

      // Konstante Wartezeit (verhindert User-Enumeration über Antwortzeit)
      while (performance.now() - start < 250) { /* busy-wait */ }

      if (ok) {
        resetLoginAttempts();
        setSession();
        $('#login-overlay').hidden = true;
        $('#app').hidden = false;
        initApp();
        // Wenn das Default-Passwort noch aktiv ist → User zum Ändern zwingen
        if (mustChangePassword()) {
          showForceChangePasswordDialog();
        }
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Anmelden';
        errEl.textContent = 'Falsches Passwort';
        $('#login-password').value = '';
        $('#login-password').focus();
      }
    });
  }

  // =========================================================
  // LOGIN RATE-LIMIT
  // =========================================================
  const LOGIN_WINDOW_MS = 5 * 60 * 1000;   // 5 min Beobachtungsfenster
  const LOGIN_MAX_TRIES = 5;
  const LOGIN_LOCKOUT_MS = 60 * 1000;     // 1 min Sperre

  function getLoginState() {
    try { return JSON.parse(sessionStorage.getItem('login-attempts') || '{}'); }
    catch { return {}; }
  }
  function setLoginState(s) {
    sessionStorage.setItem('login-attempts', JSON.stringify(s));
  }
  function consumeLoginAttempt() {
    const now = Date.now();
    let s = getLoginState();
    if (s.lockedUntil && s.lockedUntil > now) return false;
    if (s.lockedUntil && s.lockedUntil <= now) {
      s = { tries: [], lockedUntil: 0 };
    }
    s.tries = (s.tries || []).filter(t => now - t < LOGIN_WINDOW_MS);
    s.tries.push(now);
    if (s.tries.length >= LOGIN_MAX_TRIES) {
      s.lockedUntil = now + LOGIN_LOCKOUT_MS;
    }
    setLoginState(s);
    return true;
  }
  function resetLoginAttempts() {
    sessionStorage.removeItem('login-attempts');
  }
  function getLockoutRemaining() {
    const s = getLoginState();
    if (!s.lockedUntil) return 0;
    return Math.max(0, s.lockedUntil - Date.now());
  }

  // =========================================================
  // TABS
  // =========================================================
  const TAB_TITLES = { links: 'Links', profile: 'Profil', music: 'Musik', data: 'Daten', settings: 'Einstellungen' };

  function switchTab(name) {
    if (!TAB_TITLES[name]) name = 'links';
    $$('.side-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => (t.hidden = t.dataset.tab !== name));
    $('#tab-title').textContent = TAB_TITLES[name];
    sessionStorage.setItem(TAB_STORAGE_KEY, name);
  }

  function bindTabs() {
    $$('.side-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    $('#logout-btn').addEventListener('click', () => {
      // Vor Reload alles abräumen — in beiden Modi identisch
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(TAB_STORAGE_KEY);
      sessionStorage.removeItem('admin-token');
      sessionStorage.removeItem('admin-token-created');
      sessionStorage.removeItem('admin-token-exp');
      sessionStorage.removeItem('login-attempts');
      // Server-JWT abmelden, falls vorhanden
      try { window.db?.logout?.(); } catch { /* db evtl. noch nicht ready */ }
      location.reload();
    });

    // Zuletzt gewählten Tab nach Reload wiederherstellen
    const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (saved && TAB_TITLES[saved]) switchTab(saved);
  }

  // =========================================================
  // CONNECTION-STATUS
  // =========================================================
  function setConnection(state) {
    const el = $('#connection-state');
    el.classList.remove('ok', 'mock', 'err');
    if (state === 'ok') {
      el.classList.add('ok');
      el.textContent = '● Supabase';
    } else if (state === 'mock') {
      el.classList.add('mock');
      el.textContent = '● Setup fehlt';
    } else {
      el.classList.add('err');
      el.textContent = '● Offline';
    }

    // Settings tab
    const setEl = $('#settings-connection');
    const urlEl = $('#settings-url');
    if (setEl && urlEl) {
      const cfg = window.SUPABASE_CONFIG;
      setEl.textContent = state === 'ok'
        ? '✅ Mit Supabase verbunden. Daten werden in der Cloud gespeichert.'
        : state === 'mock'
        ? '⚠️ Supabase nicht konfiguriert. Bitte URL + Anon-Key unten eintragen.'
        : '❌ Keine Verbindung. Prüfe Internet.';
      urlEl.textContent = cfg?.url || '(keine URL)';
    }
  }

  // =========================================================
  // SETUP-FORM (wenn Supabase nicht konfiguriert ist)
  // =========================================================
  // Wenn window.db.needsSetup === true, zeigen wir ein Formular an,
  // in dem der User Supabase-URL + Anon-Key eintippt. Diese werden
  // via SupabaseAPI.saveConfig() an die save-config Edge-Function
  // geschickt, die /var/html/config.js auf dem Server aktualisiert.
  // Danach: Seite neu laden, dann ist Supabase verfuegbar.
  function showSetupForm() {
    // Overlay wie Login-Overlay
    let modal = document.getElementById('supabase-setup-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'supabase-setup-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;overflow:auto;';
      modal.innerHTML = `
        <div style="background:var(--bg-1,#1a1a2e);color:var(--text,#fff);padding:30px;border-radius:14px;max-width:520px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,0.5);">
          <h2 style="margin:0 0 8px;font-size:20px;color:var(--neon-pink,#ff2bd6);">🔧 Supabase konfigurieren</h2>
          <p style="margin:0 0 18px;font-size:14px;color:var(--text-dim,#aaa);line-height:1.5;">
            Bitte trage deine Supabase-Projekt-URL und den anon-Key ein.
            Diese werden in <code>config.js</code> auf dem Server gespeichert.
          </p>
          <form id="supabase-setup-form">
            <label style="display:block;margin-bottom:14px;font-size:13px;">
              <span style="display:block;margin-bottom:6px;color:var(--text-dim,#aaa);">Supabase URL</span>
              <input type="url" name="url" required placeholder="https://xxxxxxxxxxxx.supabase.co"
                style="width:100%;padding:10px;background:var(--bg-2,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:14px;font-family:monospace;">
            </label>
            <label style="display:block;margin-bottom:18px;font-size:13px;">
              <span style="display:block;margin-bottom:6px;color:var(--text-dim,#aaa);">anon-key (public)</span>
              <input type="text" name="anonKey" required placeholder="eyJhbGciOi..."
                style="width:100%;padding:10px;background:var(--bg-2,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:13px;font-family:monospace;">
            </label>
            <label style="display:block;margin-bottom:18px;font-size:13px;">
              <span style="display:block;margin-bottom:6px;color:var(--text-dim,#aaa);">Shared Secret (optional — vom Server-Admin)</span>
              <input type="password" name="secret" placeholder="leer lassen falls nicht gesetzt"
                style="width:100%;padding:10px;background:var(--bg-2,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:14px;">
            </label>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
              <button type="submit" class="btn primary"
                style="padding:10px 20px;background:var(--neon-cyan,#00f0ff);color:#000;border:none;border-radius:6px;font-weight:600;cursor:pointer;">
                Speichern & neu laden
              </button>
            </div>
            <p id="supabase-setup-error" style="margin:10px 0 0;color:#ff5050;font-size:12px;"></p>
          </form>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('supabase-setup-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const url = form.url.value.trim();
        const anonKey = form.anonKey.value.trim();
        const secret = form.secret.value.trim();
        const errEl = document.getElementById('supabase-setup-error');
        errEl.textContent = '';

        try {
          errEl.textContent = 'Speichere...';
          await window.SupabaseAPI.saveConfig({ url, anonKey, secret });
          errEl.textContent = 'Gespeichert! Lade neu...';
          errEl.style.color = '#0f0';
          setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
          errEl.style.color = '#ff5050';
          errEl.textContent = 'Fehler: ' + err.message;
        }
      });
    }
  }

  // =========================================================
  // PROFIL
  // =========================================================

  // ---- Avatar-Upload-Helfer ----
  const AVATAR_MAX_PX = 512;
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB vor Verarbeitung
  const AVATAR_TARGET_BYTES = 80 * 1024;    // ~80 KB Ziel

  // Liest eine Datei, skaliert sie auf max. AVATAR_MAX_PX und gibt ein WebP-DataURL zurück.
  function processAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Keine Datei'));
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        return reject(new Error('Nur PNG, JPG, WebP oder GIF erlaubt.'));
      }
      if (file.size > AVATAR_MAX_BYTES) {
        return reject(new Error('Datei zu groß (max. 5 MB).'));
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Bild konnte nicht dekodiert werden.'));
        img.onload = () => {
          try {
            const w0 = img.naturalWidth, h0 = img.naturalHeight;
            const scale = Math.min(1, AVATAR_MAX_PX / Math.max(w0, h0));
            const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, w, h);

            // Qualitäts-Loop: Starte bei 0.9, gehe runter bis < ~80 KB oder q < 0.5
            let q = 0.9, dataUrl;
            // Versuche WebP; Fallback JPEG falls Browser kein WebP-Encode kann
            const tryEncode = (mime, quality) =>
              canvas.toDataURL(mime, quality);
            try { dataUrl = tryEncode('image/webp', q); }
            catch { dataUrl = tryEncode('image/jpeg', q); }

            while (dataUrl.length * 0.75 > AVATAR_TARGET_BYTES && q > 0.5) {
              q -= 0.1;
              try { dataUrl = tryEncode('image/webp', q); }
              catch { dataUrl = tryEncode('image/jpeg', q); }
            }
            resolve({ dataUrl, width: w, height: h, sizeKB: Math.round((dataUrl.length * 0.75) / 1024) });
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function updateAvatarPreview(state) {
    // state = { dataUrl } | { text: 'CA' } | null
    const text = $('#avatar-preview-text');
    const img  = $('#avatar-preview-img');
    const rm   = $('#avatar-remove');
    if (!text || !img || !rm) return;

    if (state && state.dataUrl) {
      img.src = state.dataUrl;
      img.hidden = false;
      text.hidden = true;
      rm.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      text.hidden = false;
      rm.hidden = true;
    }
  }

  function bindAvatarUpload() {
    const fileInput   = $('#avatar-file');
    const textInput   = $('#profile-form [name="avatar"]');
    const useTextChk  = $('#avatar-use-text');
    const removeBtn   = $('#avatar-remove');

    if (!fileInput) return;

    // Drag & Drop auf das Preview-Element
    const preview = $('#avatar-preview');
    if (preview) {
      ['dragenter', 'dragover'].forEach(ev =>
        preview.addEventListener(ev, (e) => {
          e.preventDefault();
          preview.classList.add('drag-over');
        })
      );
      ['dragleave', 'drop'].forEach(ev =>
        preview.addEventListener(ev, (e) => {
          e.preventDefault();
          preview.classList.remove('drag-over');
        })
      );
      preview.addEventListener('drop', async (e) => {
        const f = e.dataTransfer?.files?.[0];
        if (f) await handleAvatarFile(f);
      });
    }

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (f) await handleAvatarFile(f);
      fileInput.value = ''; // damit dieselbe Datei nochmal wählbar ist
    });

    removeBtn?.addEventListener('click', () => {
      delete state.profile.avatar_url;
      updateAvatarPreview(null);
      textInput.value = textInput.value || 'CA';
    });

    useTextChk?.addEventListener('change', () => {
      if (useTextChk.checked) {
        delete state.profile.avatar_url;
        updateAvatarPreview(null);
      }
    });

    async function handleAvatarFile(f) {
      try {
        const result = await processAvatar(f);
        state.profile.avatar_url = result.dataUrl;
        if (useTextChk) useTextChk.checked = false;
        updateAvatarPreview({ dataUrl: result.dataUrl });
        toast(`📷 Avatar verarbeitet: ${result.width}×${result.height} · ~${result.sizeKB} KB`);
      } catch (err) {
        toast('Avatar-Fehler: ' + err.message, true);
      }
    }
  }

  function bindProfile() {
    const form = $('#profile-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);

      // Avatar-Text: max 2 Zeichen, nur Buchstaben/Zahlen
      const avatarRaw = (fd.get('avatar') || '').toString().trim();
      const avatarClean = avatarRaw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 2) || 'CA';

      const profile = {
        name:   safeText(fd.get('name'),   80),
        handle: safeText(fd.get('handle'), 80),
        bio:    safeText(fd.get('bio'),   280),
        avatar: avatarClean
      };
      // avatar_url: explizit prüfen (DataURL oder null)
      if (state.profile?.avatar_url !== undefined) {
        const av = state.profile.avatar_url;
        if (av === null || av === undefined || av === '') {
          profile.avatar_url = null;
        } else if (typeof av === 'string') {
          // KEIN SVG (kann <script> enthalten und ist XSS-Vektor)
          if (/^data:image\/svg\+xml/i.test(av)) {
            toast('SVG-Avatare sind nicht erlaubt (PNG/JPG/WebP/GIF)', true);
            return;
          }
          // Nur sichere Bild-DataURLs
          if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(av)) {
            toast('Ungültiges Avatar-Format', true);
            return;
          }
          // Max 500 KB DataURL (Base64-encoded, ~350 KB Binär)
          if (av.length > 700_000) {
            toast('Avatar zu groß (max. 500 KB)', true);
            return;
          }
          profile.avatar_url = av;
        }
      }
      try {
        await window.db.saveProfile(profile);
        state.profile = await window.db.getProfile();
        toast('✅ Profil gespeichert');
      } catch (err) {
        toast('Fehler: ' + err.message, true);
      }
    });
  }

  function renderProfile() {
    if (!state.profile) return;
    const f = $('#profile-form');
    f.name.value    = state.profile.name || '';
    f.handle.value  = state.profile.handle || '';
    f.bio.value     = state.profile.bio || '';
    f.avatar.value  = state.profile.avatar || '';
    updateAvatarPreview(state.profile.avatar_url ? { dataUrl: state.profile.avatar_url } : null);
  }

  // =========================================================
  // LINKS: LISTE / RENDERING
  // =========================================================
  function renderLinks() {
    const list = $('#links-list');
    list.replaceChildren();
    if (!state.links.length) {
      const empty = document.createElement('li');
      empty.className = 'hint';
      empty.textContent = 'Noch keine Links – leg den ersten an.';
      list.appendChild(empty);
      return;
    }
    state.links.forEach((link, idx) => {
      const li = document.createElement('li');
      li.className = 'link-row';
      li.draggable = true;
      li.dataset.id = link.id;

      // Icon als DOM-Element (kein innerHTML, kein XSS-Vektor)
      const iconSpan = document.createElement('span');
      iconSpan.className = 'icon';
      if (link.icon) {
        if (/^https?:\/\//.test(link.icon)) {
          const img = document.createElement('img');
          img.src = link.icon;
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          img.onerror = () => { iconSpan.textContent = '🔗'; };
          iconSpan.appendChild(img);
        } else if (link.icon.startsWith('simpleicon:') && window.icons) {
          const id = link.icon.slice('simpleicon:'.length);
          if (/^[a-z0-9-]{1,32}$/.test(id) && window.icons.getInfo(id)) {
            const img = document.createElement('img');
            img.src = window.icons.url(id);
            img.alt = '';
            img.onerror = () => { iconSpan.textContent = '🔗'; };
            iconSpan.appendChild(img);
          } else {
            iconSpan.textContent = '🔗';
          }
        } else {
          iconSpan.textContent = link.icon.toString().slice(0, 8);
        }
      } else {
        iconSpan.textContent = '🔗';
      }

      // Handle, info, actions — via DOM
      const handle = document.createElement('span');
      handle.className = 'link-handle';
      handle.title = 'Ziehen zum Sortieren';
      handle.textContent = '⠿';

      const info = document.createElement('div');
      info.className = 'link-info';
      const title = document.createElement('div');
      title.className = 'title';
      const titleText = document.createElement('span');
      titleText.textContent = link.title || '';
      title.appendChild(titleText);
      const badge = document.createElement('span');
      badge.className = 'badge ' + (link.is_active ? 'on' : 'off');
      badge.textContent = link.is_active ? 'aktiv' : 'inaktiv';
      title.appendChild(badge);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = link.url || '';
      info.appendChild(title);
      info.appendChild(sub);

      const actions = document.createElement('div');
      actions.className = 'actions';
      ['up', 'down', 'edit', 'del'].forEach(act => {
        const btn = document.createElement('button');
        btn.className = 'icon-btn' + (act === 'del' ? ' danger' : '');
        btn.dataset.act = act;
        btn.title = act === 'up' ? 'Nach oben' : act === 'down' ? 'Nach unten'
                   : act === 'edit' ? 'Bearbeiten' : 'Löschen';
        btn.textContent = act === 'up' ? '↑' : act === 'down' ? '↓'
                       : act === 'edit' ? '✎' : '🗑';
        actions.appendChild(btn);
      });

      li.appendChild(handle);
      li.appendChild(iconSpan);
      li.appendChild(info);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  // =========================================================
  // LINKS: AKTIONEN
  // =========================================================
  function bindLinks() {
    $('#add-link-btn').addEventListener('click', () => openLinkDialog(null));

    $('#links-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.link-row');
      const id  = row.dataset.id;
      const idx = state.links.findIndex((l) => l.id === id);
      if (idx < 0) return;

      const act = btn.dataset.act;
      try {
        if (act === 'edit') {
          openLinkDialog(state.links[idx]);
        } else if (act === 'del') {
          if (!confirm(`„${state.links[idx].title}" wirklich löschen?`)) return;
          await window.db.deleteLink(id);
          await reloadLinks();
          toast('🗑️ Gelöscht');
        } else if (act === 'up' && idx > 0) {
          await swapLinks(idx, idx - 1);
        } else if (act === 'down' && idx < state.links.length - 1) {
          await swapLinks(idx, idx + 1);
        }
      } catch (err) {
        toast('Fehler: ' + err.message, true);
      }
    });

    // Drag & Drop
    let dragId = null;
    $('#links-list').addEventListener('dragstart', (e) => {
      const row = e.target.closest('.link-row');
      if (!row) return;
      dragId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    $('#links-list').addEventListener('dragend', async () => {
      $$('.link-row').forEach((r) => r.classList.remove('dragging', 'drag-over'));
      dragId = null;
    });
    $('#links-list').addEventListener('dragover', (e) => {
      e.preventDefault();
      const row = e.target.closest('.link-row');
      if (!row || row.dataset.id === dragId) return;
      $$('.link-row').forEach((r) => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    $('#links-list').addEventListener('drop', async (e) => {
      e.preventDefault();
      const row = e.target.closest('.link-row');
      if (!row || !dragId) return;
      const targetId = row.dataset.id;
      const from = state.links.findIndex((l) => l.id === dragId);
      const to   = state.links.findIndex((l) => l.id === targetId);
      if (from < 0 || to < 0 || from === to) return;
      await moveLink(from, to);
    });
  }

  async function swapLinks(i, j) {
    const links = state.links.slice();
    [links[i], links[j]] = [links[j], links[i]];
    state.links = links;
    renderLinks();
    try {
      await window.db.reorderLinks(links.map((l) => l.id));
    } catch (err) { toast('Fehler: ' + err.message, true); }
  }

  async function moveLink(from, to) {
    const links = state.links.slice();
    const [moved] = links.splice(from, 1);
    links.splice(to, 0, moved);
    state.links = links;
    renderLinks();
    try {
      await window.db.reorderLinks(links.map((l) => l.id));
    } catch (err) { toast('Fehler: ' + err.message, true); }
  }

  // =========================================================
  // ICON-PICKER
  // =========================================================
  // Speicherformat in der DB:
  //   - "🔗" (oder beliebiges Emoji)
  //   - "https://…" (Bild-URL)
  //   - "simpleicon:instagram" (Marken-Icon aus der Library)
  // =========================================================

  const POPULAR_IDS = ['instagram', 'tiktok', 'youtube', 'github', 'discord', 'twitch', 'spotify', 'x', 'linkedin', 'whatsapp', 'telegram', 'snapchat', 'reddit', 'facebook', 'figma', 'notion'];

  function initIconPicker() {
    const panel    = $('#icon-picker-panel');
    const toggle   = $('#icon-picker-toggle');
    const search   = $('#icon-search');
    const grid     = $('#icon-grid');
    const input    = $('#link-form [name="icon"]');
    const preview  = $('#icon-preview-target');
    const previewName = $('#icon-preview-name');
    const suggested = $('#icon-suggested-list');

    if (!panel || !toggle) return;

    // Vorschlagsliste initial rendern
    suggested.replaceChildren();
    POPULAR_IDS.forEach((id) => {
      const info = window.ICON_LIBRARY[id];
      const btn = document.createElement('button');
      btn.dataset.icon = `simpleicon:${id}`;
      const img = document.createElement('img');
      img.src = window.icons.url(id);
      img.alt = '';
      btn.appendChild(img);
      btn.appendChild(document.createTextNode(' ' + (info?.title || id)));
      btn.addEventListener('click', () => selectIcon(`simpleicon:${id}`));
      suggested.appendChild(btn);
    });

    // Panel ein-/ausklappen
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.classList.toggle('active', !panel.hidden);
      if (!panel.hidden) {
        // Initiale Anzeige: alle Icons (gruppiert)
        renderGrid('');
        // Aktuellen Wert als Vorschau anzeigen
        updatePreview(input.value);
        // Auto-Vorschlag basierend auf Titel/URL
        suggestForCurrentLink();
        setTimeout(() => search.focus(), 50);
      }
    });

    // Live-Vorschau, wenn direkt im Input getippt wird
    input.addEventListener('input', () => {
      updatePreview(input.value);
      // Tipp-Support: User tippt "instagram" → wird zu "simpleicon:instagram"
      // Nur, wenn es kein Emoji/Bild-URL ist und in der Library existiert.
      const raw = input.value.trim();
      if (raw && !/^https?:\/\//.test(raw) && !raw.startsWith('simpleicon:') && window.icons.getInfo(raw)) {
        const corrected = `simpleicon:${raw}`;
        // Cursor ans Ende setzen
        input.value = corrected;
        updatePreview(corrected);
      }
    });

    // Suche
    let searchTimer;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderGrid(search.value.trim().toLowerCase()), 120);
    });

    // Klick auf Icon-Zelle → übernehmen
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.icon-cell');
      if (!cell) return;
      const id = cell.dataset.id;
      if (!id) return;
      selectIcon(`simpleicon:${id}`);
    });

    // Klick auf Vorschlag
    suggested.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-icon]');
      if (!btn) return;
      selectIcon(btn.dataset.icon);
    });

    function selectIcon(value) {
      input.value = value;
      updatePreview(value);
      panel.hidden = true;
      toggle.classList.remove('active');
    }

    function updatePreview(value) {
      const parsed = window.icons.parse(value);
      preview.replaceChildren();
      if (parsed.type === 'simpleicon') {
        const img = document.createElement('img');
        img.src = parsed.url;
        img.alt = '';
        img.onerror = () => img.replaceWith(document.createTextNode('❌'));
        preview.appendChild(img);
        previewName.textContent = `simpleicon: ${parsed.label}`;
      } else if (parsed.type === 'url') {
        const img = document.createElement('img');
        img.src = parsed.url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.replaceWith(document.createTextNode('❌'));
        preview.appendChild(img);
        previewName.textContent = parsed.url;
      } else {
        preview.textContent = parsed.value || '🔗';
        previewName.textContent = 'Emoji / Text';
      }
    }

    function renderGrid(query) {
      const entries = window.icons.allEntries();
      const q = query.toLowerCase();

      const matched = q
        ? entries.filter((e) =>
            e.id.includes(q) ||
            e.title.toLowerCase().includes(q) ||
            (e.matchAlias && e.matchAlias.includes(q))
          )
        : entries.filter((e) => !e.matchAlias); // ohne Query: nur Haupt-Einträge

      // Deduplizieren nach id, Reihenfolge behalten
      const seen = new Set();
      const unique = [];
      for (const e of matched) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        unique.push(e);
      }

      if (unique.length === 0) {
        grid.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'icon-empty';
        empty.textContent = `Keine Treffer für „${query}"`;
        grid.appendChild(empty);
        return;
      }

      grid.replaceChildren();
      unique.slice(0, 200).forEach((e) => {
        const cell = document.createElement('div');
        cell.className = 'icon-cell';
        cell.dataset.id = e.id;
        cell.dataset.tip = e.title;
        const img = document.createElement('img');
        img.src = window.icons.url(e.id);
        img.alt = e.title;
        img.loading = 'lazy';
        img.onerror = () => img.replaceWith(document.createTextNode('🔗'));
        cell.appendChild(img);
        cell.addEventListener('click', () => selectIcon(`simpleicon:${e.id}`));
        grid.appendChild(cell);
      });

      // Aktuell gewählten Wert markieren
      const current = (input.value || '').startsWith('simpleicon:')
        ? input.value.slice('simpleicon:'.length) : null;
      if (current) {
        const cell = grid.querySelector(`[data-id="${current}"]`);
        if (cell) cell.classList.add('selected');
      }
    }

    function suggestForCurrentLink() {
      // Versuche, anhand von URL/Titel im aktuellen Formular ein Icon vorzuschlagen
      const url    = $('#link-form [name="url"]').value || '';
      const title  = $('#link-form [name="title"]').value || '';
      const guess  = window.icons.detectFromUrl(url, title);
      if (guess && !input.value) {
        const info = window.ICON_LIBRARY[guess];
        const btn = document.createElement('button');
        btn.dataset.icon = `simpleicon:${guess}`;
        btn.style.borderColor = 'var(--neon-cyan)';
        btn.style.color = 'var(--neon-cyan)';
        const img = document.createElement('img');
        img.src = window.icons.url(guess);
        img.alt = '';
        btn.appendChild(img);
        btn.appendChild(document.createTextNode(' ✨ Empfohlen: ' + (info?.title || guess)));
        btn.addEventListener('click', () => selectIcon(`simpleicon:${guess}`));
        suggested.appendChild(btn);
      }
    }
  }

  // Vorschau-Funktion global verfügbar machen (für openLinkDialog)
  function refreshIconPicker() {
    const input = $('#link-form [name="icon"]');
    const preview = $('#icon-preview-target');
    const previewName = $('#icon-preview-name');
    if (!input || !preview) return;
    const parsed = window.icons.parse(input.value);
    preview.replaceChildren();
    if (parsed.type === 'simpleicon') {
      const img = document.createElement('img');
      img.src = parsed.url;
      img.alt = '';
      img.onerror = () => img.replaceWith(document.createTextNode('❌'));
      preview.appendChild(img);
      previewName.textContent = `simpleicon: ${parsed.label}`;
    } else if (parsed.type === 'url') {
      const img = document.createElement('img');
      img.src = parsed.url;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.replaceWith(document.createTextNode('❌'));
      preview.appendChild(img);
      previewName.textContent = parsed.url;
    } else {
      preview.textContent = parsed.value || '🔗';
      previewName.textContent = 'Emoji / Text';
    }
  }

  // =========================================================
  // LINKS: DIALOG
  // =========================================================
  function openLinkDialog(link) {
    const dlg = $('#link-dialog');
    const form = $('#link-form');
    form.reset();
    $('#link-dialog-title').textContent = link ? 'Link bearbeiten' : 'Neuer Link';
    if (link) {
      form.title.value    = link.title || '';
      form.subtitle.value = link.subtitle || '';
      form.url.value      = link.url || '';
      form.icon.value     = link.icon || '';
      form.is_active.checked = link.is_active !== false;
      form.open_new.checked  = link.open_new !== false;
      form.dataset.id = link.id;
    } else {
      delete form.dataset.id;
      form.is_active.checked = true;
      form.open_new.checked  = true;
    }
    refreshIconPicker();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeLinkDialog() {
    const dlg = $('#link-dialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function bindLinkDialog() {
    $('#link-cancel').addEventListener('click', closeLinkDialog);

    $('#link-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const fd = new FormData(form);

      // URL validieren (gegen javascript:/data:/vbscript:)
      const urlClean = safeUrl(fd.get('url'));
      if (!urlClean) {
        toast('Ungültige URL (nur http, https oder mailto erlaubt)', true);
        return;
      }

      const data = {
        title:    safeText(fd.get('title'), 80),
        subtitle: safeText(fd.get('subtitle'), 120),
        url:      urlClean,
        icon:     sanitizeIconField(fd.get('icon')),
        is_active: form.is_active.checked,
        open_new:  form.open_new.checked
      };
      if (!data.title || !data.url) {
        toast('Titel und URL sind Pflicht', true);
        return;
      }

      try {
        const id = form.dataset.id;
        if (id) {
          await window.db.updateLink(id, data);
          toast('✅ Gespeichert');
        } else {
          await window.db.createLink({ ...data, position: state.links.length });
          toast('✅ Hinzugefügt');
        }
        closeLinkDialog();
        await reloadLinks();
      } catch (err) {
        toast('Fehler: ' + err.message, true);
      }
    });
  }

  // =========================================================
  // EXPORT / IMPORT / RESET
  // =========================================================
  function bindData() {
    $('#export-btn').addEventListener('click', () => {
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        profile: state.profile,
        links: state.links
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `linktree-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('📤 Exportiert');
    });

    $('#import-btn').addEventListener('click', () => $('#import-input').click());

    $('#import-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!confirm('Beim Import werden alle bestehenden Links und das Profil überschrieben. Fortfahren?')) {
        e.target.value = '';
        return;
      }
      try {
        const text = await file.text();
        const data = JSON.parse(text);

        // Profildaten sanitizen
        if (data.profile && typeof data.profile === 'object') {
          data.profile = {
            name:   safeText(data.profile.name,   80),
            handle: safeText(data.profile.handle, 80),
            bio:    safeText(data.profile.bio,   280),
            avatar: (String(data.profile.avatar || 'CA').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 2)) || 'CA'
          };
          if (typeof data.profile.avatar_url === 'string' && data.profile.avatar_url.startsWith('data:image/')) {
            data.profile.avatar_url = data.profile.avatar_url.slice(0, 500_000);
          } else {
            delete data.profile.avatar_url;
          }
          await window.db.saveProfile(data.profile);
        }

        if (Array.isArray(data.links)) {
          // Bestehende löschen, dann neu anlegen (mit Validierung)
          for (const l of state.links) await window.db.deleteLink(l.id);
          for (let i = 0; i < data.links.length; i++) {
            const l = data.links[i];
            const urlClean = safeUrl(l.url);
            if (!urlClean) continue; // ungültige URLs überspringen
            await window.db.createLink({
              title:    safeText(l.title, 80),
              subtitle: safeText(l.subtitle, 120),
              url:      urlClean,
              icon:     sanitizeIconField(l.icon),
              is_active: l.is_active !== false,
              open_new:  l.open_new !== false,
              position: i
            });
          }
        }
        await reloadAll();
        toast('📥 Importiert');
      } catch (err) {
        toast('Import fehlgeschlagen: ' + err.message, true);
      }
      e.target.value = '';
    });

    $('#reset-btn').addEventListener('click', async () => {
      if (!confirm('Wirklich alles zurücksetzen? Das löscht alle Links und setzt das Profil zurück.')) return;
      try {
        // Supabase-Modus: alle löschen, dann Default-Seed schreiben
        for (const l of state.links) await window.db.deleteLink(l.id);
        await window.db.saveProfile({
          name: '@corneliusahner',
          handle: 'Cornelius Ahner',
          bio: 'Azubi, 21 Jahre alt',
          avatar: 'CA'
        });
        const defaults = [
          { title: 'Instagram', subtitle: '@cornelius_0511', url: 'https://www.instagram.com/cornelius_0511/', icon: '📸', is_active: true, open_new: true, position: 0 },
          { title: 'GitHub',    subtitle: 'Projekte auf Github', url: 'https://github.com/DerMinecrafter2020', icon: '💻', is_active: true, open_new: true, position: 1 },
          { title: 'Kontakt',   subtitle: 'admin@derminecrafter2020.com', url: 'mailto:admin@derminecrafter2020.com', icon: '✉️', is_active: true, open_new: false, position: 2 }
        ];
        for (const d of defaults) await window.db.createLink(d);
        await reloadAll();
        toast('🔄 Zurückgesetzt');
      } catch (err) {
        toast('Fehler: ' + err.message, true);
      }
    });
  }

  // =========================================================
  // SETTINGS
  // =========================================================
  function bindSettings() {
    // Hint-Text je nach Auth-Modus anpassen
    const hint = $('#change-pw-hint');
    if (hint) {
      const useEdgeAuth = !!window.SUPABASE_CONFIG?.authChangePasswordUrl;
      hint.replaceChildren();
      if (useEdgeAuth) {
        hint.append('Passwort wird ');
        const strong = document.createElement('strong');
        strong.textContent = 'serverseitig';
        hint.append(strong, ' als PBKDF2-Hash in Supabase gespeichert. Aktuelles Passwort zur Bestätigung nötig.');
      } else {
        hint.textContent = 'Passwort-Endpoint nicht konfiguriert — bitte Supabase Edge-Function "auth-change-password" deployen.';
      }
    }

    // ---- Passwort ändern ----
    $('#change-pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const opPw = form.old?.value || '';
      const np   = form.new.value;

      if (typeof np !== 'string' || np.length < 8) {
        toast('Mindestens 8 Zeichen empfohlen', true);
        return;
      }
      if (!/[a-zA-Z0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(np)) {
        toast('Bitte Buchstaben, Zahlen oder Sonderzeichen verwenden', true);
        return;
      }

      // IMMER server-side (kein localStorage-Fallback mehr)
      const useEdgeAuth = !!window.SUPABASE_CONFIG?.authChangePasswordUrl;

      try {
        if (useEdgeAuth) {
          if (opPw.length < 1) {
            toast('Bitte aktuelles Passwort eingeben', true);
            return;
          }
          await window.db.changePassword(opPw, np);
          form.reset();
          toast('🔑 Passwort serverseitig geändert');
        } else {
          toast('Passwort-Endpoint nicht konfiguriert', true);
        }
      } catch (err) {
        toast('Fehler: ' + err.message, true);
      }
    });
  }

  // =========================================================
  // FORCE-CHANGE-DIALOG (nach erstem Login)
  // =========================================================
  // Wenn STORAGE_PW_MUST_CHANGE gesetzt ist, MUSS der User beim ersten
  // Login das Default-Passwort aendern, bevor er die Admin-Oberflaeche
  // nutzen kann. Die Admin-Tabs sind solange gesperrt.
  function showForceChangePasswordDialog() {
    // Erstelle ein einfaches Modal als Overlay (falls noch nicht da)
    let modal = document.getElementById('force-change-pw-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'force-change-pw-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';
      modal.innerHTML = `
        <div style="background:var(--bg-1,#1a1a2e);color:var(--text,#fff);padding:30px;border-radius:14px;max-width:420px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.5);">
          <h2 style="margin:0 0 12px;font-size:20px;color:var(--neon-pink,#ff2bd6);">🔑 Passwort ändern</h2>
          <p style="margin:0 0 18px;font-size:14px;color:var(--text-dim,#aaa);line-height:1.5;">
            Du loggst dich gerade mit dem <strong>Standard-Passwort</strong> ein.
            Bitte ändere es jetzt auf ein eigenes, sicheres Passwort (min. 8 Zeichen).
          </p>
          <form id="force-change-pw-form">
            <label style="display:block;margin-bottom:14px;font-size:13px;">
              <span style="display:block;margin-bottom:6px;color:var(--text-dim,#aaa);">Aktuelles Passwort (admin123)</span>
              <input type="password" name="old" required autocomplete="current-password"
                style="width:100%;padding:10px;background:var(--bg-2,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:14px;">
            </label>
            <label style="display:block;margin-bottom:14px;font-size:13px;">
              <span style="display:block;margin-bottom:6px;color:var(--text-dim,#aaa);">Neues Passwort</span>
              <input type="password" name="new" required minlength="8" autocomplete="new-password"
                style="width:100%;padding:10px;background:var(--bg-2,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:14px;">
            </label>
            <label style="display:block;margin-bottom:18px;font-size:13px;">
              <span style="display:block;margin-bottom:6px;color:var(--text-dim,#aaa);">Neues Passwort bestätigen</span>
              <input type="password" name="confirm" required minlength="8" autocomplete="new-password"
                style="width:100%;padding:10px;background:var(--bg-2,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:14px;">
            </label>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
              <button type="submit" class="btn primary"
                style="padding:10px 20px;background:var(--neon-cyan,#00f0ff);color:#000;border:none;border-radius:6px;font-weight:600;cursor:pointer;">
                Passwort jetzt ändern
              </button>
            </div>
            <p id="force-change-pw-error" style="margin:10px 0 0;color:#ff5050;font-size:12px;"></p>
          </form>
        </div>
      `;
      document.body.appendChild(modal);

      // Admin-Inhalt waehrend des Wechsels nicht-interaktiv machen
      const appEl = document.getElementById('app');
      if (appEl) appEl.style.pointerEvents = 'none';

      // Form-Handler
      document.getElementById('force-change-pw-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const oldPw = form.old.value;
        const newPw = form.new.value;
        const confirmPw = form.confirm.value;
        const errEl = document.getElementById('force-change-pw-error');

        errEl.textContent = '';
        if (newPw.length < 8) {
          errEl.textContent = 'Neues Passwort muss mindestens 8 Zeichen haben';
          return;
        }
        if (newPw !== confirmPw) {
          errEl.textContent = 'Passwörter stimmen nicht überein';
          return;
        }

        // Server-side: altes PW verifizieren + neues setzen
        // Da wir schon eingeloggt sind (JWT im sessionStorage), reicht
        // es, auth-change-password mit dem aktuellen JWT + oldPW aufzurufen.
        try {
          await window.SupabaseAPI.authChangePassword({
            oldPassword: oldPw,
            newPassword: newPw
          });
        } catch (err) {
          errEl.textContent = 'Server-Fehler: ' + err.message;
          return;
        }

        // Modal entfernen, Admin wieder interaktiv
        modal.remove();
        const appEl2 = document.getElementById('app');
        if (appEl2) appEl2.style.pointerEvents = '';
        toast('🔑 Passwort erfolgreich auf dem Server geändert!');
      });
    }
  }

  // =========================================================
  // RELOAD
  // =========================================================
  async function reloadLinks() {
    state.links = await window.db.listLinks();
    renderLinks();
  }
  async function reloadAll() {
    [state.profile, state.links] = await Promise.all([
      window.db.getProfile(),
      window.db.listLinks()
    ]);
    renderProfile();
    renderLinks();
  }

  // =========================================================
  // HELPERS
  // =========================================================
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Validiert eine URL: muss http(s) oder mailto sein, KEIN javascript:/data:/vbscript:
  function safeUrl(u) {
    if (typeof u !== 'string') return null;
    const trimmed = u.trim();
    if (!trimmed) return null;
    // Blacklist gefährlicher Protokolle
    if (/^(javascript|data|vbscript|file|about):/i.test(trimmed)) return null;
    try {
      // mailto: ist erlaubt
      if (/^mailto:/i.test(trimmed)) return trimmed.slice(0, 200);
      // Sonst muss es eine valide http(s)-URL sein
      const url = new URL(trimmed);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      return url.toString().slice(0, 500);
    } catch {
      return null;
    }
  }

  // Erlaubt Emoji oder simpleicon:ID, aber NIE rohe URLs in diesem Feld
  // (Bild-URLs für Icons sind im Admin erlaubt, werden aber durch safeUrl geprüft)
  function sanitizeIconField(s) {
    if (typeof s !== 'string') return '🔗';
    const t = s.trim();
    if (!t) return '🔗';
    if (t.startsWith('simpleicon:')) {
      const id = t.slice('simpleicon:'.length).toLowerCase();
      // Nur a-z, 0-9, - und max 32 Zeichen
      if (/^[a-z0-9-]{1,32}$/.test(id)) return `simpleicon:${id}`;
      return '🔗';
    }
    if (/^https?:\/\//i.test(t)) {
      // Externe Bild-URL: nur erlauben, wenn safeUrl OK
      return safeUrl(t) || '🔗';
    }
    // Sonst Emoji: max 8 Zeichen, kein <, >, "
    return t.slice(0, 8).replace(/[<>"']/g, '');
  }

  // Validiert die einfachen Text-Felder (Name, Handle, Bio, Title)
  function safeText(s, max = 200) {
    if (typeof s !== 'string') return '';
    return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  }

  // =========================================================
  // INIT
  // =========================================================
  // =========================================================
  // NAVIDROME (Tab "Musik")
  // =========================================================
  // KEIN localStorage mehr! Navidrome-Config wird in-memory gehalten
  // (window.NAVIDROME_CONFIG) und nach Reload neu aus dem Formular
  // geladen. Credentials (URL/User/Pass) bleiben in Supabase-Secrets
  // und werden NIE im Browser gespeichert.

  function loadNavidromeConfig() {
    // Nur die Browser-Override-Werte, KEIN localStorage
    return window.NAVIDROME_CONFIG || null;
  }

  function saveNavidromeConfig(cfg) {
    // In-memory speichern — kein localStorage!
    const minimal = {
      enabled: !!cfg.enabled,
      proxyUrl: cfg.proxyUrl || '',
      pollIntervalSec: cfg.pollIntervalSec || 30,
    };
    window.NAVIDROME_CONFIG = Object.assign({}, window.NAVIDROME_CONFIG || {}, minimal);
  }

  function renderNavidromeForm() {
    const form = $('#navidrome-form');
    if (!form) return;
    const cfg = window.NAVIDROME_CONFIG || {
      enabled: false,
      proxyUrl: (window.SUPABASE_CONFIG?.url
        ? window.SUPABASE_CONFIG.url.replace(/\/$/, '') + '/functions/v1/navidrome-proxy'
        : ''),
      pollIntervalSec: 30,
    };
    form.enabled.checked        = !!cfg.enabled;
    form.proxyUrl.value         = cfg.proxyUrl;
    form.pollIntervalSec.value  = cfg.pollIntervalSec;
  }

  function bindNavidrome() {
    const form = $('#navidrome-form');
    if (!form) return;
    renderNavidromeForm();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const proxyUrl = (form.proxyUrl.value || '').trim();
      const poll = parseInt(form.pollIntervalSec.value || '30', 10) || 30;

      if (proxyUrl && !/^https?:\/\//i.test(proxyUrl)) {
        toast('Proxy-URL muss mit http(s) beginnen', true);
        return;
      }
      if (form.enabled.checked && !proxyUrl) {
        toast('Bitte Proxy-URL eintragen oder Player deaktivieren', true);
        return;
      }

      saveNavidromeConfig({
        enabled: !!form.enabled.checked,
        proxyUrl,
        pollIntervalSec: Math.min(600, Math.max(10, poll)),
      });
      toast('🎵 Navidrome-Einstellungen gespeichert (lokal)');
    });

    $('#navidrome-test-btn')?.addEventListener('click', async () => {
      const status = $('#navidrome-status');
      const proxyUrl = (form.proxyUrl.value || '').trim();
      if (!proxyUrl) {
        status.textContent = '❌ Proxy-URL fehlt';
        return;
      }
      status.textContent = 'Prüfe…';
      try {
        // Temporär die im Formular eingetragene URL als aktive Proxy-URL setzen,
        // damit NavidromeAPI.post() dorthin sendet (statt zu window.NAVIDROME_CONFIG.proxyUrl)
        const savedProxyUrl = window.NAVIDROME_CONFIG?.proxyUrl;
        window.NAVIDROME_CONFIG = window.NAVIDROME_CONFIG || {};
        window.NAVIDROME_CONFIG.proxyUrl = proxyUrl;

        // 1) Status (Secrets vorhanden?)
        const s1 = await window.NavidromeAPI.status();
        if (!s1 || !s1.configured) {
          status.replaceChildren();
          status.append('❌ Secrets fehlen in Supabase.', document.createElement('br'));
          status.append('Lege sie an mit:', document.createElement('br'));
          const code = document.createElement('code');
          code.textContent = 'supabase secrets set NAVIDROME_URL=…';
          status.append(code, ' etc.');
          window.NAVIDROME_CONFIG.proxyUrl = savedProxyUrl;
          return;
        }
        // 2) NowPlaying (liefert echte Daten)
        const s2 = await window.NavidromeAPI.nowPlaying();
        if (!s2) {
          status.textContent = '❌ Status-Call fehlgeschlagen';
          window.NAVIDROME_CONFIG.proxyUrl = savedProxyUrl;
          return;
        }
        if (s2.playing) {
          status.textContent = '✅ ' + s2.url + ' — spielt: ' + s2.title + ' (' + s2.artist + ')';
        } else {
          status.textContent = '✅ ' + s2.url + ' — momentan läuft nichts';
        }
        window.NAVIDROME_CONFIG.proxyUrl = savedProxyUrl;
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Netzwerkfehler');
      }
    });
  }

  async function initApp() {
    try {
      if (window.db.isMock) setConnection('mock');
      else                   setConnection('ok');

      await reloadAll();

      // Realtime: bei Änderungen im Admin oder anderswo neu laden
      if (window.db.subscribe) {
        window.db.subscribe((changed) => reloadAll());
      }
    } catch (err) {
      setConnection('err');
      toast('Verbindung fehlgeschlagen: ' + err.message, true);
    }
  }

  // =========================================================
  // BOOT
  // =========================================================
  document.addEventListener('DOMContentLoaded', async () => {
    // KEIN ensureDefaultHash() mehr — das Passwort liegt nur auf dem Server.
    // Hier pruefen wir nur, ob eine aktive Session im Browser existiert.

    // Defensive: Wenn die App via file:// (lokal) läuft, gib einen Warnhinweis
    if (location.protocol === 'file:') {
      console.warn('%c[Security] %cApp läuft lokal über file://. Für Produktion über HTTPS hosten.',
        'color:#ff2bd6;font-weight:bold', 'color:inherit');
    }

    bindLogin();
    bindTabs();
    bindProfile();
    bindAvatarUpload();
    bindLinks();
    bindLinkDialog();
    initIconPicker();
    bindData();
    bindSettings();
    bindNavidrome();

    // Setup-Form zeigen, wenn Supabase nicht konfiguriert ist
    if (window.db && window.db.needsSetup) {
      $('#login-overlay').hidden = true;
      $('#app').hidden = false;
      showSetupForm();
      return;
    }

    // Auto-Login, falls Session aktiv
    if (hasValidSession()) {
      $('#login-overlay').hidden = true;
      $('#app').hidden = false;
      const start = () => window.db ? initApp() : setTimeout(start, 50);
      if (window.db) initApp();
      else window.addEventListener('supabase:ready', start);
    }
  });
})();
