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

  function populateWaveform(container) {
    if (!container || container.dataset.waveformReady === 'true') return;
    const base = container.querySelector('.np-waveform-base');
    const played = container.querySelector('.np-waveform-played');
    if (!base || !played) return;

    const createBars = () => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 48; index++) {
        const variation = Math.abs(Math.sin(index * 1.73) * Math.cos(index * 0.37));
        const envelope = 0.45 + 0.55 * Math.abs(Math.sin(index * 0.11 + 0.8));
        const bar = document.createElement('span');
        bar.className = 'np-wave-bar';
        bar.style.height = `${12 + Math.round(82 * variation * envelope)}%`;
        fragment.appendChild(bar);
      }
      return fragment;
    };

    base.replaceChildren(createBars());
    played.replaceChildren(createBars());
    container.dataset.waveformReady = 'true';
  }

  // Link-Icons kommen einheitlich aus Dashboard Icons (vom Server aufgeloest: icon_resolved)
  function renderIcon(link) {
    if (!window.icons?.createResolved) return document.createTextNode('');
    return window.icons.createResolved(link.icon_resolved, 'link-icon-img');
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

  // ---------- Design-Waehler ----------
  // Knopf oben rechts mit Farbfeld + Name; Menue mit Vorschau aller Themes (js/theme-init.js).
  // Das Standard-Design setzt der Server; ist die Besucherwahl im Admin aus, gibt es keinen Knopf.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(cls, d) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', cls);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  function buildThemeSwitcher(allowThemes) {
    $('#theme-picker')?.remove();
    $('#theme-switcher')?.remove();
    const themes = window.OpenWebThemes;
    if (!themes || !allowThemes) return;

    const wrap = el('div', 'theme-picker');
    wrap.id = 'theme-picker';
    const btn = el('button', 'theme-picker-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'theme-picker-menu');
    const btnSwatch = el('span', 'theme-swatch');
    const btnLabel = el('span', 'theme-picker-label');
    btn.append(btnSwatch, btnLabel, svgIcon('theme-picker-chevron', 'M7 10l5 5 5-5z'));

    const menu = el('div', 'theme-picker-menu');
    menu.id = 'theme-picker-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Design wählen');
    menu.hidden = true;
    menu.appendChild(el('p', 'theme-picker-title', 'Design'));

    const options = themes.list.map((t) => {
      const opt = el('button', 'theme-option');
      opt.type = 'button';
      opt.setAttribute('role', 'menuitemradio');
      opt.dataset.themeId = t.id;
      const sw = el('span', 'theme-swatch');
      sw.dataset.swatch = t.id;
      const text = el('span', 'theme-option-text');
      text.append(el('span', 'theme-option-name', t.label), el('span', 'theme-option-hint', t.hint));
      opt.append(sw, text, svgIcon('theme-option-check', 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'));
      opt.addEventListener('click', () => {
        themes.choose(t.id);
        sync();
        close(true);
      });
      menu.appendChild(opt);
      return opt;
    });

    function sync() {
      const id = themes.current();
      const meta = themes.list.find(t => t.id === id) || themes.list[0];
      btnSwatch.dataset.swatch = meta.id;
      btnLabel.textContent = meta.label;
      btn.setAttribute('aria-label', `Design: ${meta.label} – ändern`);
      options.forEach(o => o.setAttribute('aria-checked', String(o.dataset.themeId === id)));
    }
    function open() {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      (options.find(o => o.getAttribute('aria-checked') === 'true') || options[0]).focus();
    }
    function close(focusButton) {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (focusButton) btn.focus();
    }

    btn.addEventListener('click', () => (menu.hidden ? open() : close(false)));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    menu.addEventListener('keydown', (e) => {
      const i = options.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); options[(i + 1) % options.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); options[(i - 1 + options.length) % options.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); options[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); options[options.length - 1].focus(); }
      else if (e.key === 'Tab') close(false);
    });
    document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) close(false); });

    wrap.append(btn, menu);
    sync();
    document.body.appendChild(wrap);
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

    // Alle Listener dieser Dialog-Oeffnung gemeinsam entfernen (Abbrechen, Escape, Erfolg),
    // sonst wuerden alte Handler beim naechsten Absenden fuer andere Links mitfeuern
    unlockListeners?.abort();
    const listeners = new AbortController();
    unlockListeners = listeners;
    const { signal } = listeners;

    const close = () => {
      listeners.abort();
      if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
    };
    cancel?.addEventListener('click', close, { signal });
    dlg.addEventListener('close', () => listeners.abort(), { signal });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await window.api.unlockLink(link.id, input.value);
        close();
        const target = safeUrl(res.url);
        if (target === '#') return;
        trackClick(link);
        if (link.open_new !== false) window.open(target, '_blank', 'noopener,noreferrer');
        else window.location.href = target;
      } catch (err) {
        // 429 (zu viele Versuche) nicht als "Falsches Passwort" anzeigen
        const defaultText = error.dataset.defaultText || (error.dataset.defaultText = error.textContent);
        error.textContent = err.status === 429 ? err.message : defaultText;
        error.hidden = false;
        input.value = '';
        input.focus();
      }
    }, { signal });
  }
  let unlockListeners = null;

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
    badge.appendChild(renderIcon(link));

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
    // Reihenfolge fuer das gestaffelte Einblenden (styles.css: .link animation-delay)
    nav.querySelectorAll('.link').forEach((a, i) => a.style.setProperty('--i', String(i)));
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
      window.icons?.applyStyle?.(profile?.icon_style);
      const player = $('#navidrome-player');
      if (player) player.dataset.progressStyle = profile?.player_progress_style === 'line' ? 'line' : 'time';
      if (profile?.player_progress_style === 'line') populateWaveform($('#np-progress-line'));
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

  // Musik-Quellen: Anzeigename + Logo (Dashboard Icons ueber den eigenen Proxy)
  const MUSIC_SOURCES = {
    navidrome: { name: 'Navidrome', icon: 'navidrome' },
    musicassistant: { name: 'Music Assistant', icon: 'music-assistant' },
    spotify: { name: 'Spotify', icon: 'spotify' },
  };

  // Now-Playing-Player (Music Assistant, Spotify, Navidrome)
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
      // Im Hintergrund-Tab nicht nachfragen (spart Server- und Akkulast), beim Zurueckkehren sofort
      this.pollTimer = setInterval(() => { if (!document.hidden) this.tick(); }, 3000);
      if (!this.visibilityBound) {
        this.visibilityBound = true;
        document.addEventListener('visibilitychange', () => { if (!document.hidden && this.pollTimer) this.tick(); });
      }
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.progressTimer = setInterval(() => this.updateProgress(), 1000);
    },

    stop() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      if (this.progressTimer) clearInterval(this.progressTimer);
      this.progressTimer = null;
    },

    applyProgressStyle(style) {
      if (!['time', 'line'].includes(style)) return;
      const wrap = $('#navidrome-player');
      if (!wrap || wrap.dataset.progressStyle === style) return;
      wrap.dataset.progressStyle = style;
      if (style === 'line') populateWaveform($('#np-progress-line'));
      if (this.currentTrack) this.renderExtra(this.currentTrack, this.localPosition);
    },

    async tick() {
      try {
        const newTrack = await window.NavidromeAPI.nowPlaying();
        this.applyProgressStyle(newTrack?.player_progress_style);
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

      const progressLine = $('#np-progress-line');
      if (progressLine) {
        const duration = Number(data.duration) || 0;
        const isIndeterminate = data.isRadio || duration <= 0;
        const progress = duration > 0
          ? Math.min(100, Math.max(0, (Number(position) || 0) / duration * 100))
          : 0;
        progressLine.classList.toggle('indeterminate', isIndeterminate);
        progressLine.style.setProperty('--wave-progress', `${progress}%`);
        if (isIndeterminate) {
          progressLine.removeAttribute('aria-valuenow');
        } else {
          progressLine.setAttribute('aria-valuenow', String(Math.round(progress)));
        }
      }

      if (data.isRadio) {
        extraEl.innerHTML = '<div class="np-radio-badge">📡 LIVE</div>';
        extraEl.hidden = false;
        return;
      }
      const formatHtml = data.format ? `<div class="np-format">${escapeHtml(data.format.toUpperCase())}</div>` : '';
      const bitrateStr = typeof data.bitrate === 'number' ? `${data.bitrate} kbps` : data.bitrate;
      const bitrateHtml = bitrateStr ? `<div class="np-bitrate">${escapeHtml(bitrateStr)}</div>` : '';
      extraEl.innerHTML = formatHtml + bitrateHtml;
      extraEl.hidden = !bitrateStr && !data.format;

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
      setText('.np-artist', 'Sobald Musik läuft, erscheint sie hier', wrap);
      this.renderSource(null);
      const albumEl = wrap?.querySelector('.np-album');
      if (albumEl) { albumEl.textContent = ''; albumEl.hidden = true; }
      const progressEl = $('#np-progress');
      if (progressEl) { progressEl.textContent = ''; progressEl.hidden = true; }
      const extraEl = wrap?.querySelector('.np-extra');
      if (extraEl) { extraEl.innerHTML = ''; extraEl.hidden = true; }
      const progressLine = $('#np-progress-line');
      if (progressLine) {
        progressLine.style.setProperty('--wave-progress', '0%');
        progressLine.classList.remove('indeterminate');
      }
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

    // Logo der Quelle vor dem Titel; Name zusaetzlich fuer Screenreader
    renderSource(source) {
      const wrap = $('#navidrome-player');
      const icon = wrap?.querySelector('.np-title-source');
      const label = wrap?.querySelector('.np-source-label');
      const meta = MUSIC_SOURCES[source];
      if (label) label.textContent = meta ? `Quelle: ${meta.name}` : '';
      if (!icon) return;
      if (!meta) {
        icon.hidden = true;
        icon.removeAttribute('src');
        delete icon.dataset.source;
        return;
      }
      icon.title = meta.name;
      if (icon.dataset.source !== source) {
        icon.onerror = () => { icon.hidden = true; };
        icon.decoding = 'async';
        icon.referrerPolicy = 'no-referrer';
        icon.src = `/api/icon/dashboardicon/${meta.icon}/svg`;
        icon.dataset.source = source;
      }
      icon.hidden = false;
    },

    renderTrack(data, state = 'playing') {
      this.setState(state);
      const wrap = $('#navidrome-player');
      if (wrap) wrap.hidden = false;
      this.renderSource(data.source);

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
    revealAdminShortcut();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) revealAdminShortcut();
    });
  }

  async function revealAdminShortcut() {
    const shortcut = $('#admin-shortcut');
    if (!shortcut || window.self !== window.top || !window.api?.me) return;
    try {
      await window.api.me();
      shortcut.hidden = false;
    } catch (err) {
      if (err.status === 401 || err.status === 403) shortcut.hidden = true;
    }
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
        // Icon kurz gegen einen Haken tauschen (Icons stehen als SVG im HTML)
        shareBtn.classList.add('copied');
        setTimeout(() => shareBtn.classList.remove('copied'), 1500);
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
