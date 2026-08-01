// =========================================================
// Hauptseite – lädt Profil & Links dynamisch aus Supabase
// =========================================================

(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);

  // Aktuelles Jahr im Footer
  const yearEl = $('.year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // Hilfsfunktion: URL "hübsch" kürzen (kein https://www.)
  function prettyUrl(url) {
    if (!url) return '';
    return url
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');
  }

  // Hilfsfunktion: Icon rendern (Emoji, simpleicon:ID oder https-Link zu Bild)
  // Sicher: erzeugt DOM-Elemente, keine innerHTML-Interpolation mehr
  // (damit ist XSS via URL-Injection unmöglich).
  function renderIcon(icon) {
    if (!icon) return '🔗';

    // simpleicon:instagram → Icon aus Library
    if (icon.startsWith('simpleicon:') && window.icons) {
      const id = icon.slice('simpleicon:'.length);
      // Nur a-z, 0-9, -
      if (!/^[a-z0-9-]{1,32}$/.test(id)) return '🔗';
      // Wenn die ID nicht in der Library ist, lieber Emoji 🔗 anzeigen statt 404
      if (!window.icons.getInfo(id)) return '🔗';
      const img = document.createElement('img');
      img.src = window.icons.url(id);
      img.alt = '';
      img.className = 'link-icon-img';
      img.loading = 'lazy';
      img.onerror = () => { img.replaceWith(document.createTextNode('🔗')); };
      return img;
    }

    // Externe Bild-URL: nur http/https, KEIN javascript:/data:/vbscript:
    if (/^https?:\/\//i.test(icon)) {
      try {
        const u = new URL(icon);
        if (!['http:', 'https:'].includes(u.protocol)) return '🔗';
      } catch { return '🔗'; }
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      img.className = 'link-icon-img';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.replaceWith(document.createTextNode('🔗')); };
      return img;
    }

    // Plain Emoji (oder safe text) — strip alles Böse raus
    return document.createTextNode(icon.toString().slice(0, 8).replace(/[<>"']/g, ''));
  }

  // Auto-Erkennung: Wenn ein Link kein Icon hat, anhand der URL raten
  function autoIcon(link) {
    if (link.icon && link.icon !== '🔗') return link.icon;
    if (!window.icons) return '🔗';
    const detected = window.icons.detectFromUrl(link.url, link.title);
    return detected ? `simpleicon:${detected}` : '🔗';
  }

  async function render() {
    const profile = await window.db.getProfile();
    const links   = await window.db.listLinks();

    // Theme aus DB anwenden (Whitelist geprüft, sonst Default 'neon')
    if (window.THEMES) {
      const id = window.THEMES.isValid(profile?.theme) ? profile.theme : 'neon';
      window.THEMES.apply(id);
    }

    // Profil
    if (profile) {
      const avatarEl = $('.avatar');
      if (avatarEl) {
        // Whitelist: nur Bild-DataURLs von sicheren Formaten (kein SVG)
        const av = profile.avatar_url;
        const safeImg = av && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(av);
        if (safeImg) {
          avatarEl.replaceChildren();
          const img = document.createElement('img');
          img.src = av;
          img.alt = '';
          avatarEl.appendChild(img);
          avatarEl.classList.add('has-image');
        } else {
          avatarEl.replaceChildren(document.createTextNode(
            (profile.avatar || 'CA').slice(0, 2).toUpperCase()
          ));
        }
      }
      const nameEl = $('.name');
      if (nameEl) nameEl.textContent = profile.name || '';
      const handleEl = $('.handle');
      if (handleEl) handleEl.textContent = profile.handle || '';
      const bioEl = $('.bio');
      if (bioEl) bioEl.textContent = profile.bio || '';

      // Tab-Titel
      document.title = `${profile.handle || 'Links'} · Links`;
    }

    // Links
    const nav = $('.links');
    if (nav) {
      nav.innerHTML = '';
      const active = links.filter((l) => l.is_active !== false);
      if (active.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'Noch keine Links vorhanden.';
        nav.appendChild(empty);
        return;
      }
      for (const link of active) {
        const a = document.createElement('a');
        a.className = 'link';

        // URL-Validierung: nur http(s) oder mailto, NIE javascript:/data:/vbscript:
        const href = (() => {
          const u = String(link.url || '').trim();
          if (!u) return '#';
          if (/^(javascript|data|vbscript|file|about):/i.test(u)) return '#';
          if (/^mailto:/i.test(u)) return u;
          try {
            const url = new URL(u);
            if (!['http:', 'https:'].includes(url.protocol)) return '#';
            return url.toString();
          } catch { return '#'; }
        })();

        a.href = href;
        if (link.open_new !== false && href !== '#') {
          a.target = '_blank';
          a.rel = 'noopener noreferrer nofollow';
        }
        a.dataset.url = prettyUrl(link.url);
        a.innerHTML = `
          <span class="link-top">
            <span class="link-text">
              <span class="link-title">${escapeHtml(link.title)}</span>
              <span class="link-sub">${escapeHtml(link.subtitle || '')}</span>
            </span>
            <span class="link-arrow" aria-hidden="true">→</span>
          </span>
          <span class="link-url" aria-hidden="true">${escapeHtml(prettyUrl(link.url))}</span>
        `;
        // Icon als Badge vorne (mit Auto-Erkennung falls leer)
        // renderIcon() gibt jetzt ein DOM-Element (oder Text) zurück, kein HTML-String mehr.
        const iconValue = autoIcon(link);
        const badge = document.createElement('span');
        badge.className = 'link-icon';
        const iconEl = renderIcon(iconValue);
        if (iconEl instanceof Node) badge.appendChild(iconEl);
        else badge.textContent = String(iconEl || '🔗');
        a.querySelector('.link-text').prepend(badge);
        nav.appendChild(a);
      }
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // =========================================================
  // NAVIDROME PLAYER (optional)
  // =========================================================
  // Pollt alle 30s den Navidrome-Proxy und zeigt aktuellen Track.
  // Bei Fehler/kein Server: Player-Container wird ausgeblendet.
  //
  // Konfigurations-Reihenfolge (spaeter gewinnt):
  //   1. config.js (NAVIDROME_CONFIG)        — Defaults / Platzhalter
  //   2. localStorage 'openweb-navidrome-config' — vom Admin gespeichert
  const NP_STORAGE_KEY = 'openweb-navidrome-config';

  function loadNavidromeFromStorage() {
    try {
      const raw = localStorage.getItem(NP_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return {
        enabled: !!parsed.enabled,
        proxyUrl: typeof parsed.proxyUrl === 'string' ? parsed.proxyUrl : '',
        pollIntervalSec: Math.min(600, Math.max(10, parseInt(parsed.pollIntervalSec || 30, 10) || 30)),
      };
    } catch (_) { return null; }
  }

  function mergeNavidromeConfig() {
    const base = window.NAVIDROME_CONFIG || {};
    const stored = loadNavidromeFromStorage();
    if (!stored) return base;
    // localStorage ueberschreibt Defaults; URL/User/Pass kommen NIE in den Browser
    return Object.assign({}, base, {
      enabled: stored.enabled || base.enabled,
      proxyUrl: stored.proxyUrl || base.proxyUrl,
      pollIntervalSec: stored.pollIntervalSec || base.pollIntervalSec || 30,
    });
  }

  const np = {
    cfg: null,
    pollTimer: null,
    progressTimer: null,
    currentTrack: null,    // letzter Track-Stand vom Server
    progressStartedAt: 0, // Date.now() als Basis fuer lokale Interpolation
    initialPosition: 0,   // Position vom Server beim letzten Tick

    init() {
      this.cfg = mergeNavidromeConfig();
      window.NAVIDROME_CONFIG = this.cfg;
    },

    isEnabled() {
      const c = this.cfg;
      if (!c) return false;
      if (!c.enabled) return false;
      if (!c.proxyUrl) return false;
      // Platzhalter rausfiltern
      if ((c.proxyUrl || '').includes('YOUR-PROJECT')) return false;
      return true;
    },

    async start() {
      if (!this.isEnabled()) return;
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      wrap.hidden = false;
      await this.tick();
      // Server-Polling: langsamer (Standard 30s)
      const pollInterval = Math.max(10, this.cfg.pollIntervalSec || 30) * 1000;
      this.pollTimer = setInterval(() => this.tick(), pollInterval);
      // Lokales Progress-Polling: jede Sekunde, fuer die Bar-Animation
      this.progressTimer = setInterval(() => this.updateProgress(), 1000);
    },

    stop() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.pollTimer = null;
      this.progressTimer = null;
    },

    // Aktualisiert nur den Progress-Balken lokal, ohne Server-Call.
    // Interpoliert zwischen Server-Tick und jetzt.
    updateProgress() {
      if (!this.currentTrack) return;
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      const bar = wrap.querySelector('.np-progress-bar');
      if (!bar) return;

      const duration = Number(this.currentTrack.duration || 0);
      let position;
      if (duration <= 0) {
        position = 0;
        bar.style.width = '0%';
      } else {
        const elapsedSinceServer = (Date.now() - this.progressStartedAt) / 1000;
        position = this.initialPosition + elapsedSinceServer;
        const pct = Math.min(100, (position / duration) * 100);
        bar.style.width = pct.toFixed(2) + '%';
      }

      // Zeitanzeige unter der Progress-Bar aktualisieren
      const timePos = wrap.querySelector('.np-time-pos');
      if (timePos) timePos.textContent = formatTime(position);
    },

    async tick() {
      try {
        const r = await fetch(this.cfg.proxyUrl, {
          method: 'POST',
          headers: this._authHeaders(),
          body: JSON.stringify({ action: 'nowPlaying' }),
        });
        const json = await r.json();
        if (!r.ok || !json.ok || !json.data?.playing) {
          this.currentTrack = null;
          this.renderIdle();
          return;
        }
        // Wenn der gleiche Track noch laeuft, nur die Zeit-Basis neu setzen,
        // wenn die Server-Position groesser ist als unsere bisher berechnete.
        // Sonst waere ein Ruecksprung sichtbar (z. B. wenn Server langsamer tickt).
        const newTrack = json.data;
        const newServerPos = Number(newTrack.position || 0);
        const isNewTrack = !this.currentTrack
          || this.currentTrack.title !== newTrack.title
          || this.currentTrack.album !== newTrack.album;

        if (isNewTrack) {
          // Neuer Track: Zeit-Basis neu setzen
          this.currentTrack = newTrack;
          this.progressStartedAt = Date.now();
          this.initialPosition = newServerPos;
        } else {
          // Gleicher Track: vergleiche mit unserer lokalen Schaetzung
          const elapsedSinceLast = (Date.now() - this.progressStartedAt) / 1000;
          const localPos = this.initialPosition + elapsedSinceLast;
          // Server-Position darf nicht vor unserer lokalen Schaetzung liegen,
          // sonst wuerde der Balken zurueckspringen.
          if (newServerPos >= localPos - 2) {  // 2s Toleranz fuer Netzwerk-Jitter
            this.currentTrack = newTrack;
            this.progressStartedAt = Date.now();
            this.initialPosition = newServerPos;
          } else {
            // Server-Position liegt hinter unserer Schaetzung -> nur Track-Metadaten
            // aktualisieren (Cover, Titel), aber Zeit-Basis beibehalten
            this.currentTrack = Object.assign({}, this.currentTrack, {
              title: newTrack.title,
              artist: newTrack.artist,
              album: newTrack.album,
              coverUrl: newTrack.coverUrl,
              duration: newTrack.duration,
            });
          }
        }
        this.renderTrack(this.currentTrack);
        this.updateProgress(); // sofort nach Server-Update synchronisieren
      } catch (err) {
        console.warn('[navidrome] poll failed:', err.message);
        this.currentTrack = null;
        this.renderIdle();
      }
    },

    renderIdle() {
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      wrap.classList.add('idle');
      wrap.classList.remove('playing');
      const titleEl = wrap.querySelector('.np-title');
      const artistEl = wrap.querySelector('.np-artist');
      if (titleEl) titleEl.textContent = 'Momentan läuft nichts';
      if (artistEl) artistEl.textContent = 'Starte Musik in Navidrome, dann erscheint sie hier';
      const cover = wrap.querySelector('.np-cover');
      if (cover) {
        cover.replaceChildren(document.createTextNode('🎵'));
        cover.classList.add('placeholder');
      }
    },

    renderTrack(data) {
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      wrap.classList.remove('idle');
      wrap.classList.add('playing');

      // Cover (Base64-DataURL oder Emoji)
      const cover = wrap.querySelector('.np-cover');
      cover.replaceChildren();
      cover.classList.remove('placeholder');
      if (data.coverUrl) {
        const img = document.createElement('img');
        img.src = data.coverUrl;
        img.alt = data.title || '';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        cover.appendChild(img);
      } else {
        cover.appendChild(document.createTextNode('🎵'));
        cover.classList.add('placeholder');
      }

      const titleEl = wrap.querySelector('.np-title');
      const artistEl = wrap.querySelector('.np-artist');
      if (titleEl) titleEl.textContent = data.title || 'Unbekannt';
      if (artistEl) artistEl.textContent = data.artist || (data.album || '');

      // Zeitanzeige initial setzen (wird dann von updateProgress() jede Sekunde aktualisiert)
      const durNum = Number(data.duration || 0) || 0;
      const posNum = Number(data.position || 0) || 0;
      const timePos = wrap.querySelector('.np-time-pos');
      const timeDur = wrap.querySelector('.np-time-dur');
      if (timePos) timePos.textContent = formatTime(posNum);
      if (timeDur) timeDur.textContent = formatTime(durNum);
    },

    async control(action) {
      if (!this.isEnabled()) return;
      try {
        await fetch(this.cfg.proxyUrl, {
          method: 'POST',
          headers: this._authHeaders(),
          body: JSON.stringify({ action: 'control', controlAction: action }),
        });
      } catch (e) {
        console.warn('[navidrome] control failed', e);
      }
    },

    // Supabase Edge Functions verlangen sowohl 'apikey' als auch
    // 'Authorization: Bearer <key>' — fehlt eins davon: HTTP 401.
    _authHeaders() {
      const key = window.SUPABASE_CONFIG?.anonKey || '';
      return {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': 'Bearer ' + key,
      };
    },
  };

  // Formatiert Sekunden als mm:ss
  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function bindPlayerControls() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-np-action]');
      if (!btn) return;
      const action = btn.dataset.npAction;
      np.control(action);
    });
  }

  function init() {
    if (window.db) {
      render();
      // Realtime: bei Änderungen neu rendern
      if (window.db.subscribe) {
        window.db.subscribe((changed) => {
          console.log('[realtime] reload due to', changed);
          render();
        });
      }
      // Navidrome-Player (falls aktiviert)
      np.init();
      np.start();
      bindPlayerControls();
    }
  }

  // Warten, bis Supabase geladen ist
  if (window.sb !== undefined || window.db) {
    if (window.sb === null || window.db?.isMock) {
      // Mock oder bereits geladen
      init();
    } else {
      window.addEventListener('supabase:ready', init);
      // Fallback: Wenn nach 1s noch nichts da
      setTimeout(() => { if (window.db && !window.__init_done) { window.__init_done = true; init(); } }, 1000);
    }
  } else {
    window.addEventListener('supabase:ready', init);
  }

  // Navidrome-Player sofort initialisieren (unabhängig von Supabase-Ready)
  // damit das UI auch ohne DB-Verbindung den gespeicherten Status zeigt.
  np.init();
  if (np.isEnabled()) {
    bindPlayerControls();
    // Später (sobald Supabase geladen) startet init() das Polling
  }
})();
