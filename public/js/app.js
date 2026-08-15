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
    const newText = String(text ?? '');
    if (el.dataset.lastText === newText) return el;
    el.dataset.lastText = newText;

    el.classList.remove('marquee-content', 'marquee-scroll');
    el.style.removeProperty('--marquee-offset');
    el.innerHTML = `<span class="marquee-inner">${escapeHtml(newText)}</span>`;
    const inner = el.querySelector('.marquee-inner');
    if (inner && inner.scrollWidth > el.clientWidth + 2) {
      const offset = -(inner.scrollWidth - el.clientWidth);
      inner.classList.add('marquee-content');
      inner.style.setProperty('--marquee-offset', offset + 'px');
      requestAnimationFrame(() => inner.classList.add('marquee-scroll'));
    }
    return el;
  }

  function prettyUrl(url, max = 42) {
    if (!url) return '';
    let s = String(url)
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/$/, '');
    if (s.length <= max) return s;
    const head = Math.floor(max * 0.55);
    const tail = max - head - 1;
    return s.slice(0, head) + '…' + s.slice(-tail);
  }

  function safeUrl(raw) {
    const u = String(raw || '').trim();
    if (!u) return '#';
    if (/^(javascript|data|vbscript|file|about):/i.test(u)) return '#';
    if (/^mailto:/i.test(u)) return u;
    let urlStr = u;
    if (!/^https?:\/\//i.test(urlStr)) {
      urlStr = 'https://' + urlStr;
    }
    try {
      const url = new URL(urlStr);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '#';
    } catch { return '#'; }
  }

  function createIconImg(src, alt = '', cls = 'link-icon-img') {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.className = cls;
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
      return createIconImg(parsed.url, '', 'link-icon-img no-filter');
    }

    if (/^https?:\/\//i.test(icon)) {
      try {
        const u = new URL(icon);
        if (!['http:', 'https:'].includes(u.protocol)) return '🔗';
      } catch { return '🔗'; }
      return createIconImg(icon, '', 'link-icon-img no-filter');
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

    // OG-/Twitter-Meta an Profilbeschreibung anpassen
    const metaDesc = profile.bio || 'Alle wichtigen Links auf einen Blick.';
    document.querySelector('meta[name="description"]')?.setAttribute('content', metaDesc);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', metaDesc);
    document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', metaDesc);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', (profile.name || profile.handle || 'Profil') + ' · Links');
    document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', (profile.name || profile.handle || 'Profil') + ' · Links');

    const avatarEl = $('.avatar');
    if (avatarEl) {
      const av = profile.avatar_url;
      const safeImg = av && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(av);
      if (safeImg) {
        avatarEl.replaceChildren(createIconImg(av, '', 'avatar-img'));
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

  function renderPrivateNotice(profile) {
    const nav = $('.links');
    if (!nav) return;
    nav.replaceChildren();
    const wrap = el('div', 'private-notice');
    wrap.appendChild(el('h2', null, '🔒 Privates Profil'));
    wrap.appendChild(el('p', null, 'Dieses Profil ist derzeit nicht öffentlich sichtbar.'));
    if (profile?.bio) wrap.appendChild(el('p', null, profile.bio));
    nav.appendChild(wrap);
  }

  function buildThemeSwitcher(allowThemes) {
    const existing = $('#theme-switcher');
    if (existing) existing.remove();
    if (!allowThemes) { document.body.removeAttribute('data-theme'); return; }
    const select = document.createElement('select');
    select.id = 'theme-switcher';
    select.className = 'theme-switcher';
    const stored = localStorage.getItem('openweb-theme');
    const themes = [
      { value: '', label: 'Dunkel' },
      { value: 'midnight', label: 'Midnight' },
      { value: 'sunset', label: 'Sunset' },
    ];
    themes.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.value;
      opt.textContent = t.label;
      if (t.value === stored) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      const v = select.value;
      if (v) { document.body.setAttribute('data-theme', v); localStorage.setItem('openweb-theme', v); }
      else { document.body.removeAttribute('data-theme'); localStorage.removeItem('openweb-theme'); }
    });
    if (stored) document.body.setAttribute('data-theme', stored);
    document.body.appendChild(select);
  }

  function readUTM() {
    const params = new URLSearchParams(window.location.search);
    return {
      source: params.get('utm_source') || undefined,
      medium: params.get('utm_medium') || undefined,
      campaign: params.get('utm_campaign') || undefined,
    };
  }

  function trackClick(link) {
    if (!link.id) return;
    try {
      const utm = readUTM();
      window.api.trackLinkClick(link.id, utm).catch(() => { /* störende Klick-Fehler ignorieren */ });
    } catch { /* noop */ }
  }

  async function unlockAndOpen(link, event) {
    event.preventDefault();
    const dlg = $('#link-password-dialog');
    const input = $('#link-password-input');
    const error = $('#link-password-error');
    const cancel = $('#link-password-cancel');
    const form = dlg?.querySelector('form');
    if (!dlg || !input || !form) return;

    input.value = '';
    error.hidden = true;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    input.focus();

    const close = () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); };
    cancel?.addEventListener('click', close, { once: true });

    const onSubmit = async (e) => {
      e.preventDefault();
      try {
        const res = await window.api.unlockLink(link.id, input.value);
        close();
        window.open(res.url, link.open_new !== false ? '_blank' : '_self');
        trackClick(link);
      } catch (err) {
        error.hidden = false;
        input.value = '';
        input.focus();
      }
    };
    form.addEventListener('submit', onSubmit, { once: true });
  }

  function buildLinkRow(link) {
    const href = safeUrl(link.url);
    const a = el('a', 'link');
    a.href = href;
    if (link.open_new !== false && href !== '#') {
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
    }
    if (link.is_password_protected) {
      a.addEventListener('click', (e) => unlockAndOpen(link, e));
    } else {
      // Klicks tracken
      a.addEventListener('click', () => trackClick(link));
    }

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

    const urlEl = el('span', 'link-url', link.display_url || prettyUrl(link.url));
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

    const categories = new Map();
    const none = Symbol('none');
    for (const link of active) {
      const key = link.category_id || none;
      if (!categories.has(key)) categories.set(key, []);
      categories.get(key).push(link);
    }

    const ordered = state.categories || [];
    const catById = new Map(ordered.map(c => [c.id, c]));
    const sectionFor = (cat) => {
      const section = el('div', 'link-group');
      section.appendChild(el('h3', 'link-group-title', cat.name));
      return section;
    };

    // Sortierte Kategorien zuerst, dann ohne Kategorie
    ordered.forEach(cat => {
      const group = categories.get(cat.id);
      if (!group?.length) return;
      const section = sectionFor(cat);
      group.forEach(link => section.appendChild(buildLinkRow(link)));
      nav.appendChild(section);
    });
    if (categories.has(none) && categories.get(none).length) {
      const section = el('div', 'link-group no-category');
      categories.get(none).forEach(link => section.appendChild(buildLinkRow(link)));
      nav.appendChild(section);
    }
  }

  const state = { categories: [] };

  async function render() {
    try {
      const [profile, links, categories] = await Promise.all([
        window.api.getProfile(),
        window.api.getLinks(),
        window.api.getLinkCategories().catch(() => []),
      ]);
      state.categories = categories || [];
      renderProfile(profile);
      buildThemeSwitcher(profile?.allow_visitor_theme !== false);
      if (profile?.is_public === false) {
        renderPrivateNotice(profile);
      } else {
        renderLinks(links);
      }
    } catch (err) {
      const nav = $('.links');
      if (nav) nav.replaceChildren(el('p', 'empty-state', 'Links konnten nicht geladen werden.'));
    }
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
      this.pollTimer = setInterval(() => this.tick(), 3000);
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
        const state = newTrack.paused === true ? 'paused' : 'playing';
        this.renderTrack(this.currentTrack, state);
        // Wenn der Track am Ende ist, sofort wieder synchronisieren
        const duration = this.currentTrack.duration || 0;
        if (state === 'playing' && duration > 0 && this.localPosition >= duration - 1) {
          setTimeout(() => this.tick(), 1500);
        }
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
      // Radio hat keine endliche Dauer, Position nicht hochzaehlen
      if (this.currentTrack.isRadio) return;
      const state = this.currentTrack.paused === true ? 'paused' : 'playing';
      const now = performance.now();
      if (state === 'playing') {
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
      if (data.isRadio) {
        extraEl.innerHTML = '<div class="np-radio-badge">📡 LIVE</div>';
        extraEl.hidden = false;
        return;
      }
      const formatHtml = data.format ? `<div class="np-format">${escapeHtml(data.format.toUpperCase())}</div>` : '';
      const bitrateHtml = data.bitrate ? `<div class="np-bitrate">${escapeHtml(`${data.bitrate} kbps`)}</div>` : '';
      extraEl.innerHTML = formatHtml + bitrateHtml;
      extraEl.hidden = !data.bitrate && !data.format;

      const progressEl = $('#np-progress');
      if (progressEl) {
        if (data.isRadio) {
          progressEl.textContent = data.streamUrl ? '📡 Stream' : '📡 Radio';
          progressEl.hidden = false;
        } else if (data.duration) {
          progressEl.textContent = `${this.formatDuration(position)} / ${this.formatDuration(data.duration)}`;
          progressEl.hidden = false;
        } else {
          progressEl.textContent = '';
          progressEl.hidden = true;
        }
      }
    },

    renderIdle() {
      this.setState('idle');
      const wrap = $('#navidrome-player');
      if (wrap) {
        wrap.hidden = false;
      }
      setText('.np-title', 'Momentan läuft nichts', wrap);
      setText('.np-artist', 'Starte Musik in Navidrome, dann erscheint sie hier', wrap);
      const albumEl = wrap?.querySelector('.np-album');
      if (albumEl) { albumEl.textContent = ''; albumEl.hidden = true; }
      const progressEl = $('#np-progress');
      if (progressEl) { progressEl.textContent = ''; progressEl.hidden = true; }
      const extraEl = wrap?.querySelector('.np-extra');
      if (extraEl) { extraEl.innerHTML = ''; extraEl.hidden = true; }
      const cover = wrap?.querySelector('.np-cover');
      if (cover) {
        cover.replaceChildren(document.createTextNode('🎵'));
        cover.classList.add('placeholder');
      }
      document.title = 'Cornelius Ahner · Links';
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

      // Radio-Klasse setzen/entfernen
      if (data.isRadio) {
        wrap?.classList.add('radio');
      } else {
        wrap?.classList.remove('radio');
      }

      const cover = wrap?.querySelector('.np-cover');
      if (cover) {
        cover.replaceChildren();
        cover.classList.remove('placeholder');
        if (data.coverUrl) {
          cover.appendChild(createIconImg(data.coverUrl, data.title || '', 'np-cover-img'));
        } else {
          cover.appendChild(document.createTextNode(data.isRadio ? '📻' : '🎵'));
          cover.classList.add('placeholder');
        }
      }

      let artist = data.artist || data.album || '';
      if (data.isRadio) {
        artist = artist || 'Internetradio';
        if (state === 'paused') artist += ' (pausiert)';
      } else {
        if (state === 'paused' && artist) artist += ' (pausiert)';
        else if (state === 'paused') artist = 'Pausiert';
      }
      setText('.np-title', data.title || 'Unbekannt', wrap);
      setText('.np-artist', artist, wrap);
      this.updateFavicon(data.coverUrl);
      const albumEl = wrap?.querySelector('.np-album');
      if (albumEl) {
        albumEl.hidden = !data.album;
        setText('.np-album', data.album || '', wrap);
      }
      this.renderExtra(data, data.position || 0);
      if (data.isRadio) {
        document.title = `📻 ${data.title}`;
      } else {
        document.title = data.artist ? `${data.artist} — ${data.title}` : data.title;
      }
      if (state === 'paused') document.title += ' (pausiert)';
    },

  };

  function init() {
    render();
    np.start();
    bindPublicActions();
  }

  function bindPublicActions() {
    const shareBtn = $('#share-btn');
    const qrBtn = $('#qr-public-btn');
    const qrDlg = $('#public-qr-dialog');
    const qrImg = $('#public-qr-img');
    const qrClose = $('#public-qr-close');
    const qrDownload = $('#public-qr-download');

    shareBtn?.addEventListener('click', async () => {
      const url = location.href;
      if (navigator.share) {
        try { await navigator.share({ title: document.title, url }); return; } catch { /* fallback */ }
      }
      try {
        await navigator.clipboard.writeText(url);
        shareBtn.textContent = '✅';
        setTimeout(() => shareBtn.textContent = '📤', 1500);
      } catch { /* noop */ }
    });

    qrBtn?.addEventListener('click', async () => {
      const url = location.href;
      try {
        const data = await window.api.getQRCode(url);
        qrImg.src = data.dataUrl;
        if (typeof qrDlg.showModal === 'function') qrDlg.showModal(); else qrDlg.setAttribute('open', '');
      } catch (err) {
        console.warn('[qr] failed:', err.message);
      }
    });

    qrClose?.addEventListener('click', () => {
      if (typeof qrDlg.close === 'function') qrDlg.close(); else qrDlg.removeAttribute('open');
    });

    qrDownload?.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = qrImg.src;
      a.download = `qr-${location.hostname}.png`;
      a.click();
    });
  }

  const yearEl = $('.year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
