// =========================================================
// OpenWeb Hauptseite
// =========================================================

(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setText(sel, text, root = document) {
    const el = $(sel, root);
    if (!el) return null;
    el.classList.remove('marquee-content', 'marquee-scroll');
    el.style.removeProperty('--marquee-offset');
    el.innerHTML = `<span class="marquee-inner">${escapeHtml(String(text ?? ''))}</span>`;
    const inner = el.querySelector('.marquee-inner');
    if (inner && inner.scrollWidth > el.clientWidth + 2) {
      const offset = -(inner.scrollWidth - el.clientWidth);
      inner.classList.add('marquee-content');
      inner.style.setProperty('--marquee-offset', offset + 'px');
      requestAnimationFrame(() => inner.classList.add('marquee-scroll'));
    }
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

  function createIconImg(src, alt = '', cls = 'link-icon-img') {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.className = cls;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      console.warn('[img] failed to load:', src.slice(0, 120));
      img.replaceWith(document.createTextNode('🔗'));
    };
    return img;
  }

  function sanitizeIconText(icon) {
    return icon.toString().slice(0, 8).replace(/[<>"']/g, '');
  }

  function renderIcon(icon) {
    if (!icon) return '🔗';

    if (icon.startsWith('simpleicon:') && window.icons) {
      const id = icon.slice('simpleicon:'.length);
      if (!/^[a-z0-9-]{1,32}$/.test(id) || !window.icons.getInfo(id)) return '🔗';
      return createIconImg(window.icons.url(id));
    }

    if (icon.startsWith('dashboardicon:') && window.icons) {
      const parsed = window.icons.parse(icon);
      if (!parsed.url) return '🔗';
      return createIconImg(parsed.url);
    }

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
    // document.title wird vom Navidrome-Player überschrieben, sobald ein Track läuft
  }

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
      window.api.getProfile(),
      window.api.getLinks(),
    ]);
    renderProfile(profile);
    renderLinks(links);
  }

  // Navidrome Player
  const np = {
    pollTimer: null,
    progressTimer: null,
    currentTrack: null,
    localPosition: 0,
    lastTickAt: 0,
    defaultFavicon: '/favicon.svg',

    start() {
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      this.tick();
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.tick(), 30_000);
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.progressTimer = setInterval(() => this.updateProgress(), 1000);
    },

    stop() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.progressTimer = null;
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
        const newId = this.trackId(newTrack);
        const sameTrack = previousId && previousId === newId;
        // Server-Zeit übernehmen, damit Pausieren/Stoppen synchron bleibt
        this.localPosition = newTrack.position || 0;
        this.lastTickAt = performance.now();
        this.currentTrack = newTrack;
        this.renderTrack(this.currentTrack, newTrack.paused === true ? 'paused' : 'playing');
        if (previousId && !sameTrack) {
          console.log('[navidrome] neuer Track erkannt, aktualisiere Anzeige');
        }
      } catch (err) {
        console.warn('[navidrome] poll failed:', err.message);
        this.currentTrack = null;
        this.renderIdle();
      }
    },

    updateProgress() {
      if (!this.currentTrack) return;
      const now = performance.now();
      if (!this.currentTrack.paused) {
        this.localPosition += (now - this.lastTickAt) / 1000;
      }
      this.lastTickAt = now;
      const duration = this.currentTrack.duration || 0;
      if (duration > 0) this.localPosition = Math.min(this.localPosition, duration);
      this.renderExtra(this.currentTrack, this.localPosition);
    },

    trackId(t) {
      return [t.title, t.artist, t.album].filter(Boolean).join('::');
    },

    setState(state) {
      const wrap = $('#navidrome-player');
      if (!wrap) return;
      wrap.classList.remove('idle', 'playing', 'paused');
      wrap.classList.add(state);
      // Touch-Geräte: Klick auf Player toggelt Extra-Anzeige
      if (!wrap._npClickBound) {
        wrap.addEventListener('click', () => wrap.classList.toggle('expanded'));
        wrap._npClickBound = true;
      }
    },

    formatDuration(seconds) {
      const s = parseInt(seconds || 0, 10);
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${m}:${String(r).padStart(2, '0')}`;
    },

    renderExtra(data, position) {
      const wrap = $('#navidrome-player');
      const extraEl = wrap?.querySelector('.np-extra');
      if (!extraEl) return;
      const bitrateHtml = data.bitrate ? `<div class="np-bitrate">${escapeHtml(`${data.bitrate} kbps`)}</div>` : '';
      const timeHtml = data.duration
        ? `<div class="np-time">${escapeHtml(`${this.formatDuration(position)} / ${this.formatDuration(data.duration)}`)}</div>`
        : '';
      extraEl.innerHTML = bitrateHtml + timeHtml;
      extraEl.hidden = !data.bitrate && !data.duration;
    },

    renderIdle() {
      this.setState('idle');
      const wrap = $('#navidrome-player');
      if (wrap) {
        wrap.hidden = false;
      }
      setText('.np-title', 'Momentan laeuft nichts', wrap);
      setText('.np-artist', 'Starte Musik in Navidrome, dann erscheint sie hier', wrap);
      const albumEl = wrap?.querySelector('.np-album');
      if (albumEl) { albumEl.textContent = ''; albumEl.hidden = true; }
      const extraEl = wrap?.querySelector('.np-extra');
      if (extraEl) { extraEl.innerHTML = ''; extraEl.hidden = true; }
      const cover = wrap?.querySelector('.np-cover');
      if (cover) {
        cover.replaceChildren(document.createTextNode('🎵'));
        cover.classList.add('placeholder');
      }
      document.title = 'OpenWeb · Links';
      this.updateFavicon(null);
    },

    updateFavicon(coverUrl) {
      let link = document.querySelector('link[rel~="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = coverUrl || this.defaultFavicon;
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
          cover.appendChild(createIconImg(data.coverUrl, data.title || '', 'np-cover-img'));
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
      this.updateFavicon(data.coverUrl);
      const albumEl = wrap?.querySelector('.np-album');
      if (albumEl) {
        albumEl.textContent = data.album || '';
        albumEl.hidden = !data.album;
      }
      this.renderExtra(data, data.position || 0);
      document.title = data.artist ? `${data.artist} — ${data.title}` : data.title;
      if (state === 'paused') document.title += ' (pausiert)';
    },

  };

  function init() {
    render();
    np.start();
  }

  const yearEl = $('.year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
