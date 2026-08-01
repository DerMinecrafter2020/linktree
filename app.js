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
  // Navidrome-Config kommt komplett aus window.NAVIDROME_CONFIG (von
  // config.js oder vom Admin-Panel in den Speicher geschrieben).
  // KEIN localStorage mehr. Bei Seiten-Reload muss der User ggf.
  // die Werte im Admin-Panel neu setzen.

  function mergeNavidromeConfig() {
    const base = window.NAVIDROME_CONFIG || {};
    // window.NAVIDROME_CONFIG hat bereits enabled/proxyUrl/pollIntervalSec
    // (entweder aus config.js oder vom Admin gesetzt).
    return Object.assign({}, base, {
      enabled: typeof base.enabled === 'boolean' ? base.enabled : true,
      proxyUrl: base.proxyUrl || '',
      pollIntervalSec: base.pollIntervalSec || 30,
    });
  }

  const np = {
    cfg: null,
    pollTimer: null,
    currentTrack: null,    // letzter Track-Stand vom Server

    init() {
      this.cfg = mergeNavidromeConfig();
      window.NAVIDROME_CONFIG = this.cfg;
    },

    isEnabled() {
      const c = this.cfg;
      if (!c) return false;
      // proxyUrl reicht — wenn gesetzt, versuchen wir zu connecten
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
      // Server-Polling: alle 5s fuer schnelle Track-Stop-Erkennung
      this.pollTimer = setInterval(() => this.tick(), 5000);
    },

    stop() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
    },

    async tick() {
      try {
        const newTrack = await window.NavidromeAPI.nowPlaying();
        // Binäre Logik: Server sagt playing=true (und nicht paused) -> Track anzeigen,
        // sonst Player ausblenden.
        if (!newTrack || newTrack.playing !== true || newTrack.paused === true) {
          this.currentTrack = null;
          this.renderIdle();
          return;
        }
        // Aktualisiere currentTrack mit dem neuen Server-Wert
        // (Titel/Artist/Album/Cover/Duration koennen sich auch aendern,
        // z. B. bei Tag-Korrektur)
        this.currentTrack = newTrack;
        this.renderTrack(this.currentTrack);
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
      wrap.classList.remove('playing', 'paused');
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
    },

    async control(action) {
      if (!this.isEnabled()) return;
      await window.NavidromeAPI.control(action);
    },
  };

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
    np.start();
  }
})();
