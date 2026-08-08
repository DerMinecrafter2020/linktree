// =========================================================
// Hauptseite – lädt Profil & Links dynamisch aus Supabase
// =========================================================

(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);

  // ---------- Utilities ----------
  function setText(sel, text, root = document) {
    const el = $(sel, root);
    if (el) el.textContent = String(text ?? '');
    return el;
  }

  function prettyUrl(url) {
    if (!url) return '';
    return String(url)
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');
  }

  function safeUrl(raw) {
    const u = String(raw || '').trim();
    if (!u) return '#';
    if (/^(javascript|data|vbscript|file|about):/i.test(u)) return '#';
    if (/^mailto:/i.test(u)) return u;
    try {
      const url = new URL(u);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '#';
    } catch { return '#'; }
  }

  function createIconImg(src, alt = '') {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.className = 'link-icon-img';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.replaceWith(document.createTextNode('🔗'));
    return img;
  }

  function sanitizeIconText(icon) {
    return icon.toString().slice(0, 8).replace(/[<>"']/g, '');
  }

  function renderIcon(icon) {
    if (!icon) return '🔗';

    // simpleicon:instagram
    if (icon.startsWith('simpleicon:') && window.icons) {
      const id = icon.slice('simpleicon:'.length);
      if (!/^[a-z0-9-]{1,32}$/.test(id) || !window.icons.getInfo(id)) return '🔗';
      return createIconImg(window.icons.url(id));
    }

    // Externe Bild-URL
    if (/^https?:\/\//i.test(icon)) {
      try {
        const u = new URL(icon);
        if (!['http:', 'https:'].includes(u.protocol)) return '🔗';
      } catch { return '🔗'; }
      return createIconImg(icon);
    }

    return document.createTextNode(sanitizeIconText(icon));
  }

  function autoIcon(link) {
    if (link.icon && link.icon !== '🔗') return link.icon;
    if (!window.icons) return '🔗';
    const detected = window.icons.detectFromUrl(link.url, link.title);
    return detected ? `simpleicon:${detected}` : '🔗';
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  // ---------- Profil ----------
  function renderProfile(profile) {
    if (!profile) return;

    const avatarEl = $('.avatar');
    if (avatarEl) {
      const av = profile.avatar_url;
      const safeImg = av && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(av);
      if (safeImg) {
        avatarEl.replaceChildren(createIconImg(av));
        avatarEl.classList.add('has-image');
      } else {
        avatarEl.replaceChildren(document.createTextNode(
          (profile.avatar || 'CA').slice(0, 2).toUpperCase()
        ));
      }
    }

    setText('.name', profile.name);
    setText('.handle', profile.handle);
    setText('.bio', profile.bio);
    document.title = `${profile.handle || 'Links'} · Links`;
  }

  // ---------- Links ----------
  function buildLinkRow(link) {
    const href = safeUrl(link.url);
    const a = el('a', 'link');
    a.href = href;
    if (link.open_new !== false && href !== '#') {
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
    }
    a.dataset.url = prettyUrl(link.url);

    const top = el('span', 'link-top');
    const text = el('span', 'link-text');

    const badge = el('span', 'link-icon');
    const iconEl = renderIcon(autoIcon(link));
    if (iconEl instanceof Node) badge.appendChild(iconEl);
    else badge.textContent = String(iconEl || '🔗');

    const main = el('span', 'link-text-main');
    main.appendChild(el('span', 'link-title', link.title));
    main.appendChild(el('span', 'link-sub', link.subtitle));

    const arrow = el('span', 'link-arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');

    text.appendChild(badge);
    text.appendChild(main);
    text.appendChild(arrow);

    const urlEl = el('span', 'link-url', prettyUrl(link.url));
    urlEl.setAttribute('aria-hidden', 'true');

    top.appendChild(text);
    a.appendChild(top);
    a.appendChild(urlEl);
    return a;
  }

  function renderLinks(links) {
    const nav = $('.links');
    if (!nav) return;
    nav.replaceChildren();

    const active = links.filter((l) => l.is_active !== false);
    if (active.length === 0) {
      nav.appendChild(el('p', 'empty-state', 'Noch keine Links vorhanden.'));
      return;
    }

    for (const link of active) {
      nav.appendChild(buildLinkRow(link));
    }
  }

  async function render() {
    const [profile, links] = await Promise.all([
      window.db.getProfile(),
      window.db.listLinks(),
    ]);
    renderProfile(profile);
    renderLinks(links);
  }

  // ---------- Navidrome Player ----------
  function mergeNavidromeConfig() {
    const base = window.NAVIDROME_CONFIG || {};
    return Object.assign({}, base, {
      enabled: typeof base.enabled === 'boolean' ? base.enabled : true,
      proxyUrl: base.proxyUrl || '',
      pollIntervalSec: Math.max(5, parseInt(base.pollIntervalSec, 10) || 30),
    });
  }

  const np = {
    cfg: null,
    pollTimer: null,
    currentTrack: null,

    init() {
      this.cfg = mergeNavidromeConfig();
      window.NAVIDROME_CONFIG = this.cfg;
    },

    isEnabled() {
      const c = this.cfg;
      if (!c || c.enabled === false) return false;
      if (!c.proxyUrl || c.proxyUrl.includes('YOUR-PROJECT')) return false;
      return true;
    },

    async start() {
      if (!this.isEnabled()) return;
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      await this.tick();
      this.pollTimer = setInterval(() => this.tick(), this.cfg.pollIntervalSec * 1000);
    },

    stop() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
    },

    async tick() {
      try {
        const newTrack = await window.NavidromeAPI.nowPlaying();
        if (!newTrack || newTrack.playing !== true) {
          this.currentTrack = null;
          this.renderIdle();
          return;
        }
        const previousId = this.currentTrack ? this.trackId(this.currentTrack) : null;
        this.currentTrack = newTrack;
        this.renderTrack(this.currentTrack, newTrack.paused === true ? 'paused' : 'playing');
        if (previousId !== this.trackId(newTrack) && newTrack.paused !== true) {
          this.notifyDiscord(this.currentTrack).catch(err => {
            console.warn('[discord webhook] notify failed:', err.message);
          });
        }
      } catch (err) {
        console.warn('[navidrome] poll failed:', err.message);
        this.currentTrack = null;
        this.renderIdle();
      }
    },

    trackId(t) {
      return [t.title, t.artist, t.album].filter(Boolean).join('::');
    },

    async notifyDiscord(track) {
      if (!window.DiscordAPI?.send && !window.db?.sendDiscordWebhook) return;
      const payload = {
        title: track.title || 'Unbekannt',
        artist: track.artist || '',
        album: track.album || '',
        cover: track.coverUrl || '',
        url: track.url || ''
      };
      if (window.DiscordAPI?.send) {
        await window.DiscordAPI.send(payload);
      } else {
        await window.db.sendDiscordWebhook(payload);
      }
    },

    setState(state) {
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      wrap.classList.remove('idle', 'playing', 'paused');
      wrap.classList.add(state);
    },

    renderIdle() {
      this.setState('idle');
      const wrap = $('#navidrome-player');
      if (wrap) wrap.hidden = true;
      setText('.np-title', 'Momentan läuft nichts', wrap);
      setText('.np-artist', 'Starte Musik in Navidrome, dann erscheint sie hier', wrap);
      const cover = wrap?.querySelector('.np-cover');
      if (cover) {
        cover.replaceChildren(document.createTextNode('🎵'));
        cover.classList.add('placeholder');
      }
    },

    renderTrack(data, state = 'playing') {
      this.setState(state);
      const wrap = $('#navidrome-player');
      if (wrap) wrap.hidden = false;
      const cover = wrap?.querySelector('.np-cover');
      if (cover) {
        cover.replaceChildren();
        cover.classList.remove('placeholder');
        if (data.coverUrl) {
          cover.appendChild(createIconImg(data.coverUrl, data.title || ''));
        } else {
          cover.appendChild(document.createTextNode('🎵'));
          cover.classList.add('placeholder');
        }
      }

      let artist = data.artist || data.album || '';
      if (state === 'paused' && artist) artist += ' (pausiert)';
      else if (state === 'paused') artist = 'Pausiert';
      setText('.np-title', data.title || 'Unbekannt', wrap);
      setText('.np-artist', artist, wrap);
    },

    async control(action) {
      if (!this.isEnabled()) return;
      await window.NavidromeAPI.control(action);
    },
  };

  // ---------- Init ----------
  function init() {
    if (!window.db) return;
    render();
    if (window.db.subscribe) {
      window.db.subscribe((changed) => {
        console.log('[realtime] reload due to', changed);
        render();
      });
    }
    np.init();
    np.start();
  }

  // Footer Jahr
  const yearEl = $('.year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // Warten, bis Supabase geladen ist
  if (window.sb !== undefined || window.db) {
    if (window.sb === null || window.db?.isMock) {
      init();
    } else {
      window.addEventListener('supabase:ready', init);
      setTimeout(() => {
        if (window.db && !window.__init_done) {
          window.__init_done = true;
          init();
        }
      }, 1000);
    }
  } else {
    window.addEventListener('supabase:ready', init);
  }
})();
