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
  // Persistenz der letzten bekannten Track-Position, damit beim Reload
  // die Sekunden weiterlaufen (Navidrome liefert oft position=0 wenn
  // gerade erst gestartet, obwohl wir schon 30s hoeren).
  const NP_POS_STORAGE_KEY = 'openweb-navidrome-pos';

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

  // Liest die zuletzt bekannte Track-Position aus dem localStorage.
  // Format: { title, artist, album, duration, position, savedAt }
  function loadLastPosition() {
    try {
      const raw = localStorage.getItem(NP_POS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.title) return null;
      return parsed;
    } catch (_) { return null; }
  }

  function saveLastPosition(track) {
    if (!track) return;
    try {
      localStorage.setItem(NP_POS_STORAGE_KEY, JSON.stringify({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        duration: track.duration || 0,
        position: track.position || 0,
        savedAt: Date.now(),
      }));
    } catch (_) { /* ignore quota errors */ }
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
      // Sofort die letzte bekannte Position anzeigen (sonst springt die
      // Bar beim Reload auf 0 zurueck, bis der erste Server-Tick kommt).
      this.bootstrapFromLocalStorage();
      await this.tick();
      // Server-Polling: alle 5s fuer schnelle Track-Stop-Erkennung
      // (unabhaengig vom konfigurierten Intervall)
      this.pollTimer = setInterval(() => this.tick(), 5000);
      // Lokales Progress-Polling: jede Sekunde, fuer die Bar-Animation
      this.progressTimer = setInterval(() => {
        this.updateProgress();
        this.checkTrackStale();
      }, 1000);
    },

    // Prueft, ob der Track stale ist (Position bewegt sich nicht mehr)
    // -> vermutlich pausiert oder gestoppt
    checkTrackStale() {
      if (!this.currentTrack) return;
      const now = Date.now();
      const elapsedSinceServer = (now - this.progressStartedAt) / 1000;
      const localPos = this.initialPosition + elapsedSinceServer;
      // Wenn die letzte Server-Position sehr jung war (< 5s) und wir
      // lokal schon am Ende sind, nichts tun (Song koennte gerade enden).
      const duration = Number(this.currentTrack.duration || 0);
      if (duration > 0 && localPos > duration + 2) {
        // Wir sind ueber das Ende hinaus -> Song fertig
        console.log('[navidrome] track ended');
        this.currentTrack = null;
        localStorage.removeItem(NP_POS_STORAGE_KEY);
        this.renderIdle();
      }
    },

    // Beim Reload: sofort die letzte bekannte Track-Position anzeigen,
    // damit der Balken nicht von 0 startet.
    bootstrapFromLocalStorage() {
      const last = loadLastPosition();
      if (!last) return;
      // Wenn die gespeicherte Position aelter als 10 Minuten ist,
      // ist sie wahrscheinlich zu alt — wir zeigen sie trotzdem an,
      // aber beim ersten Server-Tick wird sie ueberschrieben.
      const minutesAgo = (Date.now() - (last.savedAt || 0)) / 60000;
      const estimatedPos = (last.position || 0) + minutesAgo;
      this.currentTrack = {
        title:    last.title,
        artist:   last.artist,
        album:    last.album,
        duration: last.duration || 0,
        position: estimatedPos,
      };
      this.progressStartedAt = Date.now();
      this.initialPosition = estimatedPos;
      this.renderTrack(this.currentTrack);
      this.updateProgress();
    },

    stop() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.pollTimer = null;
      this.progressTimer = null;
    },

    // Aktualisiert nur den Progress-Balken lokal, ohne Server-Call.
    // Interpoliert zwischen Server-Tick und jetzt.
    // Im Pause-Modus wird die Position eingefroren.
    updateProgress() {
      if (!this.currentTrack) return;
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      // Im Pause-Modus: nichts machen, Position ist eingefroren
      if (wrap.classList.contains('paused')) return;
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

    // Prueft, ob der Track stale ist (lange keine Position-Aenderung)
    // -> vermutlich pausiert oder gestoppt. Da das Server-Polling nur alle
    // 5s tickt, warten wir bis 30s ohne Server-Aenderung.
    checkTrackStale() {
      if (!this.currentTrack) return;
      const now = Date.now();
      const sinceLastServer = (now - this.progressStartedAt) / 1000;
      // Wenn wir 35s nichts vom Server gehoert haben UND wir die letzten 15s
      // die gleiche Position haben (innerhalb 2s Toleranz), dann ist der
      // Track wahrscheinlich gestoppt oder pausiert.
      if (sinceLastServer > 35) {
        const localPos = this.initialPosition + sinceLastServer;
        const staleTime = (now - this.progressStartedAt) / 1000;
        // Wenn die Position sich nicht signifikant weiterbewegt, Idle annehmen.
        // Wir nutzen: wenn Position nach 35s Server-Stille unter Duration ist
        // UND die letzte bekannte Server-Position + 35s nicht ueber Duration,
        // ist es wahrscheinlich gestoppt (kein Player mehr aktiv).
        // Aber: Navidrome gibt in getNowPlaying NUR aktive Player zurueck.
        // Wenn unser Eintrag dort wegfaellt, kommt naechster Server-Tick mit
        // playing=false. Wir verlassen uns also auf das 5s-Server-Polling.
        // Hier nur: wenn die lokale Schaetzung das Track-Ende ueberschritten
        // hat, wechsel auf Idle.
        const duration = Number(this.currentTrack.duration || 0);
        if (duration > 0 && localPos >= duration) {
          console.log('[navidrome] track ended (local estimate past duration)');
          this.currentTrack = null;
          localStorage.removeItem(NP_POS_STORAGE_KEY);
          this.renderIdle();
        }
      }
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
          // Server meldet: kein aktiver Player (kann Pause ODER Stop sein).
          // Wir behalten den letzten Track sichtbar — mit Pause-Indikator.
          // Erst nach 5 Minuten ohne Server-Update zeigen wir wirklich Idle.
          if (this.currentTrack) {
            const sinceLastServer = (Date.now() - this.progressStartedAt) / 1000;
            if (sinceLastServer > 300) {  // 5 Minuten
              this.currentTrack = null;
              localStorage.removeItem(NP_POS_STORAGE_KEY);
              this.renderIdle();
            } else {
              // Track bleibt sichtbar, aber wir markieren ihn als pausiert
              this.currentTrack = Object.assign({}, this.currentTrack, { paused: true });
              this.renderPaused();
            }
          } else {
            this.renderIdle();
          }
          return;
        }
        // Track laeuft (playing=true) -> weiter
        // Wenn der gleiche Track noch laeuft, nur die Zeit-Basis neu setzen,
        // wenn die Server-Position groesser ist als unsere bisher berechnete.
        // Sonst waere ein Ruecksprung sichtbar (z. B. wenn Server langsamer tickt).
        const newTrack = json.data;
        let newServerPos = Number(newTrack.position || 0);

        // Fallback: Wenn Server-Position 0 ist (Navidrome liefert das oft direkt
        // nach Track-Start), pruefen wir localStorage auf eine reale Position.
        // Wir nutzen sie nur, wenn der Titel uebereinstimmt und die Position
        // juenger als 2 Minuten ist (sonst ist es ein anderer Durchlauf).
        if (newServerPos <= 1) {
          const last = loadLastPosition();
          if (last
              && last.title === newTrack.title
              && last.album === newTrack.album
              && last.position > 1
              && (Date.now() - (last.savedAt || 0)) < 2 * 60 * 1000) {
            // Geschätzte Position: last.position + verstrichene Zeit seit save
            const minutesAgo = (Date.now() - last.savedAt) / 1000;
            const estimated = last.position + minutesAgo;
            if (estimated < Number(newTrack.duration || 9999)) {
              newServerPos = estimated;
            }
          }
        }

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
        // Position fuer Reload-Fallback speichern (nur wenn > 1)
        if (this.currentTrack.position > 1) {
          saveLastPosition(this.currentTrack);
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
      // Zeit zuruecksetzen
      const bar = wrap.querySelector('.np-progress-bar');
      if (bar) bar.style.width = '0%';
      const timePos = wrap.querySelector('.np-time-pos');
      const timeDur = wrap.querySelector('.np-time-dur');
      if (timePos) timePos.textContent = '0:00';
      if (timeDur) timeDur.textContent = '0:00';
    },

    // Zeigt den letzten Track weiter, aber mit Pause-Indikator
    renderPaused() {
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      if (!this.currentTrack) {
        this.renderIdle();
        return;
      }
      wrap.classList.remove('idle');
      wrap.classList.remove('playing');
      wrap.classList.add('paused');
      // Position EINFRIEREN: setze progressStartedAt so, dass die interpolierte
      // Position exakt gleich der aktuellen Position ist.
      const dur = Number(this.currentTrack.duration || 0);
      const pos = Math.min(dur, Number(this.currentTrack.position || 0));
      this.progressStartedAt = Date.now();
      this.initialPosition = pos;
      const bar = wrap.querySelector('.np-progress-bar');
      if (bar && dur > 0) {
        bar.style.width = ((pos / dur) * 100).toFixed(2) + '%';
      }
      const timePos = wrap.querySelector('.np-time-pos');
      if (timePos) timePos.textContent = formatTime(pos);
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
