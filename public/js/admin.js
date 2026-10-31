// =========================================================
// OpenWeb Admin-Logik
// =========================================================

(() => {
  'use strict';

  const AVATAR_MAX_PX = 512;
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
  const AVATAR_TARGET_BYTES = 80 * 1024;
  // Haeufige Dashboard Icons als Schnellauswahl im Link-Dialog
  const DASHBOARD_ICON_IDS = ['instagram','youtube','github','discord','spotify','tiktok','x','linkedin','whatsapp','telegram','twitch','reddit','navidrome','jellyfin','plex','nextcloud'];
  const TAB_TITLES = { links: 'Links', stats: 'Statistik', apikeys: 'API-Keys', profile: 'Profil', music: 'Musik', data: 'Daten', settings: 'Einstellungen', audit: 'Audit-Log', monitor: 'Monitor' };

  const state = { profile: null, links: [], navidrome: null, musicassistant: null, musicassistantUsers: [], spotify: null };

  // Musik-Quellen: Anzeigename + Logo (Dashboard Icons ueber den eigenen Proxy)
  const MUSIC_SOURCES = {
    navidrome: { name: 'Navidrome', icon: 'navidrome' },
    musicassistant: { name: 'Music Assistant', icon: 'music-assistant' },
    spotify: { name: 'Spotify', icon: 'spotify' },
  };
  function sourceIcon(source, cls = 'np-source-icon') {
    const meta = MUSIC_SOURCES[source];
    if (!meta) return null;
    return el('img', {
      src: `/api/icon/dashboardicon/${meta.icon}/svg`,
      alt: '',
      title: meta.name,
      class: cls,
      width: 16,
      height: 16,
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
    });
  }
  const TAB_STORAGE_KEY = 'openweb-admin-active-tab';

  // Seiten aus dem Back-Forward-Cache fuehren DOMContentLoaded nicht erneut aus.
  // Neu laden, damit die Session erneut geprueft und der Admin-Inhalt frisch aufgebaut wird.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'text') { node.textContent = v; continue; }
      if (k === 'html') { node.innerHTML = v; continue; }
      if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
        continue;
      }
      node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const safeText = (s, max = 200) => typeof s === 'string' ? s.replace(/[-]/g, '').slice(0, max) : '';

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

  function bindAdminTheme() {
    const select = $('#admin-theme-select');
    const themes = window.OpenWebThemes;
    if (!select || !themes) return;
    // Optionen aus der gemeinsamen Theme-Liste (js/theme-init.js), Auswahl gilt nur fuer dieses Geraet
    select.replaceChildren(...themes.list.map(t => el('option', { value: t.id, text: t.label })));
    select.value = themes.current();
    select.addEventListener('change', () => { select.value = themes.choose(select.value); });
  }

  function sanitizeIconField(s) {
    if (typeof s !== 'string') return '🔗';
    const t = s.trim() || '🔗';
    if (t.startsWith('simpleicon:')) {
      const id = t.slice(11).toLowerCase();
      return /^[a-z0-9-]{1,32}$/.test(id) ? `simpleicon:${id}` : '🔗';
    }
    if (t.startsWith('dashboardicon:')) {
      const raw = t.slice('dashboardicon:'.length);
      const [name, format = 'png', variant = ''] = raw.split(':');
      const cleanName = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
      if (!cleanName) return '🔗';
      return `dashboardicon:${cleanName}:${format}:${variant}`.replace(/:$/, '');
    }
    if (/^https?:\/\//i.test(t)) return safeUrl(t) || '🔗';
    // Klartext-Name wie "instagram" -> Dashboard Icon
    if (/^[a-z0-9][a-z0-9-]{1,63}$/i.test(t)) return `dashboardicon:${t.toLowerCase()}`;
    return t.slice(0, 8).replace(/[<>"']/g, '');
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const elToast = $('#toast');
    elToast.textContent = msg;
    elToast.classList.toggle('error', isError);
    elToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (elToast.hidden = true), 2500);
  }

  // Link-Icons einheitlich aus Dashboard Icons (vom Server aufgeloest: icon_resolved)
  function renderIcon(resolved, size = 40) {
    const span = el('span', { class: 'icon', style: `width:${size}px;height:${size}px` });
    span.appendChild(window.icons.createResolved(resolved, 'icon-img'));
    return span;
  }

  // Vorschau im Link-Dialog: Server loest Icon-Feld + URL + Titel auf (entprellt)
  let previewTimer;
  function refreshIconPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const form = $('#link-form');
      const preview = $('#icon-preview-target');
      const previewName = $('#icon-preview-name');
      if (!form || !preview) return;
      try {
        const resolved = await window.api.resolveIcon({
          icon: sanitizeIconField(form.icon.value),
          url: form.url.value,
          title: form.title.value,
        });
        preview.replaceChildren(renderIcon(resolved, 32));
        previewName.textContent = resolved.type === 'dashboard' ? `Dashboard Icon: ${resolved.name}`
          : resolved.type === 'image' ? 'Eigene Bild-URL'
          : `Symbol: ${resolved.name} (kein passendes Logo gefunden)`;
      } catch {
        previewName.textContent = '—';
      }
    }, 200);
  }

  function switchTab(name) {
    name = TAB_TITLES[name] ? name : 'links';
    $$('.side-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach(t => t.hidden = t.dataset.tab !== name);
    $('#tab-title').textContent = TAB_TITLES[name];
    sessionStorage.setItem(TAB_STORAGE_KEY, name);
    document.dispatchEvent(new CustomEvent('admin-tab-change', { detail: name }));
  }

  // Ruft fn auf, sobald der Tab-Bereich <section class="tab" data-tab="name"> angezeigt wird
  // (und sofort, falls er beim Start schon sichtbar ist). Bewusst ueber das Ereignis aus
  // switchTab statt ueber [data-tab="…"]: dieser Selektor trifft zuerst den Knopf in der
  // Seitenleiste, der nie versteckt wird.
  function onTabShown(name, fn) {
    const panel = $(`.tab[data-tab="${name}"]`);
    if (!panel) return null;
    document.addEventListener('admin-tab-change', (e) => { if (e.detail === name) fn(); });
    if (!panel.hidden) fn();
    return panel;
  }

  function bindTabs() {
    $$('.side-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    $('#logout-btn').addEventListener('click', () => logout());
    const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (saved && TAB_TITLES[saved]) switchTab(saved);
  }

  function setConnection(connState) {
    const el = $('#connection-state');
    if (el) {
      el.className = 'connection-state ' + connState;
      el.textContent = { ok: '● DB', err: '● Offline' }[connState] || '● Offline';
    }
  }

  async function checkSession() {
    try {
      const me = await window.api.me();
      if (!me || !me.id) throw new Error('Nicht angemeldet');
      setConnection('ok');
      return true;
    } catch {
      setConnection('err');
      location.replace('/login');
      return false;
    }
  }

  async function logout() {
    try {
      await window.api.logout();
    } catch (err) {
      console.warn('[logout]', err.message);
    }
    location.replace('/login');
  }

  function processAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Keine Datei'));
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error('Nur PNG, JPG, WebP oder GIF erlaubt.'));
      if (file.size > AVATAR_MAX_BYTES) return reject(new Error('Datei zu gross (max. 5 MB).'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Bild konnte nicht dekodiert werden.'));
        img.onload = () => {
          const scale = Math.min(1, AVATAR_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, w, h);
          const encode = (m, qv) => { try { return canvas.toDataURL(m, qv); } catch { return null; } };
          let q = 0.9, dataUrl;
          while (q > 0.5) {
            dataUrl = encode('image/webp', q) || encode('image/jpeg', q);
            if (dataUrl && dataUrl.length * 0.75 <= AVATAR_TARGET_BYTES) break;
            q -= 0.1;
          }
          if (!dataUrl) dataUrl = encode('image/webp', 0.9) || encode('image/jpeg', 0.9);
          resolve({ dataUrl, width: w, height: h, sizeKB: Math.round((dataUrl.length * 0.75) / 1024) });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function updateAvatarPreview(dataUrl) {
    const text = $('#avatar-preview-text');
    const img = $('#avatar-preview-img');
    const rm = $('#avatar-remove');
    if (!text || !img) return;
    if (dataUrl) {
      img.src = dataUrl;
      img.hidden = false;
      text.hidden = true;
      if (rm) rm.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      text.hidden = false;
      if (rm) rm.hidden = true;
    }
  }

  function bindAvatarUpload() {
    const fileInput = $('#avatar-file');
    const textInput = $('#profile-form [name="avatar"]');
    const useTextChk = $('#avatar-use-text');
    const removeBtn = $('#avatar-remove');
    const preview = $('#avatar-preview');
    if (!fileInput) return;
    const setDrag = on => preview.classList.toggle('drag-over', on);
    ['dragenter','dragover'].forEach(ev => preview.addEventListener(ev, e => { e.preventDefault(); setDrag(true); }));
    ['dragleave','drop'].forEach(ev => preview.addEventListener(ev, e => { e.preventDefault(); setDrag(false); }));
    preview.addEventListener('drop', async e => {
      const f = e.dataTransfer?.files?.[0];
      if (f) await handleAvatarFile(f);
    });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (f) await handleAvatarFile(f);
      fileInput.value = '';
    });
    removeBtn?.addEventListener('click', () => {
      delete state.profile.avatar_url;
      updateAvatarPreview(null);
      textInput.value = textInput.value || 'CA';
    });
    useTextChk?.addEventListener('change', () => {
      if (useTextChk.checked) { delete state.profile.avatar_url; updateAvatarPreview(null); }
    });
    async function handleAvatarFile(f) {
      try {
        const r = await processAvatar(f);
        state.profile.avatar_url = r.dataUrl;
        if (useTextChk) useTextChk.checked = false;
        updateAvatarPreview(r.dataUrl);
        toast(`📷 Avatar: ${r.width}×${r.height} · ~${r.sizeKB} KB`);
      } catch (err) { toast('Avatar-Fehler: ' + err.message, true); }
    }
  }

  function bindProfile() {
    $('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const profile = {
        name: safeText(fd.get('name'), 80),
        handle: safeText(fd.get('handle'), 80),
        bio: safeText(fd.get('bio'), 280),
        avatar: String(fd.get('avatar') || '').trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 2) || 'CA',
        is_public: fd.get('is_public') === 'on',
        allow_visitor_theme: fd.get('allow_visitor_theme') === 'on',
        theme: window.OpenWebThemes?.isTheme(fd.get('theme')) ? fd.get('theme') : 'dark',
        icon_style: fd.get('icon_style') === 'color' ? 'color' : 'white',
        custom_css: safeText(fd.get('custom_css'), 5000),
      };
      const av = state.profile?.avatar_url;
      if (av !== undefined) {
        if (!av) profile.avatar_url = null;
        else if (/^data:image\/svg\+xml/i.test(av)) { toast('SVG-Avatare nicht erlaubt', true); return; }
        else if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(av)) { toast('Ungueltiges Avatar-Format', true); return; }
        else if (av.length > 700_000) { toast('Avatar zu gross (max. 500 KB)', true); return; }
        else profile.avatar_url = av;
      }
      try {
        await window.api.saveAdminProfile(profile);
        state.profile = await window.api.getAdminProfile();
        window.icons.applyStyle(state.profile?.icon_style);
        renderLinks();
        toast('✅ Profil gespeichert');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    const legalForm = $('#legal-form');
    if (legalForm) {
      legalForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const updates = {
          impressum_text: fd.get('impressum_text') || '',
          datenschutz_text: fd.get('datenschutz_text') || '',
        };
        try {
          // Since the API expects the full profile, we merge updates into state.profile
          const newProfile = { ...state.profile, ...updates };
          const res = await window.api.saveAdminProfile(newProfile);
          state.profile = res;
          toast('Rechtliche Texte gespeichert!');
        } catch (err) {
          toast('Fehler: ' + err.message, true);
        }
      });
    }
  }

  function renderProfile() {
    if (!state.profile) return;
    const f = $('#profile-form');
    if (f) {
      f.name.value = state.profile.name || '';
      f.handle.value = state.profile.handle || '';
      f.bio.value = state.profile.bio || '';
      f.avatar.value = state.profile.avatar || '';
      f.is_public.checked = state.profile.is_public !== false;
      f.allow_visitor_theme.checked = state.profile.allow_visitor_theme !== false;
      if (f.theme && window.OpenWebThemes) {
        if (f.theme.options.length < 2) {
          f.theme.replaceChildren(...window.OpenWebThemes.list.map(t => el('option', { value: t.id, text: `${t.label} – ${t.hint}` })));
        }
        f.theme.value = window.OpenWebThemes.isTheme(state.profile.theme) ? state.profile.theme : 'dark';
      }
      if (f.icon_style) f.icon_style.value = state.profile.icon_style === 'color' ? 'color' : 'white';
      f.custom_css.value = state.profile.custom_css || '';
      updateAvatarPreview(state.profile.avatar_url || null);
    }

    renderPlayerProgressForm();
    
    const fLegal = $('#legal-form');
    if (fLegal) {
      fLegal.impressum_text.value = state.profile.impressum_text || '';
      fLegal.datenschutz_text.value = state.profile.datenschutz_text || '';
    }
  }

  function renderPlayerProgressForm() {
    const form = $('#player-progress-form');
    const style = state.profile?.player_progress_style === 'line' ? 'line' : 'time';
    if (form) form.player_progress_style.value = style;
    const preview = $('#admin-np-player');
    if (preview) preview.dataset.progressStyle = style;
    if (style === 'line') populateAdminWaveform($('#admin-np-progress-line'));
  }

  function populateAdminWaveform(container) {
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

  function bindPlayerProgress() {
    const form = $('#player-progress-form');
    if (!form || !window.api) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = $('#player-progress-status');
      status.textContent = 'Speichere …';
      try {
        const profile = state.profile || await window.api.getAdminProfile();
        state.profile = await window.api.saveAdminProfile({
          ...profile,
          player_progress_style: form.player_progress_style.value === 'line' ? 'line' : 'time'
        });
        renderPlayerProgressForm();
        status.textContent = '✅ Player-Anzeige gespeichert.';
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Einstellung konnte nicht gespeichert werden.');
      }
    });
  }

  function buildLinkRow(link) {
    const badgeCls = link.is_active ? 'on' : 'off';
    const expired = link.expires_at && new Date(link.expires_at) < new Date();
    const actions = [
      { act: 'qr', title: 'QR-Code anzeigen', text: '📱' },
      { act: 'check', title: 'Erreichbarkeit prüfen', text: '🔗' },
      { act: 'up', title: 'Nach oben', text: '↑' },
      { act: 'down', title: 'Nach unten', text: '↓' },
      { act: 'edit', title: 'Bearbeiten', text: '✎' },
      { act: 'del', title: 'Löschen', text: '🗑', cls: 'danger' }
    ];
    const meta = [
      link.category_name,
      link.admin_note,
      link.click_count > 0 ? `${link.click_count} Klicks` : null,
      link.slug ? `/${link.slug}` : null,
      link.is_password_protected ? '🔒 Passwort' : null,
      link.expires_at ? `⏳ ${new Date(link.expires_at).toLocaleString('de-DE')}` : null,
    ].filter(Boolean).join(' · ');
    return el('li', { class: 'link-row', draggable: true, 'data-id': link.id },
      el('span', { class: 'link-handle', title: 'Ziehen zum Sortieren', text: '⠿' }),
      renderIcon(link.icon_resolved, 40),
      el('div', { class: 'link-info' },
        el('div', { class: 'title' },
          el('span', { text: link.title || '' }),
          el('span', { class: `badge ${badgeCls}`, text: expired ? 'abgelaufen' : (link.is_active ? 'aktiv' : 'inaktiv') })
        ),
        el('div', { class: 'sub', text: link.display_url || link.url || '' }),
        meta ? el('div', { class: 'meta', text: meta }) : null
      ),
      el('div', { class: 'actions' },
        ...actions.map(a => el('button', {
          class: `icon-btn ${a.cls || ''}`.trim(),
          'data-act': a.act,
          title: a.title,
          text: a.text
        }))
      )
    );
  }

  function renderLinks(filter = '') {
    const list = $('#links-list');
    const archivePanel = $('#archive-panel');
    const archiveList = $('#archive-list');
    list.replaceChildren();
    const term = filter.toLowerCase().trim();
    const active = state.links.filter(l => l.is_active !== false);
    const archived = state.links.filter(l => l.is_active === false);
    const visible = term
      ? active.filter(l =>
          (l.title || '').toLowerCase().includes(term) ||
          (l.subtitle || '').toLowerCase().includes(term) ||
          (l.url || '').toLowerCase().includes(term) ||
          (l.slug || '').toLowerCase().includes(term) ||
          (l.admin_note || '').toLowerCase().includes(term)
        )
      : active;
    if (!visible.length) {
      list.appendChild(el('li', { class: 'hint', text: term ? 'Keine Treffer.' : 'Noch keine Links – leg den ersten an.' }));
    } else {
      visible.forEach(link => list.appendChild(buildLinkRow(link)));
    }
    if (archiveList) {
      archiveList.replaceChildren();
      if (!archived.length) {
        archiveList.appendChild(el('li', { class: 'hint', text: 'Keine inaktiven Links im Archiv.' }));
      } else {
        archived.forEach(link => archiveList.appendChild(buildArchiveRow(link)));
      }
    }
  }

  function buildArchiveRow(link) {
    return el('li', { class: 'link-row archive' },
      renderIcon(link.icon_resolved, 40),
      el('div', { class: 'link-info' },
        el('div', { class: 'title' }, el('span', { text: link.title || '' })),
        el('div', { class: 'sub', text: link.url || '' })
      ),
      el('div', { class: 'actions' },
        el('button', { class: 'icon-btn', 'data-act': 'restore', title: 'Wiederherstellen', text: '↩' })
      )
    );
  }

  function bindLinks() {
    $('#add-link-btn').addEventListener('click', () => openLinkDialog(null));
    const search = $('#link-search');
    if (search) {
      search.addEventListener('input', () => renderLinks(search.value));
    }
    $('#archive-toggle-btn')?.addEventListener('click', () => {
      const panel = $('#archive-panel');
      if (panel) panel.hidden = !panel.hidden;
    });
    $('#links-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.link-row');
      const id = row.dataset.id;
      const idx = state.links.findIndex(l => l.id === id);
      if (idx < 0) return;
      try {
        if (btn.dataset.act === 'edit') openLinkDialog(state.links[idx]);
        else if (btn.dataset.act === 'check') {
          const result = await window.api.checkLink(id);
          const statusText = result.status === 'ok' ? `✅ Erreichbar (${result.statusCode})` : `❌ ${result.status}${result.statusCode ? ' (' + result.statusCode + ')' : ''}`;
          toast(`${statusText} · ${Math.round(result.responseTimeMs)} ms`);
        }
        else if (btn.dataset.act === 'qr') {
          const url = state.links[idx].url;
          window.showQRDialog(url, state.links[idx].title);
        }
        else if (btn.dataset.act === 'del') {
          if (!confirm(`„${state.links[idx].title}" wirklich löschen?`)) return;
          await window.api.deleteLink(id);
          await reloadLinks();
          toast('🗑️ Gelöscht');
        } else if (btn.dataset.act === 'up' && idx > 0) await moveLink(idx, idx - 1);
        else if (btn.dataset.act === 'down' && idx < state.links.length - 1) await moveLink(idx, idx + 1);
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    $('#archive-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.dataset.act !== 'restore') return;
      const row = btn.closest('.link-row');
      const id = row.dataset.id;
      try {
        await window.api.updateLink(id, { is_active: true });
        await reloadLinks();
        toast('↩ Link wiederhergestellt');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    let dragId = null;
    const list = $('#links-list');
    list.addEventListener('dragstart', e => {
      const row = e.target.closest('.link-row');
      if (!row) return;
      dragId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    list.addEventListener('dragend', () => { $$('.link-row').forEach(r => r.classList.remove('dragging','drag-over')); dragId = null; });
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const row = e.target.closest('.link-row');
      if (!row || row.dataset.id === dragId) return;
      $$('.link-row').forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      const row = e.target.closest('.link-row');
      if (!row || !dragId) return;
      const from = state.links.findIndex(l => l.id === dragId);
      const to = state.links.findIndex(l => l.id === row.dataset.id);
      if (from >= 0 && to >= 0 && from !== to) await moveLink(from, to);
    });
  }

  async function moveLink(from, to) {
    const links = state.links.slice();
    const [moved] = links.splice(from, 1);
    links.splice(to, 0, moved);
    state.links = links;
    renderLinks();
    try { await window.api.reorderLinks(links.map(l => l.id)); } catch (err) { toast('Fehler: ' + err.message, true); }
  }

  function initIconPicker() {
    const panel = $('#icon-picker-panel');
    const toggle = $('#icon-picker-toggle');
    const search = $('#icon-search');
    const grid = $('#icon-grid');
    const input = $('#link-form [name="icon"]');
    const suggested = $('#icon-suggested-list');
    if (!panel || !toggle) return;

    const dashImg = (name) => el('img', { src: window.icons.dashboardUrl(name), alt: '', loading: 'lazy', class: 'icon-img' });

    const selectIcon = (value) => {
      input.value = value;
      refreshIconPreview();
      panel.hidden = true;
      toggle.classList.remove('active');
    };

    const chip = (name, label = name) => {
      const btn = el('button', { type: 'button', 'data-icon': `dashboardicon:${name}`, title: name }, dashImg(name), ' ' + label);
      return btn;
    };

    const renderSuggested = () => {
      const auto = el('button', { type: 'button', 'data-icon': '', title: 'Icon automatisch anhand von URL und Titel wählen' }, '✨ Automatisch');
      suggested.replaceChildren(auto, ...DASHBOARD_ICON_IDS.slice(0, 12).map(name => chip(name)));
    };

    // Suche in allen Dashboard Icons (serverseitig, max. 120 Treffer)
    let gridRequest = 0;
    const renderGrid = async (query = '') => {
      const requestId = ++gridRequest;
      if (!query) {
        grid.replaceChildren(el('div', { class: 'icon-empty', text: 'Tippe oben, um in allen Dashboard Icons zu suchen …' }));
        return;
      }
      try {
        const { names, total } = await window.api.getDashboardIcons(query);
        if (requestId !== gridRequest) return; // veraltete Antwort
        if (!names.length) {
          grid.replaceChildren(el('div', { class: 'icon-empty', text: `Keine Treffer für „${query}“` }));
          return;
        }
        const current = (input.value || '').startsWith('dashboardicon:') ? input.value.slice(14).split(':')[0] : null;
        grid.replaceChildren(...names.map(name => {
          const cell = el('div', { class: 'icon-cell', 'data-id': name, 'data-tip': name }, dashImg(name));
          if (name === current) cell.classList.add('selected');
          return cell;
        }));
        if (total > names.length) {
          grid.appendChild(el('div', { class: 'icon-empty', text: `${total - names.length} weitere – Suche genauer eingrenzen` }));
        }
      } catch (err) {
        grid.replaceChildren(el('div', { class: 'icon-empty', text: 'Icons konnten nicht geladen werden.' }));
      }
    };

    // Empfehlung anhand von URL und Titel (gleiche Logik wie auf der Startseite)
    const suggestForCurrent = async () => {
      suggested.querySelector('.icon-recommended')?.remove();
      try {
        const form = $('#link-form');
        const resolved = await window.api.resolveIcon({ icon: '', url: form.url.value, title: form.title.value });
        if (resolved.type !== 'dashboard') return;
        const btn = chip(resolved.name, `Empfohlen: ${resolved.name}`);
        btn.classList.add('icon-recommended');
        suggested.insertBefore(btn, suggested.firstChild);
      } catch { /* keine Empfehlung */ }
    };

    let suggestionsRendered = false;
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.classList.toggle('active', !panel.hidden);
      if (!panel.hidden) {
        // Vorschlags-Logos erst beim ersten Oeffnen laden (nicht schon beim Seitenstart)
        if (!suggestionsRendered) { renderSuggested(); suggestionsRendered = true; }
        renderGrid(search.value.trim().toLowerCase());
        refreshIconPreview();
        suggestForCurrent();
        setTimeout(() => search.focus(), 50);
      }
    });

    input.addEventListener('input', refreshIconPreview);
    // Vorschau aktualisieren, wenn sich URL oder Titel aendern (automatische Erkennung)
    $('#link-form [name="url"]')?.addEventListener('input', refreshIconPreview);
    $('#link-form [name="title"]')?.addEventListener('input', refreshIconPreview);

    let searchTimer;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderGrid(search.value.trim().toLowerCase()), 200);
    });

    grid.addEventListener('click', e => {
      const id = e.target.closest('.icon-cell')?.dataset?.id;
      if (id) selectIcon(`dashboardicon:${id}`);
    });
    suggested.addEventListener('click', e => {
      const btn = e.target.closest('button[data-icon]');
      if (btn) selectIcon(btn.dataset.icon);
    });
  }

  function setMultiSelectValues(select, values) {
    if (!select || !values) return;
    Array.from(select.options).forEach(opt => { opt.selected = values.includes(parseInt(opt.value, 10)); });
  }

  function openLinkDialog(link) {
    const dlg = $('#link-dialog');
    const form = $('#link-form');
    form.reset();
    $('#link-dialog-title').textContent = link ? 'Link bearbeiten' : 'Neuer Link';
    populateCategorySelect(form.category_id);
    if (link) {
      form.title.value = link.title || '';
      form.subtitle.value = link.subtitle || '';
      form.url.value = link.url || '';
      form.display_url.value = link.display_url || '';
      form.icon.value = link.icon || '';
      form.meta_description.value = link.meta_description || '';
      form.admin_note.value = link.admin_note || '';
      form.slug.value = link.slug || '';
      form.category_id.value = link.category_id || '';
      form.visible_from.value = link.visible_from ? new Date(link.visible_from).toISOString().slice(0, 16) : '';
      form.visible_until.value = link.visible_until ? new Date(link.visible_until).toISOString().slice(0, 16) : '';
      form.expires_at.value = link.expires_at ? new Date(link.expires_at).toISOString().slice(0, 16) : '';
      form.password.value = '';
      setMultiSelectValues(form.visible_weekdays, link.visible_weekdays);
      form.is_active.checked = link.is_active !== false;
      form.open_new.checked = link.open_new !== false;
      form.dataset.id = link.id;
    } else {
      delete form.dataset.id;
      form.is_active.checked = true;
      form.open_new.checked = true;
      setMultiSelectValues(form.visible_weekdays, []);
    }
    refreshIconPreview();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function populateCategorySelect(select) {
    if (!select) return;
    const current = select.value;
    select.replaceChildren(el('option', { value: '' }, '— Keine —'));
    (state.categories || []).forEach(c => {
      select.appendChild(el('option', { value: c.id }, c.name));
    });
    select.value = current || '';
  }

  function closeLinkDialog() {
    const dlg = $('#link-dialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function bindLinkDialog() {
    $('#link-cancel').addEventListener('click', closeLinkDialog);
    $('#link-check').addEventListener('click', async () => {
      const form = $('#link-form');
      if (!form.dataset.id) { toast('Bitte zuerst speichern, um die Erreichbarkeit zu prüfen', true); return; }
      try {
        const result = await window.api.checkLink(form.dataset.id);
        const statusText = result.status === 'ok' ? `✅ Erreichbar (${result.statusCode})` : `❌ ${result.status}${result.statusCode ? ' (' + result.statusCode + ')' : ''}`;
        toast(`${statusText} · ${Math.round(result.responseTimeMs)} ms`);
      } catch (err) { toast('Prüfung fehlgeschlagen: ' + err.message, true); }
    });

    $('#link-qr')?.addEventListener('click', () => {
      const form = $('#link-form');
      const url = safeUrl(form.url.value);
      if (!url) { toast('Bitte eine gültige URL eingeben', true); return; }
      const dlg = $('#qr-dialog');
      const container = $('#qr-container');
      container.replaceChildren();
      container.appendChild(el('p', { class: 'hint', text: 'QR-Code wird generiert…' }));
      window.api.getQRCode(url).then(({ dataUrl }) => {
        container.replaceChildren();
        container.appendChild(el('img', { src: dataUrl, alt: 'QR-Code', class: 'qr-code-img' }));
        container.appendChild(el('p', { class: 'hint', text: url }));
      }).catch(err => {
        container.replaceChildren();
        container.appendChild(el('p', { class: 'hint error', text: 'Fehler: ' + err.message }));
      });
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    });
    $('#link-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const urlClean = safeUrl(form.url.value);
      if (!urlClean) { toast('Ungueltige URL (nur http, https oder mailto erlaubt)', true); return; }
      const data = {
        title: safeText(form.title.value, 80),
        subtitle: safeText(form.subtitle.value, 120),
        url: urlClean,
        display_url: safeText(form.display_url.value, 120),
        icon: sanitizeIconField(form.icon.value),
        is_active: form.is_active.checked,
        open_new: form.open_new.checked,
        meta_description: safeText(form.meta_description.value, 280),
        admin_note: safeText(form.admin_note.value, 280),
        slug: form.slug.value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80),
        category_id: form.category_id.value || null,
        visible_from: form.visible_from.value || null,
        visible_until: form.visible_until.value || null,
        visible_weekdays: Array.from(form.visible_weekdays.selectedOptions).map(o => parseInt(o.value, 10)),
        expires_at: form.expires_at.value || null,
        password: form.password.value || undefined,
      };
      if (!data.title || !data.url) { toast('Titel und URL sind Pflicht', true); return; }
      try {
        if (form.dataset.id) { await window.api.updateLink(form.dataset.id, data); toast('✅ Gespeichert'); }
        else { await window.api.createLink({ ...data, position: state.links.length }); toast('✅ Hinzugefügt'); }
        closeLinkDialog();
        await reloadLinks();
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  }

  function bindCategories() {
    const panel = $('#category-panel');
    const list = $('#category-list');
    const input = $('#category-input');
    const addBtn = $('#category-add-btn');
    if (!panel || !list || !input || !addBtn) return;

    async function render() {
      await reloadCategories();
      list.replaceChildren();
      (state.categories || []).forEach(c => {
        const item = el('li', { class: 'category-row', 'data-id': c.id },
          el('span', { text: c.name }),
          el('button', { class: 'icon-btn danger', 'data-act': 'del', title: 'Löschen', text: '🗑' })
        );
        list.appendChild(item);
      });
      populateCategorySelect($('#link-form')?.category_id);
    }

    addBtn.addEventListener('click', async () => {
      const name = safeText(input.value, 80);
      if (!name) { toast('Bitte einen Kategorienamen eingeben', true); return; }
      try {
        await window.api.createLinkCategory({ name });
        input.value = '';
        await render();
        toast('✅ Kategorie hinzugefügt');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('.category-row')?.dataset?.id;
      if (!id) return;
      try {
        await window.api.deleteLinkCategory(id);
        await render();
        toast('🗑️ Kategorie gelöscht');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    // Erstrendering verzoegern, bis state geladen ist
    setTimeout(render, 0);
  }

  function bindStats() {
    const summary = $('#stats-summary');
    const list = $('#stats-list');
    const canvas = $('#stats-chart');
    const rangeGroup = $('#stats-range');
    const utmEl = $('#stats-utm');
    const devicesEl = $('#stats-devices');
    const browsersEl = $('#stats-browsers');
    const osEl = $('#stats-os');
    const countriesEl = $('#stats-countries');
    const panel = $('.tab[data-tab="stats"]');
    if (!summary || !list || !canvas || !panel) return;

    let currentDays = 30;
    let lastStats = null;   // zuletzt geladene Daten (fuer Neuzeichnen und CSV)
    let requestSeq = 0;     // nur die Antwort der juengsten Anfrage wird angezeigt
    let loadedAt = 0;

    const isVisible = () => !panel.hidden && !document.hidden;
    // Zeitzone des Browsers, damit die Tagesbalken lokalen Kalendertagen entsprechen
    const timeZone = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
    })();

    function localDayKey(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function setRange(days) {
      currentDays = days;
      rangeGroup?.querySelectorAll('button[data-days]').forEach(b => {
        const active = parseInt(b.dataset.days, 10) === days;
        b.classList.toggle('primary', active);
        b.setAttribute('aria-pressed', String(active));
      });
    }

    function setLoading(loading) {
      panel.querySelector('.card-block')?.setAttribute('aria-busy', String(loading));
      summary.classList.toggle('is-loading', loading);
      canvas.classList.toggle('is-loading', loading);
    }

    function drawChart(timeline, days) {
      const rect = canvas.getBoundingClientRect();
      // Versteckter Tab hat keine Groesse – dann beim naechsten Anzeigen zeichnen
      if (!rect.width || !rect.height) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const byDay = new Map((timeline || []).map(t => [String(t.day).slice(0, 10), Number(t.count) || 0]));
      const dates = [];
      const counts = [];
      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        dates.push(d);
        counts.push(byDay.get(localDayKey(d)) || 0);
      }
      // Skala auf "runde" Werte, damit die Gitterlinien ganze Zahlen tragen
      const rawMax = Math.max(...counts, 0);
      const max = Math.max(4, Math.ceil(rawMax / 4) * 4);

      // Farben aus den M3-Farbrollen (css/admin.css) lesen
      const css = getComputedStyle(document.documentElement);
      const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      const primary = color('--md-primary', '#d0bcff');
      const primaryContainer = color('--md-primary-container', '#4f378b');
      const muted = color('--md-on-surface-variant', '#cac4d0');

      const left = 40, right = 10, top = 20, bottom = 30;
      const plotH = h - top - bottom;
      const plotW = w - left - right;

      // Gitter + Y-Achse
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = Math.round(h - bottom - plotH * (i / 4)) + 0.5;
        ctx.strokeStyle = color('--md-outline-variant', '#49454f');
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(w - right, y);
        ctx.stroke();
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(String((max / 4) * i), left - 6, y);
      }

      // Balken
      const slot = plotW / days;
      const barPad = Math.min(4, slot * 0.25);
      const barW = Math.max(1, slot - barPad);
      counts.forEach((c, i) => {
        if (!c) return;
        const x = left + i * slot + barPad / 2;
        const barH = Math.max(2, (c / max) * plotH);
        const y = h - bottom - barH;
        const grad = ctx.createLinearGradient(0, y, 0, h - bottom);
        grad.addColorStop(0, primary);
        grad.addColorStop(1, primaryContainer);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, barW, barH);
      });

      // X-Achse: so viele Beschriftungen, wie nebeneinander passen (je ~52 px, hoechstens 8);
      // die letzte ist immer "heute"
      ctx.fillStyle = muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      const maxLabels = Math.max(2, Math.min(8, Math.floor(plotW / 52)));
      const step = Math.max(1, Math.ceil(days / maxLabels));
      for (let i = days - 1; i >= 0; i -= step) {
        const x = left + i * slot + slot / 2;
        ctx.fillText(`${dates[i].getDate()}.${dates[i].getMonth() + 1}.`, x, h - 12);
      }

      canvas.setAttribute('aria-label',
        `Klicks pro Tag, letzte ${days} Tage: insgesamt ${counts.reduce((a, b) => a + b, 0)}, höchstens ${rawMax} an einem Tag`);
    }

    function renderBreakdown(container, items, labelKey) {
      if (!container) return;
      container.replaceChildren();
      if (!items?.length) {
        container.appendChild(el('li', { class: 'hint', text: 'Keine Daten.' }));
        return;
      }
      items.forEach(i => {
        container.appendChild(el('li', { class: 'stat-row' },
          el('span', { class: 'stat-title', text: String(i[labelKey] ?? 'unbekannt') }),
          el('span', { class: 'stat-clicks', text: `${i.count} Klicks` })
        ));
      });
    }

    function show(stats) {
      const card = (value, label) => el('div', { class: 'stat-card' },
        el('strong', { text: Number(value || 0).toLocaleString('de-DE') }),
        el('span', { text: label })
      );
      summary.replaceChildren(
        card(stats.total, 'Gesamtklicks'),
        card(stats.links.length, 'Links'),
        card(stats.musicHistory?.length, 'Songs gehört')
      );

      if (window.renderMusicHistory) {
        window.renderMusicHistory(stats.musicHistory || []);
      }

      list.replaceChildren();
      if (!stats.links.length) {
        list.appendChild(el('li', { class: 'hint', text: 'Noch keine Links vorhanden.' }));
      }
      stats.links.forEach(l => {
        list.appendChild(el('li', { class: 'stat-row' },
          el('div', { class: 'stat-info' },
            el('span', { class: 'stat-title', text: l.title || l.url || '' }),
            el('span', { class: 'stat-url', text: l.url || '' })
          ),
          el('div', { class: 'stat-counts' },
            el('span', { class: 'stat-clicks', text: `${l.clicks} Klicks` }),
            el('span', { class: 'stat-unique', text: `${l.unique_visitors} Unique` })
          )
        ));
      });

      drawChart(stats.timeline, stats.days || currentDays);

      renderBreakdown(devicesEl, stats.devices, 'device_type');
      renderBreakdown(browsersEl, stats.browsers, 'browser');
      renderBreakdown(osEl, stats.os, 'os');
      renderBreakdown(countriesEl, stats.countries, 'country_code');

      if (utmEl) {
        if (stats.utm?.length) {
          const tbody = el('tbody');
          stats.utm.forEach(u => {
            tbody.appendChild(el('tr', {},
              el('td', { text: u.source }),
              el('td', { text: u.medium }),
              el('td', { text: String(u.count) })
            ));
          });
          const table = el('table', { class: 'utm-table' },
            el('thead', {}, el('tr', {},
              el('th', { text: 'Quelle' }), el('th', { text: 'Medium' }), el('th', { text: 'Klicks' }))),
            tbody
          );
          utmEl.replaceChildren(table);
        } else {
          utmEl.replaceChildren(el('p', { class: 'hint', text: 'Keine UTM-Parameter in diesem Zeitraum.' }));
        }
      }
    }

    async function load(days = currentDays) {
      setRange(days);
      const seq = ++requestSeq;
      setLoading(true);
      if (!lastStats) {
        summary.replaceChildren(el('p', { class: 'hint', text: 'Statistiken werden geladen …' }));
      }
      try {
        const stats = await window.api.getLinkStats(days, timeZone);
        if (seq !== requestSeq) return; // inzwischen anderer Zeitraum gewaehlt
        lastStats = stats;
        loadedAt = Date.now();
        show(stats);
      } catch (err) {
        if (seq !== requestSeq) return;
        lastStats = null;
        summary.replaceChildren(el('p', { class: 'hint error', text: `Statistiken konnten nicht geladen werden: ${err.message}` }));
      } finally {
        if (seq === requestSeq) setLoading(false);
      }
    }

    // Beim Anzeigen des Tabs immer aktuelle Zahlen holen; bereits geladene Daten sofort
    // zeichnen (Canvas hatte im versteckten Tab keine Groesse).
    function onShown() {
      if (lastStats) drawChart(lastStats.timeline, lastStats.days || currentDays);
      load(currentDays);
    }
    onTabShown('stats', onShown);

    // Zurueck in den Browser-Tab nach laengerer Zeit: auffrischen
    document.addEventListener('visibilitychange', () => {
      if (isVisible() && Date.now() - loadedAt > 60_000) load(currentDays);
    });

    // Bei Groessenaenderung nur neu zeichnen, nicht neu laden
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (lastStats && !panel.hidden) drawChart(lastStats.timeline, lastStats.days || currentDays);
      }, 150);
    });

    rangeGroup?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-days]');
      if (!btn) return;
      load(parseInt(btn.dataset.days, 10));
    });

    function exportCSV() {
      const days = currentDays;
      window.api.getLinkStats(days, timeZone).then(stats => {
        const rows = [
          ['Zeitraum', `Letzte ${days} Tage`, '', ''],
          ['Gesamtklicks', stats.total, '', ''],
          ['', '', '', ''],
          ['Link', 'URL', 'Klicks', 'Unique']
        ];
        stats.links.forEach(l => rows.push([l.title || l.url, l.url, l.clicks, l.unique_visitors]));
        rows.push(['', '', '', '']);
        rows.push(['UTM Source', 'UTM Medium', 'Klicks', '']);
        (stats.utm || []).forEach(u => rows.push([u.source, u.medium, u.count, '']));
        rows.push(['', '', '', '']);
        rows.push(['Kategorie', 'Wert', 'Klicks', '']);
        (stats.devices || []).forEach(i => rows.push(['Gerät', i.device_type, i.count, '']));
        (stats.browsers || []).forEach(i => rows.push(['Browser', i.browser, i.count, '']));
        (stats.os || []).forEach(i => rows.push(['OS', i.os, i.count, '']));
        (stats.countries || []).forEach(i => rows.push(['Land', i.country_code, i.count, '']));

        const csv = rows.map(r =>
          r.map(c => {
            let v = String(c ?? '');
            // Formel-Injection verhindern: Texte, die eine Tabellenkalkulation als Formel
            // auswerten wuerde (= + - @, Tab, CR), mit Apostroph als Text markieren.
            // Zahlen (Klickzahlen) bleiben unveraendert.
            if (typeof c !== 'number' && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
            v = v.replace(/"/g, '""');
            return /[;\n\r",]/.test(v) ? `"${v}"` : v;
          }).join(';')
        ).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: `stats-${days}d-${new Date().toISOString().slice(0, 10)}.csv` });
        a.click();
        URL.revokeObjectURL(url);
        toast('📄 CSV exportiert');
      }).catch(err => toast('Fehler: ' + err.message, true));
    }

    $('#stats-export-csv')?.addEventListener('click', exportCSV);
  }

  function bindApiKeys() {
    const list = $('#api-key-list');
    const input = $('#api-key-name');
    const addBtn = $('#api-key-add-btn');
    const result = $('#api-key-result');
    if (!list || !addBtn) return;

    async function render() {
      try {
        const keys = await window.api.getApiKeys();
        list.replaceChildren();
        if (!keys.length) {
          list.appendChild(el('li', { class: 'hint', text: 'Noch keine API-Keys vorhanden.' }));
          return;
        }
        keys.forEach(k => {
          const item = el('li', { class: 'api-key-row' },
            el('div', { class: 'api-key-info' },
              el('strong', { text: k.name }),
              el('span', { class: 'hint', text: `Zuletzt verwendet: ${k.last_used_at ? new Date(k.last_used_at).toLocaleString('de-DE') : 'nie'}` })
            ),
            el('button', { class: 'icon-btn danger', 'data-id': k.id, title: 'Löschen', text: '🗑' })
          );
          list.appendChild(item);
        });
      } catch (err) {
        list.innerHTML = `<li class="hint error">${escapeHtml(err.message)}</li>`;
      }
    }

    addBtn.addEventListener('click', async () => {
      const name = safeText(input.value, 80);
      if (!name) { toast('Bitte einen Namen eingeben', true); return; }
      try {
        const res = await window.api.createApiKey(name);
        input.value = '';
        await render();
        result.hidden = false;
        result.innerHTML = `<strong>Neuer Key:</strong> <code>${escapeHtml(res.key)}</code> <br/><small>Speicher ihn sofort – er wird nicht erneut angezeigt.</small>`;
        toast('✅ API-Key erstellt');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-id]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (!confirm('API-Key wirklich löschen?')) return;
      try {
        await window.api.deleteApiKey(id);
        await render();
        toast('🗑 API-Key gelöscht');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    onTabShown('apikeys', render);
  }

  function bindPreview() {
    const toggle = $('#preview-toggle');
    const dlg = $('#preview-dialog');
    const close = $('#preview-close');
    const refresh = $('#preview-refresh');
    const frame = $('#preview-frame');
    if (!toggle || !dlg || !frame) return;

    function open() {
      frame.src = '/?__preview=' + Date.now();
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }

    function closeDlg() {
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    }

    toggle.addEventListener('click', open);
    close?.addEventListener('click', closeDlg);
    refresh?.addEventListener('click', () => { frame.src = '/?__preview=' + Date.now(); });
  }

  function bindQRCode() {
    const toggle = $('#qr-toggle');
    const dlg = $('#qr-dialog');
    const close = $('#qr-close');
    const download = $('#qr-download');
    const container = $('#qr-container');
    if (!toggle || !dlg || !close || !container) return;

    let currentDataUrl = null;
    let currentText = '';

    function downloadCurrentQR() {
      if (!currentDataUrl) { toast('Noch kein QR-Code vorhanden', true); return; }
      const a = el('a', { href: currentDataUrl, download: `qrcode-${currentText.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png` });
      a.click();
    }

    async function showQR(text, caption) {
      currentText = text;
      currentDataUrl = null;
      container.replaceChildren();
      container.appendChild(el('p', { class: 'hint', text: 'QR-Code wird generiert…' }));
      try {
        const { dataUrl } = await window.api.getQRCode(text);
        currentDataUrl = dataUrl;
        container.replaceChildren();
        const img = el('img', { src: dataUrl, alt: 'QR-Code', class: 'qr-code-img' });
        container.appendChild(img);
        if (caption) container.appendChild(el('p', { class: 'hint', text: caption }));
      } catch (err) {
        container.replaceChildren();
        container.appendChild(el('p', { class: 'hint error', text: 'Fehler: ' + err.message }));
      }
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }

    toggle.addEventListener('click', () => {
      const url = `${location.protocol}//${location.host}/`;
      showQR(url, url);
    });

    close.addEventListener('click', () => {
      if (typeof dlg.close === 'function') dlg.close();
      else dlg.removeAttribute('open');
    });

    download?.addEventListener('click', downloadCurrentQR);
  }

  window.showQRDialog = async function(text, caption) {
    const dlg = $('#qr-dialog');
    const container = $('#qr-container');
    const download = $('#qr-download');
    if (!dlg || !container) return;
    let currentDataUrl = null;
    let currentText = text;

    function downloadCurrentQR() {
      if (!currentDataUrl) { toast('Noch kein QR-Code vorhanden', true); return; }
      const a = el('a', { href: currentDataUrl, download: `qrcode-${currentText.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png` });
      a.click();
    }
    if (download) {
      download.removeEventListener('click', download._qrHandler);
      download._qrHandler = downloadCurrentQR;
      download.addEventListener('click', downloadCurrentQR);
    }

    container.replaceChildren();
    container.appendChild(el('p', { class: 'hint', text: 'QR-Code wird generiert…' }));
    try {
      const { dataUrl } = await window.api.getQRCode(text);
      currentDataUrl = dataUrl;
      container.replaceChildren();
      container.appendChild(el('img', { src: dataUrl, alt: 'QR-Code', class: 'qr-code-img' }));
      if (caption) container.appendChild(el('p', { class: 'hint', text: caption }));
    } catch (err) {
      container.replaceChildren();
      container.appendChild(el('p', { class: 'hint error', text: 'Fehler: ' + err.message }));
    }
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  };

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  async function renderBackups() {
    const list = $('#backup-list');
    if (!list) return;
    try {
      const backups = await window.api.getBackups();
      list.replaceChildren();
      if (!backups.length) {
        list.appendChild(el('li', { class: 'hint', text: 'Noch keine Backups vorhanden.' }));
        return;
      }
      backups.forEach(b => {
        const item = el('li', { class: 'backup-row' },
          el('span', { class: 'backup-name', text: b.name }),
          el('span', { class: 'backup-meta', text: `${formatBytes(b.size)} · ${new Date(b.createdAt).toLocaleString('de-DE')}` }),
          el('a', { class: 'btn small', href: `/api/admin/backups/download/${encodeURIComponent(b.name)}`, download: b.name, text: '⬇ Download' })
        );
        list.appendChild(item);
      });
    } catch (err) {
      list.innerHTML = `<li class="hint error">${escapeHtml(err.message)}</li>`;
    }
  }

  function bindData() {
    const keyBackupForm = $('#encryption-key-backup-form');
    keyBackupForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const backupPassword = String(fd.get('backupPassword') || '');
      const backupPasswordConfirm = String(fd.get('backupPasswordConfirm') || '');
      const status = $('#encryption-key-backup-status');
      if (backupPassword !== backupPasswordConfirm) {
        status.textContent = 'Die Wiederherstellungs-Passphrasen stimmen nicht überein.';
        status.classList.add('error');
        return;
      }

      status.textContent = 'Schlüssel-Backup wird erstellt …';
      status.classList.remove('error');
      try {
        const result = await window.api.createEncryptionKeyBackup(String(fd.get('password') || ''), backupPassword);
        downloadJSON(result.backup, `openweb-encryption-key-backup-${new Date().toISOString().slice(0, 10)}.json`);
        status.textContent = 'Backup heruntergeladen. Bewahre Datei und Passphrase getrennt und offline auf.';
        form.reset();
      } catch (err) {
        status.textContent = 'Backup konnte nicht erstellt werden: ' + err.message;
        status.classList.add('error');
        form.password.value = '';
        form.backupPassword.value = '';
        form.backupPasswordConfirm.value = '';
      }
    });

    const keyRestoreForm = $('#encryption-key-restore-form');
    keyRestoreForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const file = fd.get('backupFile');
      const status = $('#encryption-key-restore-status');
      if (!(file instanceof File) || !file.size || file.size > 64 * 1024) {
        status.textContent = 'Bitte eine gültige Schlüssel-Backup-Datei bis maximal 64 KB auswählen.';
        status.classList.add('error');
        return;
      }
      if (!confirm('Der Anwendungsschlüssel wird ersetzt. Nur ein Backup dieser Installation verwenden. Fortfahren?')) return;

      status.textContent = 'Backup wird geprüft und Schlüssel wiederhergestellt …';
      status.classList.remove('error');
      try {
        const backup = JSON.parse(await file.text());
        await window.api.restoreEncryptionKey({
          password: String(fd.get('password') || ''),
          backupPassword: String(fd.get('backupPassword') || ''),
          backup,
        });
        status.textContent = 'Schlüssel wiederhergestellt und im laufenden Server aktiviert.';
        form.reset();
      } catch (err) {
        status.textContent = 'Wiederherstellung fehlgeschlagen: ' + err.message;
        status.classList.add('error');
        form.password.value = '';
        form.backupPassword.value = '';
      }
    });

    $('#backup-now-btn')?.addEventListener('click', async () => {
      try {
        await window.api.createBackup();
        await renderBackups();
        toast('✅ Backup erstellt');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    $('#export-btn').addEventListener('click', async () => {
      try {
        const data = await window.api.exportData();
        downloadJSON(data, `openweb-backup-${new Date().toISOString().slice(0,10)}.json`);
        toast('📤 Exportiert');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    function parseCSV(text) {
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return [];
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
      const titleIdx = headers.indexOf('title');
      const urlIdx = headers.indexOf('url');
      const subIdx = headers.indexOf('subtitle');
      if (titleIdx < 0 || urlIdx < 0) return [];
      return lines.slice(1).map(line => {
        const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        return {
          title: cols[titleIdx] || '',
          url: cols[urlIdx] || '',
          subtitle: subIdx >= 0 ? (cols[subIdx] || '') : '',
        };
      }).filter(r => r.title && r.url);
    }

    $('#import-btn').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!confirm('Beim Import werden alle bestehenden Links und das Profil überschrieben. Fortfahren?')) { e.target.value = ''; return; }
      try {
        const data = JSON.parse(await file.text());
        const result = await window.api.importData(data);
        await reloadAll();
        const lost = Number(result && result.deactivated_unprotected) || 0;
        if (lost > 0) toast(`📥 Importiert – ${lost} passwortgeschützte(r) Link(s) deaktiviert, bitte Passwort neu setzen`, true);
        else toast('📥 Importiert');
      } catch (err) { toast('Import fehlgeschlagen: ' + err.message, true); }
      e.target.value = '';
    });

    $('#linktree-import-btn')?.addEventListener('click', () => $('#linktree-import-input').click());
    $('#linktree-import-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const rows = parseCSV(text);
        if (!rows.length) { toast('CSV enthält keine gültigen Daten (Spalten: title,url,subtitle)', true); return; }
        await window.api.importLinktreeCSV(rows);
        await reloadLinks();
        toast(`✅ ${rows.length} Links aus CSV importiert`);
      } catch (err) { toast('CSV-Import fehlgeschlagen: ' + err.message, true); }
      e.target.value = '';
    });

    // Backups laden, wenn Daten-Tab sichtbar wird
    onTabShown('data', renderBackups);

    $('#reset-btn').addEventListener('click', async () => {
      if (!confirm('Wirklich alles zurücksetzen? Das löscht alle Links und setzt das Profil zurück.')) return;
      try {
        await window.api.importData({
          version: 2,
          profile: { name: '@corneliusahner', handle: 'Cornelius Ahner', bio: 'Azubi, 21 Jahre alt', avatar: 'CA', avatar_url: null, theme: 'dark' },
          links: [
            { title: 'Instagram', subtitle: '@cornelius_0511', url: 'https://www.instagram.com/cornelius_0511/', icon: '📸', is_active: true, open_new: true },
            { title: 'GitHub', subtitle: 'Projekte auf Github', url: 'https://github.com/DerMinecrafter2020', icon: '💻', is_active: true, open_new: true },
            { title: 'Kontakt', subtitle: 'admin@derminecrafter2020.com', url: 'mailto:admin@derminecrafter2020.com', icon: '✉️', is_active: true, open_new: false },
          ]
        });
        await reloadAll();
        toast('🔄 Zurückgesetzt');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
  }

  async function loadDiscordSettings() {
    try {
      const s = await window.api.getAdminSettings();
      const form = $('#discord-form');
      if (!form) return;
      form.discord_webhook_enabled.checked = !!s.discord_webhook_enabled;
      form.discord_webhook_url.value = s.discord_webhook_url || '';
      form.discord_webhook_template.value = s.discord_webhook_template || '';
    } catch (err) {
      console.warn('[admin] Discord-Settings konnten nicht geladen werden:', err.message);
    }
  }

  async function loadAdminStatus() {
    const statusText = $('#admin-status-text');
    try {
      const res = await window.api.getAdminSettings();
      const s = res || {};
      const enabled = typeof s.admin_enabled === 'boolean' ? s.admin_enabled : true;
      if (statusText) {
        statusText.textContent = enabled
          ? '✅ Admin-Bereich ist aktiviert.'
          : '🔒 Admin-Bereich ist deaktiviert — nur dieser Status-Bildschirm ist verfuegbar.';
      }
      if (!enabled) document.body.classList.add('admin-locked');
    } catch (err) {
      if (statusText) statusText.textContent = 'Status konnte nicht geladen werden.';
    }
  }

  async function loadDbInfo() {
    const statusEl = $('#db-info-status');
    const listEl = $('#db-info-list');
    if (!statusEl || !listEl) return;
    try {
      const info = await window.api.getDbInfo();
      statusEl.textContent = `✅ Mit PostgreSQL-Datenbank verbunden (${info.tables} Tabellen)`;
      listEl.innerHTML = `
        <li>Datenbank: <code>${escapeHtml(info.name)}</code></li>
        <li>Version: ${escapeHtml(info.version)}</li>
        <li>Tabellen: ${info.tables}</li>
      `;
    } catch (err) {
      statusEl.textContent = '❌ Datenbank-Status konnte nicht geladen werden';
      listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
    }
  }

  async function loadServerInfo() {
    const statusEl = $('#server-info-status');
    const listEl = $('#server-info-list');
    if (!statusEl || !listEl) return;
    try {
      const res = await window.api.getServerInfo();
      const i = res.data || res;
      statusEl.textContent = `✅ Server läuft seit ${Math.floor(i.uptime)} Sekunden`;
      listEl.innerHTML = `
        <li>Version: <code>${escapeHtml(i.version)}</code></li>
        <li>Umgebung: ${escapeHtml(i.nodeEnv)}</li>
        <li>Links: ${i.links} · Klicks: ${i.clicks} · Kategorien: ${i.categories}</li>
        <li>API-Keys: ${i.api_keys} · Sessions: ${i.sessions}</li>
        <li>Datenbankgröße: ${escapeHtml(i.db_size)}</li>
      `;
    } catch (err) {
      statusEl.textContent = '❌ Server-Info konnte nicht geladen werden';
      listEl.innerHTML = `<li class="hint">${escapeHtml(err.message)}</li>`;
    }
  }

  function bindAuditLog() {
    const container = $('#audit-log-table');
    if (!container) return;
    async function render() {
      try {
        const rows = await window.api.getAuditLog();
        if (!rows.length) {
          container.innerHTML = `<p class="hint">Noch keine Einträge.</p>`;
          return;
        }
        const table = el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { text: 'Zeit' }),
            el('th', { text: 'Aktion' }),
            el('th', { text: 'Objekt' }),
            el('th', { text: 'Nutzer' }),
            el('th', { text: 'IP' })
          ))
        );
        const tbody = el('tbody');
        rows.forEach(r => {
          const time = new Date(r.created_at).toLocaleString('de-DE');
          tbody.appendChild(el('tr', {},
            el('td', { text: time }),
            el('td', { text: r.action }),
            el('td', { text: r.entity ? `${r.entity}${r.entity_id ? ':' + r.entity_id.slice(0, 8) : ''}` : '-' }),
            el('td', { text: r.user_email || 'System' }),
            el('td', { text: r.ip_address || '-' })
          ));
        });
        table.appendChild(tbody);
        container.replaceChildren(table);
      } catch (err) {
        container.innerHTML = `<p class="hint error">Fehler: ${escapeHtml(err.message)}</p>`;
      }
    }
    onTabShown('audit', render);
  }

  function bindSettings() {
    loadAdminStatus();
    loadDbInfo();
    loadServerInfo();
    loadDiscordSettings();

    $('#discord-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await window.api.saveAdminSettings({
          discord_webhook_enabled: fd.get('discord_webhook_enabled') === 'on',
          discord_webhook_url: fd.get('discord_webhook_url'),
          discord_webhook_template: fd.get('discord_webhook_template'),
        });
        toast('✅ Discord-Einstellungen gespeichert');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    $('#discord-test-btn')?.addEventListener('click', async () => {
      try {
        await window.api.testDiscordWebhook();
        toast('✅ Testnachricht an Discord gesendet');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    $('#change-password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const current = fd.get('currentPassword');
      const next = fd.get('newPassword');
      if (!current || !next || String(next).length < 8) {
        toast('Aktuelles und neues Passwort (min. 8 Zeichen) erforderlich', true);
        return;
      }
      try {
        await window.api.changePassword(current, next);
        e.target.reset();
        toast('✅ Passwort geändert');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    // --- 2FA & WebAuthn ---
    async function load2faStatus() {
      try {
        const { totp_enabled, webauthn_keys } = await window.api.get2faStatus();
        const badge = $('#totp-status-badge');
        const setupBtn = $('#totp-setup-btn');
        const disableBtn = $('#totp-disable-btn');
        
        if (totp_enabled) {
          badge.textContent = 'Aktiv';
          badge.classList.remove('off');
          badge.classList.add('on');
          setupBtn.hidden = true;
          disableBtn.hidden = false;
        } else {
          badge.textContent = 'Inaktiv';
          badge.classList.remove('on');
          badge.classList.add('off');
          setupBtn.hidden = false;
          disableBtn.hidden = true;
        }
        
        const list = $('#webauthn-list');
        list.innerHTML = '';
        if (!webauthn_keys || webauthn_keys.length === 0) {
          list.innerHTML = '<li><span class="hint">Keine Schlüssel registriert</span></li>';
        } else {
          webauthn_keys.forEach((k, idx) => {
            const li = document.createElement('li');
            li.innerHTML = `
              <span><strong>${escapeHtml(k.name || 'Security Key')}</strong> (Erstellt: ${escapeHtml(new Date(k.created_at).toLocaleDateString())})</span>
              <div>
                <button class="btn ghost sm rename-webauthn" data-id="${escapeHtml(k.id)}" data-name="${escapeHtml(k.name || '')}" style="margin-right: 8px;">Umbenennen</button>
                <button class="btn danger sm delete-webauthn" data-id="${escapeHtml(k.id)}">Löschen</button>
              </div>
            `;
            list.appendChild(li);
          });
        }
      } catch (err) {
        console.error('Failed to load 2FA status:', err);
      }
    }
    
    // Fragt das aktuelle Passwort in einem Dialog ab (maskiert, anders als prompt()).
    // Liefert das Passwort oder null bei Abbruch.
    function askPassword(text) {
      const dlg = $('#confirm-password-dialog');
      const form = $('#confirm-password-form');
      if (!dlg || !form) return Promise.resolve(null);
      $('#confirm-password-text').textContent = text;
      form.password.value = '';
      return new Promise((resolve) => {
        const listeners = new AbortController();
        const finish = (value) => {
          listeners.abort();
          form.password.value = '';
          if (dlg.open) dlg.close();
          resolve(value);
        };
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          finish(form.password.value || null);
        }, { signal: listeners.signal });
        $('#confirm-password-cancel')?.addEventListener('click', () => finish(null), { signal: listeners.signal });
        dlg.addEventListener('close', () => finish(null), { signal: listeners.signal });
        dlg.showModal();
        form.password.focus();
      });
    }

    $('#totp-setup-btn')?.addEventListener('click', async () => {
      const password = await askPassword('Zum Einrichten von TOTP bitte dein aktuelles Passwort eingeben.');
      if (!password) return;
      try {
        const data = await window.api.setupTotp(password);
        $('#totp-qrcode').src = data.qrcode;
        $('#totp-secret-text').textContent = data.secret;
        $('#totp-setup-container').hidden = false;
        $('#totp-setup-btn').hidden = true;
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
    
    $('#totp-cancel-btn')?.addEventListener('click', () => {
      $('#totp-setup-container').hidden = true;
      $('#totp-setup-btn').hidden = false;
    });
    
    $('#totp-verify-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = e.target.code.value;
      try {
        await window.api.verifyTotp(code);
        toast('TOTP erfolgreich aktiviert!');
        $('#totp-setup-container').hidden = true;
        load2faStatus();
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
    
    $('#totp-disable-btn')?.addEventListener('click', async () => {
      if (!confirm('Sicher, dass du TOTP deaktivieren willst?')) return;
      const password = await askPassword('Zum Deaktivieren von TOTP bitte dein aktuelles Passwort eingeben.');
      if (!password) return;
      try {
        await window.api.disableTotp(password);
        toast('TOTP deaktiviert.');
        load2faStatus();
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
    
    $('#webauthn-register-btn')?.addEventListener('click', async () => {
      const password = await askPassword('Zum Hinzufügen eines Security Keys bitte dein aktuelles Passwort eingeben.');
      if (!password) return;
      try {
        const options = await window.api.getWebauthnRegisterOptions(password);
        const { startRegistration } = window.SimpleWebAuthnBrowser;
        const authResp = await startRegistration(options);
        await window.api.verifyWebauthnRegister(authResp);
        toast('Schlüssel erfolgreich registriert!');
        load2faStatus();
      } catch (err) { 
        console.error(err);
        toast('Fehler bei der Registrierung: ' + err.message, true); 
      }
    });
    
    $('#webauthn-list')?.addEventListener('click', async (e) => {
      if (e.target.classList.contains('delete-webauthn')) {
        const id = e.target.dataset.id;
        if (!confirm('Diesen Schlüssel wirklich löschen?')) return;
        const password = await askPassword('Zum Löschen des Schlüssels bitte dein aktuelles Passwort eingeben.');
        if (!password) return;
        try {
          await window.api.deleteWebauthn(id, password);
          toast('Schlüssel gelöscht.');
          load2faStatus();
        } catch (err) { toast('Fehler: ' + err.message, true); }
      } else if (e.target.classList.contains('rename-webauthn')) {
        const id = e.target.dataset.id;
        const currentName = e.target.dataset.name || 'Security Key';
        const newName = prompt('Wie soll der Security Key heißen?', currentName);
        if (newName !== null && newName.trim() !== '') {
          try {
            await window.api.renameWebauthn(id, newName.trim());
            toast('Schlüssel umbenannt.');
            load2faStatus();
          } catch (err) { toast('Fehler: ' + err.message, true); }
        }
      }
    });
    
    // Initial call
    load2faStatus();

    loadAlertSettings();
    $('#alert-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const payload = {
        email_enabled: fd.get('email_enabled') === 'on',
        email_to: fd.get('email_to'),
        smtp_host: fd.get('smtp_host'),
        smtp_port: fd.get('smtp_port'),
        smtp_user: fd.get('smtp_user'),
        smtp_password: fd.get('smtp_password'),
        smtp_secure: fd.get('smtp_secure') === 'on',
        webhook_url: fd.get('webhook_url'),
        notify_login: fd.get('notify_login') === 'on',
        notify_backup_fail: fd.get('notify_backup_fail') === 'on',
        notify_password: fd.get('notify_password') === 'on',
      };
      try {
        await window.api.saveAlertSettings(payload);
        toast('✅ Alert-Einstellungen gespeichert');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });

    $('#alert-test-btn')?.addEventListener('click', async () => {
      try {
        const res = await window.api.testAlertSettings();
        toast(res.ok ? '✅ Testbenachrichtigung gesendet' : '⚠️ Test konnte nicht gesendet werden', !res.ok);
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
  }

  async function loadAlertSettings() {
    const form = $('#alert-form');
    if (!form) return;
    try {
      const s = await window.api.getAlertSettings();
      form.email_enabled.checked = !!s.email_enabled;
      form.email_to.value = s.email_to || '';
      form.smtp_host.value = s.smtp_host || '';
      form.smtp_port.value = s.smtp_port || 587;
      form.smtp_user.value = s.smtp_user || '';
      form.smtp_password.value = s.smtp_password || '';
      form.smtp_secure.checked = s.smtp_secure !== false;
      form.webhook_url.value = s.webhook_url || '';
      form.notify_login.checked = s.notify_login !== false;
      form.notify_backup_fail.checked = s.notify_backup_fail !== false;
      form.notify_password.checked = s.notify_password !== false;
    } catch (err) {
      console.warn('[admin] Alert-Settings konnten nicht geladen werden:', err.message);
    }
  }

  async function loadNavidromeSettings() {
    try {
      state.navidrome = await window.api.getNavidromeSettings();
      renderNavidromeForm();
      navidromeWizard?.updateView();
    } catch (err) {
      console.warn('[admin] Navidrome-Settings konnten nicht geladen werden:', err.message);
    }
  }

  window.renderMusicHistory = function renderMusicHistory(historyRes) {
    const list = $('#music-history-list');
    if (!list) return;
      if (!historyRes || historyRes.length === 0) {
        list.innerHTML = '<li class="hint" style="list-style: none;">Noch keine Songs im Verlauf.</li>';
        return;
      }
      
      list.replaceChildren();
      
      const renderItem = (item, groupLabel) => {
        const d = new Date(item.played_at);
        const timeStr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        
        const timeEl = el('div', { class: 'stat-counts' }, el('span', { class: 'stat-clicks' }, timeStr));
        if (groupLabel === 'Letzte 7 Tage' || groupLabel === 'Älter') {
          const dateStr = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
          timeEl.appendChild(el('span', { class: 'stat-unique' }, dateStr));
        }

        const icon = sourceIcon(item.source, 'history-source-icon');
        if (icon) icon.setAttribute('aria-label', `Quelle: ${MUSIC_SOURCES[item.source].name}`);
        return el('li', { class: 'stat-row' + (icon ? ' has-source' : '') },
          icon,
          el('div', { class: 'stat-info' },
            el('span', { class: 'stat-title', title: item.title }, item.title),
            el('span', { class: 'stat-url', title: item.artist || 'Unbekannt' }, item.artist || 'Unbekannt')
          ),
          timeEl
        );
      };

      const groups = {
        'Heute': [],
        'Gestern': [],
        'Letzte 7 Tage': [],
        'Älter': []
      };

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const lastWeek = new Date(today);
      lastWeek.setDate(lastWeek.getDate() - 7);

      historyRes.forEach(item => {
        const d = new Date(item.played_at);
        if (d >= today) groups['Heute'].push(item);
        else if (d >= yesterday) groups['Gestern'].push(item);
        else if (d >= lastWeek) groups['Letzte 7 Tage'].push(item);
        else groups['Älter'].push(item);
      });

      Object.entries(groups).forEach(([label, items]) => {
        if (items.length === 0) return;
        
        const header = el('div', { class: 'history-group-title', style: 'margin-top: 16px; margin-bottom: 8px; font-weight: 600; color: var(--text-dim); font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;' }, label);
        list.appendChild(header);
        
        // Show only the first 5 in the group directly, hide the rest if there are too many (e.g., > 10)
        // But for grouped view, usually showing all in the group is fine, let's limit it to 10 per group
        const visibleItems = items.slice(0, 10);
        visibleItems.forEach(item => list.appendChild(renderItem(item, label)));
        
        if (items.length > 10) {
          const remainingItems = items.slice(10);
          const expandedList = el('ul', { class: 'stats-list history-list-expanded' });
          remainingItems.forEach(item => expandedList.appendChild(renderItem(item, label)));
          
          const details = el('details', { class: 'history-details' },
            el('summary', {}, `${remainingItems.length} weitere anzeigen...`),
            expandedList
          );
          list.appendChild(details);
        }
    });
  };

  function renderNavidromeForm() {
    const form = $('#navidrome-form');
    if (!form) return;
    const cfg = state.navidrome || { enabled: false, url: '', username: '', poll_interval_sec: 30 };
    form.enabled.checked = !!cfg.enabled;
    form.url.value = cfg.url || '';
    form.username.value = cfg.username || '';
    form.password.value = '';
    form.pollIntervalSec.value = cfg.poll_interval_sec || 30;
  }

  function bindNavidrome() {
    const form = $('#navidrome-form');
    if (!form || !window.api) return;
    initNavidromeWizard();
    loadNavidromeSettings();
    initAdminNowPlaying();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = (form.url.value || '').trim();
      const username = (form.username.value || '').trim();
      const password = form.password.value;
      const poll = parseInt(form.pollIntervalSec.value || '30', 10) || 30;
      if (form.enabled.checked && (!url || !username)) {
        toast('URL und Username sind Pflicht, wenn der Player aktiviert ist', true);
        return;
      }
      if (form.enabled.checked && !password && !(state.navidrome?.username)) {
        toast('Bitte Passwort eingeben oder Player deaktivieren', true);
        return;
      }
      const cfg = {
        enabled: !!form.enabled.checked,
        url,
        username,
        password,
        poll_interval_sec: Math.min(600, Math.max(5, poll))
      };
      try {
        await window.api.saveNavidromeSettings(cfg);
        state.navidrome = await window.api.getNavidromeSettings();
        renderNavidromeForm();
        toast('🎵 Navidrome-Einstellungen gespeichert');
      } catch (err) {
        toast('Fehler: ' + (err.message || 'Speichern fehlgeschlagen'), true);
      }
    });

    $('#navidrome-test-btn')?.addEventListener('click', async () => {
      const status = $('#navidrome-status');
      status.textContent = 'Pruefe…';
      try {
        const s = await window.api.testNavidromeConnection();
        if (!s?.connected) {
          status.textContent = '❌ ' + (s?.error || 'Navidrome nicht konfiguriert oder nicht erreichbar');
          return;
        }
        status.textContent = s.playing
          ? `✅ Verbunden — spielt: ${s.title} (${s.artist})`
          : '✅ Verbunden — momentan läuft nichts';
      } catch (err) { status.textContent = '❌ ' + (err.message || 'Netzwerkfehler'); }
    });

    $('#navidrome-discord-test-btn')?.addEventListener('click', async () => {
      const status = $('#navidrome-status');
      status.textContent = 'Sende Discord-Test…';
      try {
        await window.api.testNavidromeDiscordWebhook();
        status.textContent = '✅ Discord-Test gesendet (prüfe deinen Kanal)';
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Netzwerkfehler');
      }
    });
  }

  async function loadMusicAssistantSettings() {
    try {
      state.musicassistant = await window.api.getMusicAssistantSettings();
      renderMusicAssistantForm();
      maWizard?.updateView();
      // Benutzerliste nur fuer das Formular laden (der Assistent laedt sie selbst in Schritt 3)
      if (state.musicassistant?.url && musicAssistantConfigured()) await loadMusicAssistantUsers();
    } catch (err) {
      console.warn('[admin] Music Assistant-Settings konnten nicht geladen werden:', err.message);
    }
  }

  function renderMusicAssistantForm() {
    const form = $('#musicassistant-form');
    if (!form) return;
    const cfg = state.musicassistant || { enabled: false, url: '' };
    form.enabled.checked = !!cfg.enabled;
    form.url.value = cfg.url || '';
    form.token.value = '';
    renderMusicAssistantUsers(state.musicassistantUsers, cfg.user_id || '');
  }

  function renderMusicAssistantUsers(users, selectedUserId) {
    const select = $('#musicassistant-form select[name="userId"]');
    if (!select) return;

    const selectedId = selectedUserId ? String(selectedUserId) : '';
    const knownIds = new Set();
    const options = [new Option('Benutzer laden und auswählen …', '')];

    for (const user of users) {
      if (!user || !user.user_id) continue;
      const userId = String(user.user_id);
      knownIds.add(userId);
      const displayName = user.name && user.username && user.username !== user.name
        ? `${user.name} (${user.username})`
        : (user.name || user.username || userId);
      const currentLabel = user.is_current ? ' (API-Token-Benutzer)' : '';
      const filterLabel = user.has_player_filter ? '' : ' (keine Player-Beschränkung)';
      const name = `${displayName}${currentLabel}${filterLabel}`;
      options.push(new Option(name, userId));
    }

    if (selectedId && !knownIds.has(selectedId)) {
      options.push(new Option(`Gespeicherter Benutzer (${selectedId}) – erneut laden`, selectedId));
    }

    select.replaceChildren(...options);
    select.value = selectedId;
  }

  async function loadMusicAssistantUsers() {
    const form = $('#musicassistant-form');
    const status = $('#musicassistant-status');
    const button = $('#musicassistant-load-users-btn');
    if (!form || !status || !state.musicassistant?.url) {
      if (status) status.textContent = 'Speichere zuerst die Music Assistant URL.';
      return;
    }
    if (form.url.value.trim() !== state.musicassistant.url || form.token.value) {
      status.textContent = 'Speichere zuerst die geänderte URL oder das Token.';
      return;
    }

    const savedSelection = form.userId.value || state.musicassistant.user_id || '';
    if (button) button.disabled = true;
    status.textContent = 'Lade Benutzer …';
    try {
      const users = await window.api.getMusicAssistantUsers();
      state.musicassistantUsers = Array.isArray(users) ? users : [];
      const selectedId = savedSelection || state.musicassistantUsers.find(user => user.is_current)?.user_id || '';
      renderMusicAssistantUsers(state.musicassistantUsers, selectedId);
      const selectedUser = state.musicassistantUsers.find(user => String(user.user_id) === String(selectedId));
      if (!state.musicassistantUsers.length) {
        status.textContent = 'Keine Benutzer gefunden.';
      } else if (savedSelection && !selectedUser) {
        status.textContent = 'Der gespeicherte Music-Assistant-Benutzer wurde nicht gefunden. Bitte wähle einen verfügbaren Benutzer.';
      } else if (selectedUser && !selectedUser.has_player_filter) {
        status.textContent = 'Benutzer geladen, aber ohne Player-Beschränkung. Beschränke ihn in Music Assistant auf deine Player.';
      } else if (selectedUser?.is_current) {
        status.textContent = 'Der Benutzer des API-Tokens ist vorausgewählt. Prüfe die Auswahl und speichere.';
      } else {
        status.textContent = `${state.musicassistantUsers.length} Benutzer geladen. Wähle deinen Benutzer und speichere.`;
      }
    } catch (err) {
      status.textContent = '❌ ' + (err.message || 'Benutzer konnten nicht geladen werden');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindMusicAssistant() {
    const form = $('#musicassistant-form');
    if (!form || !window.api) return;
    initMusicAssistantWizard();
    loadMusicAssistantSettings();

    $('#musicassistant-load-users-btn')?.addEventListener('click', loadMusicAssistantUsers);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = (form.url.value || '').trim();
      const token = form.token.value;
      if (form.enabled.checked && !url) {
        toast('URL ist Pflicht, wenn der Player aktiviert ist', true);
        return;
      }
      const settingsChanged = url !== (state.musicassistant?.url || '') || !!token;
      const cfg = {
        enabled: !!form.enabled.checked,
        url,
        token,
        userId: form.userId.value
      };
      try {
        await window.api.saveMusicAssistantSettings(cfg);
        state.musicassistant = await window.api.getMusicAssistantSettings();
        if (settingsChanged) state.musicassistantUsers = [];
        renderMusicAssistantForm();
        toast('🎵 Music Assistant-Einstellungen gespeichert');
        const selectedUser = state.musicassistantUsers.find(user => String(user.user_id) === String(cfg.userId));
        const status = $('#musicassistant-status');
        if (!cfg.enabled) {
          status.textContent = '';
        } else if (!cfg.userId) {
          status.textContent = 'Einstellungen gespeichert. Lade die MA-Benutzer und wähle deinen Benutzer.';
        } else if (settingsChanged) {
          status.textContent = 'Einstellungen gespeichert. Lade die Benutzer erneut, um die Auswahl zu prüfen.';
        } else if (!selectedUser) {
          status.textContent = 'Der Benutzer wurde gespeichert, ist aber nicht in der geladenen Liste. Lade die Benutzer erneut.';
        } else if (!selectedUser.has_player_filter) {
          status.textContent = 'Der Benutzer hat keine Player-Beschränkung. Beschränke ihn in Music Assistant auf deine Player.';
        } else {
          status.textContent = '';
        }
      } catch (err) {
        toast('Fehler: ' + (err.message || 'Speichern fehlgeschlagen'), true);
      }
    });
  }

  // ---------- Einrichtungsassistenten (Spotify, Navidrome, Music Assistant) ----------
  // Gemeinsame Logik: Fortschrittsanzeige, Schritte, Zurueck/Weiter, "Manuell einrichten".
  // Der Assistent erscheint, solange der Dienst nicht eingerichtet ist (isConfigured), sonst das
  // Formular. Der Fortschritt liegt nur im Browser (localStorage, reiner Komfort).
  //
  // opts: { name, root, form, startButton, steps: [{ label, next, onNext, onEnter, persist }],
  //         isConfigured(), firstStep() }
  //   next: Beschriftung des Weiter-Knopfs (null = Knopf ausblenden, der Schritt hat eine eigene Aktion)
  //   onNext: async () => true/false (false = im Schritt bleiben)
  //   persist: false = diesen Schritt nicht als Fortschritt merken
  function createSetupWizard(opts) {
    const root = $(opts.root);
    const form = $(opts.form);
    if (!root || !form) return null;
    const total = opts.steps.length;
    const storeKey = `openweb-${opts.name}-wizard`;
    const w = { step: 1, forced: false, finishing: false, ready: false, stepSet: false };

    const prefs = {
      read() { try { return JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch { return {}; } },
      write(p) { try { localStorage.setItem(storeKey, JSON.stringify(p)); } catch { /* privat/blockiert: egal */ } },
      update(patch) { this.write({ ...this.read(), ...patch }); },
    };

    const progress = root.querySelector('.wizard-progress');
    progress.style.setProperty('--wizard-steps', String(total));
    progress.replaceChildren(...opts.steps.map((s, i) => el('li', { 'data-step': String(i + 1) },
      el('button', { type: 'button', class: 'wizard-dot', 'data-goto': String(i + 1), 'aria-label': `Schritt ${i + 1}: ${s.label}` }, String(i + 1)),
      el('span', { class: 'wizard-label' }, s.label))));

    const nav = {
      back: root.querySelector('.wizard-back'),
      next: root.querySelector('.wizard-next'),
      skip: root.querySelector('.wizard-skip'),
    };

    function render() {
      const step = w.step;
      progress.querySelectorAll('li').forEach((li) => {
        const n = Number(li.dataset.step);
        li.classList.toggle('current', n === step);
        li.classList.toggle('done', n < step);
        const dot = li.querySelector('.wizard-dot');
        dot.disabled = !(n < step && step !== total);
        if (n === step) dot.setAttribute('aria-current', 'step'); else dot.removeAttribute('aria-current');
        dot.textContent = n < step ? '✓' : String(n);
      });
      root.querySelectorAll('.wizard-step').forEach((sec) => { sec.hidden = Number(sec.dataset.step) !== step; });
      const cfg = opts.steps[step - 1];
      nav.back.hidden = step === 1 || step === total;
      nav.next.hidden = cfg.next === null;
      nav.next.textContent = cfg.next || (step === total ? 'Fertig' : 'Weiter');
      nav.skip.hidden = step === total;
      nav.skip.textContent = opts.isConfigured() ? 'Assistent schließen' : 'Manuell einrichten';
      cfg.render?.();
    }

    function goTo(step, { focus = true } = {}) {
      w.step = Math.min(total, Math.max(1, step));
      const cfg = opts.steps[w.step - 1];
      if (w.step < total && cfg.persist !== false) prefs.update({ step: w.step });
      render();
      cfg.onEnter?.();
      if (focus && !root.hidden) {
        const heading = root.querySelector(`.wizard-step[data-step="${w.step}"] h4`);
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
      }
    }

    function updateView() {
      // Beim ersten Anzeigen mit dem passenden Startschritt beginnen (Daten sind jetzt geladen)
      if (!w.ready && !w.stepSet) w.step = Math.min(total, Math.max(1, opts.firstStep()));
      w.ready = true;
      const show = w.finishing || w.forced || (!opts.isConfigured() && !prefs.read().manual);
      const wasHidden = root.hidden;
      root.hidden = !show;
      form.hidden = show;
      if (show && wasHidden) goTo(w.step, { focus: false });
      else if (show) render();
    }

    nav.next.addEventListener('click', async () => {
      const cfg = opts.steps[w.step - 1];
      if (cfg.onNext) {
        nav.next.disabled = true;
        let ok = false;
        try { ok = await cfg.onNext(); } finally { nav.next.disabled = false; }
        if (!ok) return;
      }
      if (w.step === total) {
        w.finishing = false;
        w.forced = false;
        prefs.write({});
        updateView();
        return;
      }
      goTo(w.step + 1);
    });
    nav.back.addEventListener('click', () => goTo(w.step - 1));
    progress.addEventListener('click', (e) => {
      const dot = e.target.closest('.wizard-dot');
      const target = Number(dot?.dataset.goto);
      if (target && target < w.step && w.step !== total) goTo(target);
    });
    nav.skip.addEventListener('click', () => {
      w.forced = false;
      w.finishing = false;
      prefs.update({ manual: true });
      updateView();
    });
    $(opts.startButton)?.addEventListener('click', () => {
      prefs.update({ manual: false });
      w.forced = true;
      w.finishing = false;
      w.step = opts.firstStep();
      root.hidden = true; // damit updateView den Schritt neu betritt
      updateView();
    });

    return {
      get step() { return w.step; },
      prefs,
      goTo,
      updateView,
      // Startschritt setzen (vor dem ersten updateView)
      setStep(step) { w.step = Math.min(total, Math.max(1, step)); w.stepSet = true; },
      // gemerkter Schritt (1..max), sonst 1
      savedStep(max) {
        const n = Number(prefs.read().step);
        return n >= 1 && n <= max ? n : 1;
      },
      // Abschluss-Schritt anzeigen (z. B. direkt nach erfolgreicher Einrichtung)
      finish() {
        w.finishing = true;
        w.stepSet = true;
        w.step = total;
        root.hidden = true;
        updateView();
      },
      // Assistent auch bei "Manuell einrichten" wieder anzeigen (z. B. nach Fehler-Rueckkehr)
      reopen(step) {
        prefs.update({ manual: false });
        w.step = step;
        w.stepSet = true;
      },
      // Assistent bei einem Schritt oeffnen, auch wenn der Dienst schon eingerichtet ist
      open(step) {
        prefs.update({ manual: false });
        w.forced = true;
        w.finishing = false;
        w.step = step;
        w.stepSet = true;
        root.hidden = true;
        updateView();
      },
    };
  }

  // Einheitliche Statuszeilen in den Assistenten
  function wizardCheck(elOrSel, text, kind) {
    const node = typeof elOrSel === 'string' ? $(elOrSel) : elOrSel;
    if (!node) return;
    node.className = 'wizard-check' + (kind ? ' is-' + kind : '');
    node.textContent = text || '';
  }

  function isHttpUrl(value) {
    try {
      const u = new URL(value);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
      return false;
    }
  }

  async function sendWizardDiscordTest(source) {
    try {
      await window.api.testNavidromeDiscordWebhook(source);
      toast('✅ Discord-Test gesendet (prüfe deinen Kanal)');
    } catch (err) {
      toast('Discord-Test: ' + (err.message || 'fehlgeschlagen'), true);
    }
  }

  function describePlaying(s, emptyHint) {
    return s.playing
      ? `Gerade läuft: ${s.title}${s.artist ? ' – ' + s.artist : ''}.`
      : emptyHint;
  }

  // ---------- Navidrome-Assistent ----------
  let navidromeWizard = null;

  function navidromeConfigured() {
    const c = state.navidrome || {};
    return !!(c.enabled && c.url && c.username && c.has_password);
  }

  async function runNavidromeWizardTest() {
    const result = $('#navidrome-wizard-result');
    wizardCheck(result, 'Prüfe die Verbindung …');
    try {
      const s = await window.api.testNavidromeConnection();
      if (s?.connected) {
        wizardCheck(result, `✅ Verbunden mit Navidrome als „${state.navidrome?.username || ''}“. ` +
          describePlaying(s, 'Gerade läuft nichts – starte einen Song in Navidrome und klicke auf „Erneut prüfen“.'), 'ok');
      } else {
        wizardCheck(result, '⚠️ ' + (s?.error || 'Navidrome ist nicht erreichbar.'), 'warn');
      }
    } catch (err) {
      wizardCheck(result, '⚠️ ' + (err.message || 'Netzwerkfehler'), 'warn');
    }
  }

  function initNavidromeWizard() {
    navidromeWizard = createSetupWizard({
      name: 'navidrome',
      root: '#navidrome-wizard',
      form: '#navidrome-form',
      startButton: '#navidrome-wizard-start-btn',
      isConfigured: navidromeConfigured,
      firstStep: () => (navidromeConfigured() ? 1 : navidromeWizard.savedStep(2)),
      steps: [
        {
          label: 'Server',
          next: 'Prüfen & weiter',
          onEnter() {
            const input = $('#navidrome-wizard-url');
            if (!input.value) input.value = navidromeWizard.prefs.read().url || state.navidrome?.url || '';
          },
          async onNext() {
            const url = $('#navidrome-wizard-url').value.trim().replace(/\/+$/, '');
            const check = '#navidrome-wizard-url-check';
            if (!isHttpUrl(url)) {
              wizardCheck(check, '⚠️ Bitte eine vollständige Adresse mit http:// oder https:// eingeben.', 'warn');
              return false;
            }
            wizardCheck(check, 'Prüfe den Server …');
            try {
              const s = await window.api.testNavidromeConnection({ url, probe: true });
              if (!s?.connected) {
                wizardCheck(check, '⚠️ ' + (s?.error || 'Server nicht erreichbar.'), 'warn');
                return false;
              }
            } catch (err) {
              wizardCheck(check, '⚠️ ' + (err.message || 'Netzwerkfehler'), 'warn');
              return false;
            }
            wizardCheck(check, '');
            navidromeWizard.prefs.update({ url });
            return true;
          },
        },
        {
          label: 'Anmeldung',
          next: 'Prüfen & speichern',
          onEnter() {
            const user = $('#navidrome-wizard-username');
            if (!user.value && state.navidrome?.username) user.value = state.navidrome.username;
            $('#navidrome-wizard-password').placeholder = state.navidrome?.has_password
              ? '•••••••• (gespeichert – leer lassen zum Behalten)'
              : 'Passwort deines Navidrome-Kontos';
          },
          async onNext() {
            const url = navidromeWizard.prefs.read().url || state.navidrome?.url || '';
            const userInput = $('#navidrome-wizard-username');
            const passInput = $('#navidrome-wizard-password');
            const username = userInput.value.trim();
            const password = passInput.value;
            const check = '#navidrome-wizard-login-check';
            if (!username) {
              wizardCheck(check, '⚠️ Bitte den Benutzernamen eingeben.', 'warn');
              userInput.focus();
              return false;
            }
            const keepPassword = !password && state.navidrome?.has_password &&
              username === state.navidrome?.username && url === state.navidrome?.url;
            if (!password && !keepPassword) {
              wizardCheck(check, '⚠️ Bitte das Passwort eingeben.', 'warn');
              passInput.focus();
              return false;
            }
            wizardCheck(check, 'Melde mich bei Navidrome an …');
            try {
              const s = await window.api.testNavidromeConnection({ url, username, password });
              if (!s?.connected) {
                wizardCheck(check, '⚠️ ' + (s?.error || 'Anmeldung fehlgeschlagen.'), 'warn');
                return false;
              }
              await window.api.saveNavidromeSettings({
                enabled: true,
                url,
                username,
                password,
                poll_interval_sec: state.navidrome?.poll_interval_sec || 30,
              });
              passInput.value = '';
              state.navidrome = await window.api.getNavidromeSettings();
              renderNavidromeForm();
              wizardCheck(check, '');
              return true;
            } catch (err) {
              wizardCheck(check, '⚠️ ' + (err.message || 'Speichern fehlgeschlagen'), 'warn');
              return false;
            }
          },
        },
        { label: 'Fertig', next: 'Fertig', persist: false, onEnter: runNavidromeWizardTest },
      ],
    });
    if (!navidromeWizard) return;
    $('#navidrome-wizard-retest')?.addEventListener('click', runNavidromeWizardTest);
    $('#navidrome-wizard-discord')?.addEventListener('click', () => sendWizardDiscordTest('navidrome'));
  }

  // ---------- Music-Assistant-Assistent ----------
  let maWizard = null;

  function musicAssistantConfigured() {
    const c = state.musicassistant || {};
    return !!(c.enabled && c.url && c.user_id);
  }

  async function runMusicAssistantWizardTest() {
    const result = $('#musicassistant-wizard-result');
    wizardCheck(result, 'Prüfe die Verbindung …');
    try {
      const s = await window.api.testMusicAssistantConnection();
      if (s?.connected) {
        const user = state.musicassistantUsers.find((u) => String(u.user_id) === String(state.musicassistant?.user_id));
        const who = user ? ` für „${user.name}“` : '';
        wizardCheck(result, `✅ Verbunden${who}. ` +
          describePlaying(s, 'Gerade läuft nichts – starte Musik auf einem deiner Player und klicke auf „Erneut prüfen“.'), 'ok');
      } else {
        wizardCheck(result, '⚠️ ' + (s?.error || 'Music Assistant ist nicht erreichbar.'), 'warn');
      }
    } catch (err) {
      wizardCheck(result, '⚠️ ' + (err.message || 'Netzwerkfehler'), 'warn');
    }
  }

  function renderWizardUserSelect() {
    const select = $('#musicassistant-wizard-user');
    const check = '#musicassistant-wizard-user-check';
    const users = state.musicassistantUsers || [];
    const selected = select.value || String(state.musicassistant?.user_id || '') ||
      String(users.find((u) => u.is_current)?.user_id || '');
    const options = [new Option(users.length ? 'Bitte auswählen …' : 'Keine Benutzer gefunden', '')];
    for (const u of users) {
      const name = u.name && u.username && u.username !== u.name ? `${u.name} (${u.username})` : (u.name || u.username || u.user_id);
      const flags = [u.is_current ? 'Token-Benutzer' : '', u.has_player_filter ? '' : 'keine Player zugewiesen'].filter(Boolean);
      options.push(new Option(flags.length ? `${name} – ${flags.join(', ')}` : name, String(u.user_id)));
    }
    select.replaceChildren(...options);
    select.value = users.some((u) => String(u.user_id) === selected) ? selected : '';
    const user = users.find((u) => String(u.user_id) === select.value);
    if (user && !user.has_player_filter) {
      wizardCheck(check, '⚠️ Diesem Benutzer sind in Music Assistant keine Player zugewiesen. Weise ihm dort in der Benutzerverwaltung deine eigenen Player zu – sonst zeigt OpenWeb vorsichtshalber nichts an.', 'warn');
    } else {
      wizardCheck(check, '');
    }
  }

  function initMusicAssistantWizard() {
    maWizard = createSetupWizard({
      name: 'musicassistant',
      root: '#musicassistant-wizard',
      form: '#musicassistant-form',
      startButton: '#musicassistant-wizard-start-btn',
      isConfigured: musicAssistantConfigured,
      firstStep: () => {
        if (musicAssistantConfigured()) return 1;
        // Adresse gespeichert -> Benutzer waehlen, sonst gemerkter Schritt
        if (state.musicassistant?.enabled && state.musicassistant?.url) return 3;
        return maWizard.savedStep(2);
      },
      steps: [
        {
          label: 'Server',
          next: 'Prüfen & weiter',
          onEnter() {
            const input = $('#musicassistant-wizard-url');
            if (!input.value) input.value = maWizard.prefs.read().url || state.musicassistant?.url || '';
          },
          async onNext() {
            const url = $('#musicassistant-wizard-url').value.trim().replace(/\/+$/, '');
            const check = '#musicassistant-wizard-url-check';
            if (!isHttpUrl(url)) {
              wizardCheck(check, '⚠️ Bitte eine vollständige Adresse mit http:// oder https:// eingeben.', 'warn');
              return false;
            }
            wizardCheck(check, 'Prüfe den Server …');
            try {
              const s = await window.api.testMusicAssistantConnection({ url, probe: true });
              // "Token noetig" heisst: Server gefunden – der Token folgt im naechsten Schritt
              if (!s?.connected && s?.code !== 'auth') {
                wizardCheck(check, '⚠️ ' + (s?.error || 'Server nicht erreichbar.'), 'warn');
                return false;
              }
            } catch (err) {
              wizardCheck(check, '⚠️ ' + (err.message || 'Netzwerkfehler'), 'warn');
              return false;
            }
            wizardCheck(check, '');
            maWizard.prefs.update({ url });
            return true;
          },
        },
        {
          label: 'Token',
          next: 'Prüfen & speichern',
          onEnter() {
            $('#musicassistant-wizard-token').placeholder = state.musicassistant?.has_token
              ? '•••••••• (gespeichert – leer lassen zum Behalten)'
              : 'Langlebiger Token aus Music Assistant';
          },
          async onNext() {
            const url = maWizard.prefs.read().url || state.musicassistant?.url || '';
            const tokenInput = $('#musicassistant-wizard-token');
            const token = tokenInput.value.trim();
            const check = '#musicassistant-wizard-token-check';
            wizardCheck(check, 'Prüfe den Zugriff …');
            try {
              const s = await window.api.testMusicAssistantConnection({ url, token });
              if (!s?.connected) {
                wizardCheck(check, '⚠️ ' + (s?.error || 'Zugriff fehlgeschlagen.'), 'warn');
                return false;
              }
              await window.api.saveMusicAssistantSettings({
                enabled: true,
                url,
                token,
                userId: state.musicassistant?.user_id || '',
              });
              tokenInput.value = '';
              state.musicassistant = await window.api.getMusicAssistantSettings();
              state.musicassistantUsers = [];
              renderMusicAssistantForm();
              wizardCheck(check, '');
              return true;
            } catch (err) {
              wizardCheck(check, '⚠️ ' + (err.message || 'Speichern fehlgeschlagen'), 'warn');
              return false;
            }
          },
        },
        {
          label: 'Benutzer',
          next: 'Speichern & weiter',
          async onEnter() {
            const check = '#musicassistant-wizard-user-check';
            const select = $('#musicassistant-wizard-user');
            select.replaceChildren(new Option('Benutzer werden geladen …', ''));
            wizardCheck(check, '');
            try {
              const users = await window.api.getMusicAssistantUsers();
              state.musicassistantUsers = Array.isArray(users) ? users : [];
              renderWizardUserSelect();
              renderMusicAssistantUsers(state.musicassistantUsers, state.musicassistant?.user_id || '');
            } catch (err) {
              select.replaceChildren(new Option('Benutzer konnten nicht geladen werden', ''));
              wizardCheck(check, '⚠️ ' + (err.message || 'Benutzer konnten nicht geladen werden') + ' Der Token braucht die Berechtigung, Benutzer zu lesen – erstelle ihn mit einem Administrator-Konto.', 'warn');
            }
          },
          async onNext() {
            const userId = $('#musicassistant-wizard-user').value;
            const check = '#musicassistant-wizard-user-check';
            if (!userId) {
              wizardCheck(check, '⚠️ Bitte wähle deinen Benutzer aus.', 'warn');
              return false;
            }
            try {
              await window.api.saveMusicAssistantSettings({
                enabled: true,
                url: state.musicassistant?.url || '',
                token: '',
                userId,
              });
              state.musicassistant = await window.api.getMusicAssistantSettings();
              renderMusicAssistantForm();
              return true;
            } catch (err) {
              wizardCheck(check, '⚠️ ' + (err.message || 'Speichern fehlgeschlagen'), 'warn');
              return false;
            }
          },
        },
        { label: 'Fertig', next: 'Fertig', persist: false, onEnter: runMusicAssistantWizardTest },
      ],
    });
    if (!maWizard) return;
    $('#musicassistant-wizard-user')?.addEventListener('change', renderWizardUserSelect);
    $('#musicassistant-wizard-retest')?.addEventListener('click', runMusicAssistantWizardTest);
    $('#musicassistant-wizard-discord')?.addEventListener('click', () => sendWizardDiscordTest('musicassistant'));
  }

  // ---------- Spotify ----------
  // Ist Spotify noch nicht verbunden, fuehrt der Assistent in 5 Schritten durch die Einrichtung.
  const SPOTIFY_ID_RE = /^[A-Za-z0-9]{16,64}$/;
  const SPOTIFY_RETURN_MESSAGES = {
    connected: ['✅ Mit Spotify verbunden', false],
    denied: ['Die Anmeldung bei Spotify wurde abgebrochen. Du kannst es jederzeit erneut versuchen.', true],
    invalid: ['Die Spotify-Anmeldung ist abgelaufen oder ungültig. Bitte erneut verbinden.', true],
    error: ['Spotify hat die Anmeldung abgelehnt. Prüfe Redirect-URI, Client-ID und Client-Secret.', true],
  };
  let spotifyWizard = null;
  let spotifyReturnResult = null;

  function spotifyHasCredentials() {
    return !!(state.spotify?.client_id && state.spotify?.has_client_secret);
  }

  function renderSpotifyRedirectCheck() {
    const cfg = state.spotify || {};
    $('#spotify-wizard-redirect').textContent = cfg.redirect_uri || '–';
    const check = '#spotify-wizard-redirect-check';
    if (cfg.redirect_uri_localhost) {
      wizardCheck(check, '⚠️ Spotify akzeptiert „localhost“ nicht. Rufe den Admin über 127.0.0.1 auf oder setze APP_URL in der .env auf deine öffentliche Domain.', 'warn');
    } else if (!cfg.redirect_uri_secure) {
      wizardCheck(check, '⚠️ Spotify verlangt https. Setze APP_URL in der .env auf deine https-Adresse (z. B. https://links.deine-domain.de) und starte OpenWeb neu.', 'warn');
    } else if (!cfg.redirect_uri_configured) {
      wizardCheck(check, '⚠️ APP_URL ist nicht gesetzt – die Adresse wurde aus dem aktuellen Aufruf abgeleitet. Setze APP_URL in der .env, damit sie sich nicht ändert.', 'warn');
    } else {
      wizardCheck(check, '✅ Die Adresse kommt aus APP_URL und nutzt https.', 'ok');
    }
  }

  async function saveSpotifyWizardCredentials() {
    const idInput = $('#spotify-wizard-client-id');
    const secretInput = $('#spotify-wizard-client-secret');
    const check = '#spotify-wizard-cred-check';
    const clientId = idInput.value.trim();
    const clientSecret = secretInput.value.trim();
    const fail = (msg, field) => {
      wizardCheck(check, '⚠️ ' + msg, 'warn');
      field?.focus();
      return false;
    };
    if (!SPOTIFY_ID_RE.test(clientId)) return fail('Die Client-ID besteht aus 32 Buchstaben und Ziffern – bitte vollständig aus dem Dashboard kopieren.', idInput);
    const keepSecret = !clientSecret && state.spotify?.has_client_secret && clientId === state.spotify?.client_id;
    if (!keepSecret && !SPOTIFY_ID_RE.test(clientSecret)) return fail('Das Client-Secret besteht aus 32 Buchstaben und Ziffern – klicke im Dashboard auf „View client secret“ und kopiere es.', secretInput);
    if (clientSecret && clientSecret === clientId) return fail('Client-ID und Client-Secret sind identisch – vermutlich wurde zweimal dasselbe kopiert.', secretInput);
    try {
      state.spotify = await window.api.saveSpotifySettings({ enabled: true, clientId, clientSecret });
      secretInput.value = '';
      wizardCheck(check, '');
      renderSpotifyForm();
      spotifyReturnResult = null;
      return true;
    } catch (err) {
      return fail(err.message || 'Speichern fehlgeschlagen');
    }
  }

  async function startSpotifyLogin(statusEl) {
    try {
      const { url } = await window.api.startSpotifyAuthorization();
      if (typeof url !== 'string' || !url.startsWith('https://accounts.spotify.com/')) throw new Error('Ungültige Anmelde-URL');
      location.href = url;
    } catch (err) {
      if (statusEl) statusEl.textContent = '❌ ' + (err.message || 'Anmeldung konnte nicht gestartet werden');
    }
  }

  async function runSpotifyWizardTest() {
    const result = $('#spotify-wizard-result');
    wizardCheck(result, 'Prüfe die Verbindung …');
    try {
      const s = await window.api.testSpotifyConnection();
      if (s?.connected) {
        const who = s.account ? ` als „${s.account}“` : '';
        wizardCheck(result, `✅ Verbunden${who}. ` +
          describePlaying(s, 'Gerade läuft nichts – starte einen Song auf Spotify und klicke auf „Erneut prüfen“.'), 'ok');
        await loadSpotifySettings(false);
      } else {
        wizardCheck(result, '⚠️ ' + (s?.error || 'Spotify ist noch nicht verbunden.'), 'warn');
      }
    } catch (err) {
      wizardCheck(result, '⚠️ ' + (err.message || 'Netzwerkfehler'), 'warn');
    }
  }

  function initSpotifyWizard() {
    spotifyWizard = createSetupWizard({
      name: 'spotify',
      root: '#spotify-wizard',
      form: '#spotify-form',
      startButton: '#spotify-wizard-start-btn',
      isConfigured: () => !!state.spotify?.connected,
      firstStep: () => {
        if (state.spotify?.connected) return 1;
        if (spotifyHasCredentials()) return 4;
        return spotifyWizard.savedStep(3);
      },
      steps: [
        { label: 'App anlegen', next: 'App ist angelegt – weiter' },
        { label: 'Redirect-URI', next: 'Eingetragen – weiter', render: renderSpotifyRedirectCheck },
        {
          label: 'Zugangsdaten',
          next: 'Speichern & weiter',
          onEnter() {
            const idInput = $('#spotify-wizard-client-id');
            if (!idInput.value && state.spotify?.client_id) idInput.value = state.spotify.client_id;
            $('#spotify-wizard-client-secret').placeholder = state.spotify?.has_client_secret
              ? '•••••••• (gespeichert – leer lassen zum Behalten)'
              : 'Client-Secret aus dem Dashboard';
          },
          onNext: saveSpotifyWizardCredentials,
        },
        {
          label: 'Verbinden',
          next: null,
          persist: false,
          render() {
            const ret = spotifyReturnResult;
            const showError = !!ret && ret !== 'connected';
            $('#spotify-wizard-error').hidden = !showError;
            if (showError) $('#spotify-wizard-error-text').textContent = SPOTIFY_RETURN_MESSAGES[ret]?.[0] || 'Die Anmeldung ist fehlgeschlagen.';
          },
        },
        { label: 'Fertig', next: 'Fertig', persist: false, onEnter: runSpotifyWizardTest },
      ],
    });
    if (!spotifyWizard) return;
    $('#spotify-wizard-copy')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(state.spotify?.redirect_uri || '');
        btn.textContent = 'Kopiert ✓';
      } catch {
        // Fallback: Text markieren, damit er per Strg+C kopiert werden kann
        const range = document.createRange();
        range.selectNodeContents($('#spotify-wizard-redirect'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Markiert – Strg+C';
      }
      setTimeout(() => { btn.textContent = 'Kopieren'; }, 2000);
    });
    $('#spotify-wizard-connect')?.addEventListener('click', () => startSpotifyLogin($('#spotify-wizard-error-text')));
    $('#spotify-wizard-retest')?.addEventListener('click', runSpotifyWizardTest);
    $('#spotify-wizard-discord')?.addEventListener('click', () => sendWizardDiscordTest('spotify'));
  }

  function renderSpotifyForm() {
    const form = $('#spotify-form');
    if (!form) return;
    const cfg = state.spotify || { enabled: false, client_id: '', connected: false };
    form.enabled.checked = !!cfg.enabled;
    form.clientId.value = cfg.client_id || '';
    form.clientSecret.value = '';
    form.clientSecret.placeholder = cfg.has_client_secret ? '•••••••• (gespeichert)' : 'Client-Secret aus dem Dashboard';
    const redirect = $('#spotify-redirect-uri');
    if (redirect) redirect.textContent = cfg.redirect_uri || '–';
    const connection = $('#spotify-connection');
    if (connection) {
      if (cfg.connected) {
        const since = cfg.connected_at ? ` seit ${new Date(cfg.connected_at).toLocaleDateString('de-DE')}` : '';
        connection.textContent = `✅ Verbunden${cfg.account_name ? ' als ' + cfg.account_name : ''}${since}`;
      } else {
        connection.textContent = cfg.has_client_secret ? 'Nicht verbunden – jetzt „Mit Spotify verbinden“ klicken.' : 'Nicht verbunden';
      }
    }
    const connectBtn = $('#spotify-connect-btn');
    if (connectBtn) connectBtn.textContent = cfg.connected ? 'Neu verbinden' : 'Mit Spotify verbinden';
    const disconnectBtn = $('#spotify-disconnect-btn');
    if (disconnectBtn) disconnectBtn.hidden = !cfg.connected;
  }

  async function loadSpotifySettings(updateView = true) {
    try {
      state.spotify = await window.api.getSpotifySettings();
      renderSpotifyForm();
      if (updateView) spotifyWizard?.updateView();
    } catch (err) {
      console.warn('[admin] Spotify-Settings konnten nicht geladen werden:', err.message);
    }
  }

  // Rueckkehr vom Spotify-Login (/admin?spotify=...): Ergebnis merken, Musik-Tab oeffnen, URL bereinigen
  function readSpotifyReturn() {
    const params = new URLSearchParams(location.search);
    const result = params.get('spotify');
    if (!result) return null;
    params.delete('spotify');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
    if (!SPOTIFY_RETURN_MESSAGES[result]) return null;
    switchTab('music');
    const [message, isError] = SPOTIFY_RETURN_MESSAGES[result];
    toast(message, isError);
    return result;
  }

  async function bindSpotify() {
    const form = $('#spotify-form');
    if (!form || !window.api) return;
    const status = $('#spotify-status');
    spotifyReturnResult = readSpotifyReturn();
    initSpotifyWizard();

    // ----- Formular (manuelle Einrichtung / bereits verbunden) -----
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const clientId = (form.clientId.value || '').trim();
      const clientSecret = (form.clientSecret.value || '').trim();
      if (form.enabled.checked && (!clientId || (!clientSecret && !state.spotify?.has_client_secret))) {
        toast('Client-ID und Client-Secret sind Pflicht, wenn der Player aktiviert ist', true);
        return;
      }
      const credentialsChanged = clientId !== (state.spotify?.client_id || '') || !!clientSecret;
      if (credentialsChanged && state.spotify?.connected &&
          !confirm('Neue App-Zugangsdaten trennen die bestehende Spotify-Verbindung. Fortfahren?')) {
        return;
      }
      try {
        state.spotify = await window.api.saveSpotifySettings({ enabled: !!form.enabled.checked, clientId, clientSecret });
        renderSpotifyForm();
        toast('🎵 Spotify-Einstellungen gespeichert');
        status.textContent = state.spotify.connected || !state.spotify.has_client_secret
          ? ''
          : 'Gespeichert. Klicke jetzt auf „Mit Spotify verbinden“.';
      } catch (err) {
        toast('Fehler: ' + (err.message || 'Speichern fehlgeschlagen'), true);
      }
    });

    $('#spotify-connect-btn')?.addEventListener('click', async () => {
      const clientId = (form.clientId.value || '').trim();
      if (form.clientSecret.value || clientId !== (state.spotify?.client_id || '')) {
        status.textContent = 'Speichere zuerst die geänderte Client-ID bzw. das Secret.';
        return;
      }
      if (!state.spotify?.has_client_secret) {
        status.textContent = 'Trage zuerst Client-ID und Client-Secret ein und speichere.';
        return;
      }
      startSpotifyLogin(status);
    });

    $('#spotify-disconnect-btn')?.addEventListener('click', async () => {
      if (!confirm('Spotify-Verbindung trennen? Die Anzeige von Spotify-Titeln endet sofort.')) return;
      try {
        state.spotify = await window.api.disconnectSpotify();
        renderSpotifyForm();
        status.textContent = 'Verbindung getrennt. Entferne den Zugriff bei Bedarf auch unter spotify.com/account/apps.';
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Trennen fehlgeschlagen');
      }
    });

    $('#spotify-test-btn')?.addEventListener('click', async () => {
      status.textContent = 'Prüfe…';
      try {
        const s = await window.api.testSpotifyConnection();
        if (!s?.configured) {
          status.textContent = '❌ Spotify ist noch nicht verbunden';
        } else if (!s.connected) {
          status.textContent = '❌ ' + (s.error || 'Spotify nicht erreichbar');
        } else {
          const who = s.account ? ` als ${s.account}` : '';
          const playing = s.playing ? `spielt: ${s.title}${s.artist ? ' (' + s.artist + ')' : ''}` : 'momentan läuft nichts';
          status.textContent = `✅ Verbunden${who} — ${playing}${s.enabled ? '' : ' (Player ist deaktiviert)'}`;
          await loadSpotifySettings(false);
        }
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Netzwerkfehler');
      }
    });

    $('#spotify-discord-test-btn')?.addEventListener('click', async () => {
      status.textContent = 'Sende Discord-Test…';
      try {
        await window.api.testNavidromeDiscordWebhook('spotify');
        status.textContent = '✅ Discord-Test gesendet (prüfe deinen Kanal)';
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Netzwerkfehler');
      }
    });

    // Einstellungen laden und passende Ansicht waehlen
    await loadSpotifySettings(false);
    if (!spotifyWizard) return;
    const ret = spotifyReturnResult;
    if (ret === 'connected') {
      // Direkt nach dem Verbinden: Abschluss-Schritt mit Verbindungstest zeigen
      spotifyWizard.finish();
    } else {
      if (ret && !state.spotify?.connected && spotifyHasCredentials()) spotifyWizard.reopen(4);
      spotifyWizard.updateView();
      if (ret && state.spotify?.connected && status) status.textContent = SPOTIFY_RETURN_MESSAGES[ret][0];
    }
  }

  // ---------- Instagram-Profilabgleich ----------
  // Profilbild, Bio und auf Wunsch Namen aus dem eigenen Instagram-Konto (Business/Creator).
  const IG_APP_ID_RE = /^\d{6,25}$/;
  const IG_SECRET_RE = /^[A-Za-z0-9]{16,64}$/;
  const INSTAGRAM_RETURN_MESSAGES = {
    connected: ['✅ Mit Instagram verbunden', false],
    denied: ['Die Anmeldung bei Instagram wurde abgebrochen. Du kannst es jederzeit erneut versuchen.', true],
    invalid: ['Die Instagram-Anmeldung ist abgelaufen oder ungültig. Bitte erneut verbinden.', true],
    error: ['Instagram hat die Anmeldung abgelehnt. Prüfe Redirect-URI, App-ID und App-Secret.', true],
  };
  let instagramWizard = null;
  let instagramReturnResult = null;
  let instagramLastSync = null;

  function formatDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    return d.toLocaleDateString('de-DE') + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  // Hinweise im Profilformular: welche Felder Instagram ueberschreibt
  function renderInstagramProfileHints() {
    const cfg = state.instagram || {};
    const active = !!(cfg.connected && cfg.enabled);
    const who = cfg.username ? ` (@${cfg.username})` : '';
    const fields = {
      avatar: active && cfg.sync_avatar,
      bio: active && cfg.sync_bio && cfg.bio_available !== false,
      name: active && cfg.sync_name,
    };
    $$('.ig-sync-hint').forEach((hint) => {
      const on = !!fields[hint.dataset.igField];
      hint.hidden = !on;
      hint.textContent = on ? `🔄 Wird täglich aus Instagram übernommen${who} – Änderungen hier werden dabei überschrieben.` : '';
    });
  }

  function renderInstagramForm() {
    const form = $('#instagram-form');
    if (!form) return;
    const cfg = state.instagram || {};
    form.enabled.checked = !!cfg.enabled;
    form.sync_avatar.checked = cfg.sync_avatar !== false;
    form.sync_bio.checked = cfg.sync_bio !== false;
    form.sync_name.checked = !!cfg.sync_name;
    form.appId.value = cfg.app_id || '';
    form.appSecret.value = '';
    form.appSecret.placeholder = cfg.has_app_secret ? '•••••••• (gespeichert)' : 'App-Secret aus der Meta-App';
    $('#instagram-redirect-uri').textContent = cfg.redirect_uri || '–';

    const connection = $('#instagram-connection');
    if (cfg.connected) {
      const until = cfg.token_expires_at ? ` · Zugriff gültig bis ${new Date(cfg.token_expires_at).toLocaleDateString('de-DE')} (wird automatisch verlängert)` : '';
      connection.textContent = `✅ Verbunden${cfg.username ? ' als @' + cfg.username : ''}${until}`;
    } else {
      connection.textContent = cfg.has_app_secret ? 'Nicht verbunden – jetzt „Mit Instagram verbinden“ klicken.' : 'Nicht verbunden';
    }
    const last = $('#instagram-last-sync');
    if (cfg.last_sync_at) {
      last.textContent = `${cfg.last_sync_ok ? '🔄' : '⚠️'} Letzter Abgleich: ${formatDateTime(cfg.last_sync_at)} – ${cfg.last_sync_message || ''}`;
    } else {
      last.textContent = '';
    }
    $('#instagram-connect-btn').textContent = cfg.connected ? 'Neu verbinden' : 'Mit Instagram verbinden';
    $('#instagram-disconnect-btn').hidden = !cfg.connected;
    $('#instagram-sync-btn').disabled = !cfg.connected;
    renderInstagramProfileHints();
  }

  async function loadInstagramSettings(updateView = true) {
    try {
      state.instagram = await window.api.getInstagramSettings();
      renderInstagramForm();
      if (updateView) instagramWizard?.updateView();
    } catch (err) {
      console.warn('[admin] Instagram-Settings konnten nicht geladen werden:', err.message);
    }
  }

  // Abgleich ausfuehren; uebernommene Werte sofort im Profilformular anzeigen
  async function runInstagramSync() {
    const result = await window.api.syncInstagram();
    if (result?.settings) {
      state.instagram = result.settings;
      renderInstagramForm();
    }
    if (result?.ok && result.changed?.length) {
      state.profile = await window.api.getAdminProfile();
      renderProfile();
    }
    return result;
  }

  function renderInstagramRedirectCheck() {
    const cfg = state.instagram || {};
    $('#instagram-wizard-redirect').textContent = cfg.redirect_uri || '–';
    const check = '#instagram-wizard-redirect-check';
    if (cfg.redirect_uri_localhost) {
      wizardCheck(check, '⚠️ Meta akzeptiert „localhost“ nicht. Setze APP_URL in der .env auf deine öffentliche https-Domain.', 'warn');
    } else if (!cfg.redirect_uri_secure) {
      wizardCheck(check, '⚠️ Meta verlangt https. Setze APP_URL in der .env auf deine https-Adresse (z. B. https://links.deine-domain.de) und starte OpenWeb neu.', 'warn');
    } else if (!cfg.redirect_uri_configured) {
      wizardCheck(check, '⚠️ APP_URL ist nicht gesetzt – die Adresse wurde aus dem aktuellen Aufruf abgeleitet. Setze APP_URL in der .env, damit sie sich nicht ändert.', 'warn');
    } else {
      wizardCheck(check, '✅ Die Adresse kommt aus APP_URL und nutzt https.', 'ok');
    }
  }

  async function saveInstagramWizardCredentials() {
    const idInput = $('#instagram-wizard-app-id');
    const secretInput = $('#instagram-wizard-app-secret');
    const check = '#instagram-wizard-cred-check';
    const appId = idInput.value.trim();
    const appSecret = secretInput.value.trim();
    const fail = (msg, field) => {
      wizardCheck(check, '⚠️ ' + msg, 'warn');
      field?.focus();
      return false;
    };
    if (!IG_APP_ID_RE.test(appId)) return fail('Die Instagram-App-ID besteht nur aus Ziffern (meist 15–17 Stellen).', idInput);
    const keepSecret = !appSecret && state.instagram?.has_app_secret && appId === state.instagram?.app_id;
    if (!keepSecret && !IG_SECRET_RE.test(appSecret)) return fail('Das App-Secret besteht aus 32 Buchstaben und Ziffern – klicke in der Meta-App auf „Anzeigen“ und kopiere es.', secretInput);
    try {
      state.instagram = await window.api.saveInstagramSettings({ appId, appSecret });
      secretInput.value = '';
      wizardCheck(check, '');
      renderInstagramForm();
      instagramReturnResult = null;
      return true;
    } catch (err) {
      return fail(err.message || 'Speichern fehlgeschlagen');
    }
  }

  async function startInstagramLogin(statusEl) {
    try {
      const { url } = await window.api.startInstagramAuthorization();
      if (typeof url !== 'string' || !url.startsWith('https://www.instagram.com/oauth/authorize')) throw new Error('Ungültige Anmelde-URL');
      location.href = url;
    } catch (err) {
      if (statusEl) statusEl.textContent = '❌ ' + (err.message || 'Anmeldung konnte nicht gestartet werden');
    }
  }

  function renderInstagramResult() {
    const result = instagramLastSync;
    const box = '#instagram-wizard-result';
    if (!result) {
      wizardCheck(box, '');
    } else if (result.ok) {
      wizardCheck(box, `✅ ${result.message}. Ab jetzt wird ${state.instagram?.enabled ? 'täglich automatisch' : 'auf Knopfdruck („Jetzt abgleichen“)'} abgeglichen.`, 'ok');
    } else {
      wizardCheck(box, '⚠️ ' + (result.message || 'Abgleich fehlgeschlagen'), 'warn');
    }
    const p = result?.profile;
    const preview = $('#instagram-wizard-preview');
    preview.hidden = !p;
    if (!p) return;
    const img = $('#instagram-wizard-preview-img');
    img.hidden = !p.avatar_url;
    if (p.avatar_url) img.src = p.avatar_url;
    $('#instagram-wizard-preview-name').textContent = p.name || '';
    $('#instagram-wizard-preview-handle').textContent = p.handle || '';
    $('#instagram-wizard-preview-bio').textContent = p.bio || '';
  }

  function initInstagramWizard() {
    instagramWizard = createSetupWizard({
      name: 'instagram',
      root: '#instagram-wizard',
      form: '#instagram-form',
      startButton: '#instagram-wizard-start-btn',
      isConfigured: () => !!state.instagram?.connected,
      firstStep: () => {
        if (state.instagram?.connected) return 5;
        if (state.instagram?.app_id && state.instagram?.has_app_secret) return 4;
        return instagramWizard.savedStep(3);
      },
      steps: [
        { label: 'Vorbereiten', next: 'Erledigt – weiter' },
        { label: 'Redirect-URI', next: 'Eingetragen – weiter', render: renderInstagramRedirectCheck },
        {
          label: 'Zugangsdaten',
          next: 'Speichern & weiter',
          onEnter() {
            const idInput = $('#instagram-wizard-app-id');
            if (!idInput.value && state.instagram?.app_id) idInput.value = state.instagram.app_id;
            $('#instagram-wizard-app-secret').placeholder = state.instagram?.has_app_secret
              ? '•••••••• (gespeichert – leer lassen zum Behalten)'
              : 'App-Secret (über „Anzeigen“ sichtbar)';
          },
          onNext: saveInstagramWizardCredentials,
        },
        {
          label: 'Verbinden',
          next: null,
          persist: false,
          render() {
            const ret = instagramReturnResult;
            const showError = !!ret && ret !== 'connected';
            $('#instagram-wizard-error').hidden = !showError;
            if (showError) $('#instagram-wizard-error-text').textContent = INSTAGRAM_RETURN_MESSAGES[ret]?.[0] || 'Die Anmeldung ist fehlgeschlagen.';
          },
        },
        {
          label: 'Auswahl',
          next: 'Übernehmen & weiter',
          persist: false,
          onEnter() {
            const cfg = state.instagram || {};
            $('#instagram-wizard-account').textContent = cfg.username ? `✅ Verbunden als @${cfg.username}` : '✅ Mit Instagram verbunden';
            $('#instagram-wizard-sync-avatar').checked = cfg.sync_avatar !== false;
            $('#instagram-wizard-sync-bio').checked = cfg.sync_bio !== false;
            $('#instagram-wizard-sync-name').checked = !!cfg.sync_name;
            $('#instagram-wizard-auto').checked = cfg.enabled !== false || !cfg.last_sync_at;
            wizardCheck('#instagram-wizard-sync-check', cfg.bio_available === false
              ? 'ℹ️ Instagram gibt die Beschreibung für dieses Konto über die API nicht heraus – sie bleibt dann unverändert.'
              : '');
          },
          async onNext() {
            const check = '#instagram-wizard-sync-check';
            const selection = {
              enabled: $('#instagram-wizard-auto').checked,
              sync_avatar: $('#instagram-wizard-sync-avatar').checked,
              sync_bio: $('#instagram-wizard-sync-bio').checked,
              sync_name: $('#instagram-wizard-sync-name').checked,
            };
            if (!selection.sync_avatar && !selection.sync_bio && !selection.sync_name) {
              wizardCheck(check, '⚠️ Bitte mindestens ein Feld auswählen.', 'warn');
              return false;
            }
            wizardCheck(check, 'Übernehme dein Profil von Instagram …');
            try {
              state.instagram = await window.api.saveInstagramSettings(selection);
              instagramLastSync = await runInstagramSync();
              wizardCheck(check, '');
              return true;
            } catch (err) {
              wizardCheck(check, '⚠️ ' + (err.message || 'Abgleich fehlgeschlagen'), 'warn');
              return false;
            }
          },
        },
        { label: 'Fertig', next: 'Fertig', persist: false, onEnter: renderInstagramResult },
      ],
    });
    if (!instagramWizard) return;
    $('#instagram-wizard-copy')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(state.instagram?.redirect_uri || '');
        btn.textContent = 'Kopiert ✓';
      } catch {
        const range = document.createRange();
        range.selectNodeContents($('#instagram-wizard-redirect'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Markiert – Strg+C';
      }
      setTimeout(() => { btn.textContent = 'Kopieren'; }, 2000);
    });
    $('#instagram-wizard-connect')?.addEventListener('click', () => startInstagramLogin($('#instagram-wizard-error-text')));
  }

  // Rueckkehr vom Instagram-Login (/admin?instagram=...): Ergebnis merken, Profil-Tab oeffnen
  function readInstagramReturn() {
    const params = new URLSearchParams(location.search);
    const result = params.get('instagram');
    if (!result) return null;
    params.delete('instagram');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? '?' + query : '') + location.hash);
    if (!INSTAGRAM_RETURN_MESSAGES[result]) return null;
    switchTab('profile');
    const [message, isError] = INSTAGRAM_RETURN_MESSAGES[result];
    toast(message, isError);
    return result;
  }

  async function bindInstagram() {
    const form = $('#instagram-form');
    if (!form || !window.api) return;
    const status = $('#instagram-status');
    instagramReturnResult = readInstagramReturn();
    initInstagramWizard();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const appId = (form.appId.value || '').trim();
      const appSecret = (form.appSecret.value || '').trim();
      const enabled = !!form.enabled.checked;
      if (enabled && (!appId || (!appSecret && !state.instagram?.has_app_secret))) {
        toast('App-ID und App-Secret sind Pflicht, wenn der Abgleich aktiviert ist', true);
        return;
      }
      const credentialsChanged = appId !== (state.instagram?.app_id || '') || !!appSecret;
      if (credentialsChanged && state.instagram?.connected &&
          !confirm('Neue App-Zugangsdaten trennen die bestehende Instagram-Verbindung. Fortfahren?')) {
        return;
      }
      try {
        state.instagram = await window.api.saveInstagramSettings({
          enabled,
          appId,
          appSecret,
          sync_avatar: !!form.sync_avatar.checked,
          sync_bio: !!form.sync_bio.checked,
          sync_name: !!form.sync_name.checked,
        });
        renderInstagramForm();
        toast('📸 Instagram-Einstellungen gespeichert');
        status.textContent = state.instagram.connected || !state.instagram.has_app_secret
          ? ''
          : 'Gespeichert. Klicke jetzt auf „Mit Instagram verbinden“.';
      } catch (err) {
        toast('Fehler: ' + (err.message || 'Speichern fehlgeschlagen'), true);
      }
    });

    $('#instagram-connect-btn')?.addEventListener('click', () => {
      const appId = (form.appId.value || '').trim();
      if (form.appSecret.value || appId !== (state.instagram?.app_id || '')) {
        status.textContent = 'Speichere zuerst die geänderte App-ID bzw. das Secret.';
        return;
      }
      if (!state.instagram?.has_app_secret) {
        status.textContent = 'Trage zuerst App-ID und App-Secret ein und speichere.';
        return;
      }
      startInstagramLogin(status);
    });

    $('#instagram-sync-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      status.textContent = 'Gleiche mit Instagram ab …';
      try {
        const result = await runInstagramSync();
        status.textContent = (result.ok ? '✅ ' : '⚠️ ') + (result.message || '');
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Abgleich fehlgeschlagen');
      } finally {
        btn.disabled = !state.instagram?.connected;
      }
    });

    $('#instagram-disconnect-btn')?.addEventListener('click', async () => {
      if (!confirm('Instagram-Verbindung trennen? Das Profil bleibt so, wie es zuletzt übernommen wurde.')) return;
      try {
        state.instagram = await window.api.disconnectInstagram();
        renderInstagramForm();
        status.textContent = 'Verbindung getrennt. Entferne den Zugriff bei Bedarf auch in Instagram unter „Apps und Websites“.';
      } catch (err) {
        status.textContent = '❌ ' + (err.message || 'Trennen fehlgeschlagen');
      }
    });

    await loadInstagramSettings(false);
    if (!instagramWizard) return;
    const ret = instagramReturnResult;
    if (ret === 'connected' && state.instagram?.connected) {
      // Direkt nach dem Verbinden: Auswahl der Felder zeigen
      instagramWizard.open(5);
    } else {
      if (ret && ret !== 'connected' && !state.instagram?.connected && state.instagram?.has_app_secret) instagramWizard.reopen(4);
      instagramWizard.updateView();
    }
  }

  async function reloadCategories() { state.categories = await window.api.getAdminLinkCategories(); }
  async function reloadLinks() { state.links = await window.api.getAdminLinks(); renderLinks(); }
  async function reloadAll() {
    [state.profile, state.links, state.categories] = await Promise.all([
      window.api.getAdminProfile(),
      window.api.getAdminLinks(),
      window.api.getAdminLinkCategories(),
    ]);
    window.icons.applyStyle(state.profile?.icon_style);
    renderProfile();
    renderLinks();
  }

  // ---------- Admin-Panel: Navidrome Live-Vorschau ----------
  function initAdminNowPlaying() {
    const player = $('#admin-np-player');
    const cover = $('#admin-np-cover');
    const badge = $('#admin-np-badge');
    const titleEl = $('#admin-np-title');
    const metaEl = $('#admin-np-meta');
    const progressEl = $('#admin-np-progress');
    if (!player || !cover || !badge || !titleEl || !metaEl || !progressEl) return;

    let pollTimer = null;
    let progressTimer = null;
    let currentTrack = null;
    let lastServerPosition = 0;
    let localPosition = 0;
    let lastTickAt = 0;

    function setState(state) {
      player.classList.remove('idle', 'playing', 'paused');
      player.classList.add(state);
    }

    function formatDuration(seconds) {
      const s = parseInt(seconds || 0, 10);
      const m = Math.floor(s / 60);
      const r = s % 60;
      return `${m}:${String(r).padStart(2, '0')}`;
    }

    function applyMarquee(container, html) {
      container.classList.remove('marquee-content', 'marquee-scroll');
      container.style.removeProperty('--marquee-offset');
      container.innerHTML = `<span class="marquee-inner">${html}</span>`;
      const inner = container.querySelector('.marquee-inner');
      if (!inner) return;
      const needsScroll = inner.scrollWidth > container.clientWidth + 2;
      if (needsScroll) {
        const offset = -(inner.scrollWidth - container.clientWidth);
        inner.classList.add('marquee-content');
        inner.style.setProperty('--marquee-offset', offset + 'px');
        requestAnimationFrame(() => {
          inner.classList.add('marquee-scroll');
        });
      }
    }

    function clearMarquee(container) {
      container.classList.remove('marquee-content', 'marquee-scroll');
      container.style.removeProperty('--marquee-offset');
      container.textContent = '';
    }

    function renderIdle() {
      currentTrack = null;
      setState('idle');
      badge.replaceChildren(el('span', { class: 'np-badge-text' }, 'Nichts läuft'));
      const sourceImg = $('#admin-np-source');
      if (sourceImg) sourceImg.hidden = true;
      clearMarquee(titleEl);
      titleEl.textContent = 'Momentan läuft nichts';
      clearMarquee(metaEl);
      metaEl.textContent = 'Starte Musik im aktiven Player, um die Vorschau zu sehen.';
      progressEl.textContent = '00:00 / 00:00';
      const progressLine = $('#admin-np-progress-line');
      if (progressLine) {
        progressLine.style.setProperty('--wave-progress', '0%');
        progressLine.classList.remove('indeterminate');
      }
      cover.classList.add('placeholder');
      cover.replaceChildren();
    }

    function renderTrack(track) {
      const state = track.paused ? 'paused' : 'playing';
      setState(state);
      const source = MUSIC_SOURCES[track.source];
      const stateText = track.paused ? 'Pausiert' : (track.isRadio ? '📡 LIVE' : 'Spielt');
      badge.replaceChildren(el('span', { class: 'np-badge-text' }, source ? `${source.name} · ${stateText}` : stateText));
      // Logo der Quelle in Titelgroesse vor dem Titel
      const sourceImg = $('#admin-np-source');
      if (sourceImg) {
        if (source) {
          const src = `/api/icon/dashboardicon/${source.icon}/svg`;
          if (sourceImg.getAttribute('src') !== src) sourceImg.src = src;
          sourceImg.title = source.name;
          sourceImg.hidden = false;
        } else {
          sourceImg.hidden = true;
        }
      }
      applyMarquee(titleEl, escapeHtml(track.title || 'Unbekannt'));

      const parts = [];
      if (track.isRadio) {
        parts.push(escapeHtml(track.artist || 'Internetradio'));
      } else if (track.artist) {
        parts.push(escapeHtml(track.artist));
      }
      if (track.album && !track.isRadio) parts.push(escapeHtml(track.album));

      let bitrate = null;
      if (track.bitrate) {
        if (typeof track.bitrate === 'number' || !isNaN(track.bitrate)) {
          bitrate = `${track.bitrate} kbps`;
        } else {
          bitrate = track.bitrate;
        }
      }
      const extra = [];
      if (track.isRadio) extra.push('<span class="admin-np-radio-badge">📡 LIVE</span>');
      if (bitrate) extra.push(`Bitrate: <span class="admin-np-bitrate">${escapeHtml(bitrate)}</span>`);
      const metaText = parts.join(' · ') + (extra.length ? ' | ' + extra.join(' | ') : '');
      applyMarquee(metaEl, metaText);

      cover.replaceChildren();
      cover.classList.remove('placeholder');
      if (track.coverUrl) {
        const img = el('img', { src: track.coverUrl, alt: track.title || '', class: 'np-cover-img' });
        cover.appendChild(img);
      } else {
        cover.classList.add('placeholder');
      }

      lastServerPosition = track.position || 0;
      localPosition = lastServerPosition;
      lastTickAt = performance.now();
      updateProgress();
    }

    function updateProgress() {
      if (!currentTrack) return;
      const progressLine = $('#admin-np-progress-line');
      if (progressLine) {
        const duration = Number(currentTrack.duration) || 0;
        const isIndeterminate = currentTrack.isRadio || duration <= 0;
        const progress = duration > 0
          ? Math.min(100, Math.max(0, (Number(localPosition) || 0) / duration * 100))
          : 0;
        progressLine.classList.toggle('indeterminate', isIndeterminate);
        progressLine.style.setProperty('--wave-progress', `${progress}%`);
        if (isIndeterminate) progressLine.removeAttribute('aria-valuenow');
        else progressLine.setAttribute('aria-valuenow', String(Math.round(progress)));
      }
      if (currentTrack.isRadio) {
        progressEl.textContent = currentTrack.radioStreamUrl ? '📡 Stream' : '📡 Radio';
        return;
      }
      if (!currentTrack.paused) {
        const now = performance.now();
        localPosition += (now - lastTickAt) / 1000;
        lastTickAt = now;
      }
      const duration = currentTrack.duration || 0;
      if (duration > 0 && localPosition >= duration) {
        localPosition = duration;
        tick();
      } else if (duration > 0) {
        localPosition = Math.min(localPosition, duration);
      }
      progressEl.textContent = `${formatDuration(localPosition)} / ${formatDuration(duration)}`;
    }

    function trackId(track) {
      return [track.title, track.artist, track.album].filter(Boolean).join('::');
    }

    let isPolling = false;
    async function tick() {
      if (isPolling) return;
      isPolling = true;
      try {
        const track = await window.NavidromeAPI.nowPlaying();
        if (['time', 'line'].includes(track?.player_progress_style) && player.dataset.progressStyle !== track.player_progress_style) {
          player.dataset.progressStyle = track.player_progress_style;
          if (track.player_progress_style === 'line') populateAdminWaveform($('#admin-np-progress-line'));
        }
        if (!track || !track.playing) {
          if (currentTrack) renderIdle();
          isPolling = false;
          return;
        }
        const previousId = currentTrack ? trackId(currentTrack) : null;
        const newId = trackId(track);
        if (JSON.stringify(track) !== JSON.stringify(currentTrack)) {
          currentTrack = track;
          renderTrack(track);
        } else {
          lastServerPosition = track.position || 0;
          localPosition = lastServerPosition;
          lastTickAt = performance.now();
          updateProgress();
        }
        if (previousId && previousId !== newId) {
          console.log('[admin np] neuer Track erkannt, aktualisiere Anzeige');
        }
      } catch (err) {
        console.warn('[admin np] poll failed:', err.message);
      }
      isPolling = false;
    }

    // Nur abfragen, solange der Musik-Tab offen und das Fenster sichtbar ist
    // (sonst liefen dauerhaft 20 Anfragen pro Minute, nur weil der Admin offen ist)
    const musicVisible = () => !document.hidden && !$('.tab[data-tab="music"]')?.hidden;
    if (musicVisible()) tick();
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(updateProgress, 1000);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (musicVisible()) tick(); }, 3000);
    document.addEventListener('admin-tab-change', (e) => { if (e.detail === 'music') tick(); });
    document.addEventListener('visibilitychange', () => { if (musicVisible()) tick(); });
  }

  async function initApp() {
    try {
      await reloadAll();
      loadAdminStatus();
    } catch (err) {
      setConnection('err');
      toast('Verbindung fehlgeschlagen: ' + err.message, true);
    }
  }

  // ---------- Ressourcenmonitor ----------
  function bindMonitor() {
    const cards = $('#monitor-cards');
    if (!cards) return;
    const live = $('#monitor-live');
    const updated = $('#monitor-updated');
    let history = [];
    let info = null;
    let storage = null;
    let timer = null;
    let active = false;

    // Farben aus den M3-Farbrollen (passen sich an das Stylesheet an)
    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    const fmtUptime = (sec) => {
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      return d ? `${d} T ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
    };

    const formatSampleTime = (sample) => sample
      ? new Date(sample.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : null;

    // ---------- Diagramme ----------
    // Zeitbasierte Liniendiagramme mit Fadenkreuz: Beim Ueberfahren (Maus, Touch, Pfeiltasten)
    // zeigen alle vier Diagramme denselben Zeitpunkt, das ueberfahrene zusaetzlich die Werte.
    const SAMPLE_MS = 10000;
    const GAP_MS = SAMPLE_MS * 3; // laengere Luecke (z. B. Neustart) = Linie unterbrechen
    const MB = 1048576;
    const fmtNum = (v, digits = 1) => Number(v || 0).toLocaleString('de-DE', { maximumFractionDigits: digits });
    const fmtClock = (t, seconds = false) => new Date(t).toLocaleTimeString('de-DE',
      seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

    const CHARTS = [
      {
        id: 'monitor-chart-cpu', unit: ' %', title: 'CPU-Last',
        series: [{ label: 'Prozess', color: '--md-primary', value: s => s.cpu, format: s => `${fmtNum(s.cpu)} %` }],
      },
      {
        id: 'monitor-chart-mem', unit: ' MB', title: 'Arbeitsspeicher',
        series: [
          { label: 'RSS', color: '--md-primary', value: s => s.rss / MB, format: s => formatBytes(s.rss) },
          { label: 'V8-Heap', color: '--md-tertiary', value: s => s.heapUsed / MB, format: s => formatBytes(s.heapUsed) },
        ],
      },
      {
        id: 'monitor-chart-req', unit: '', title: 'Anfragen pro Minute',
        series: [
          { label: 'Anfragen', color: '--md-primary', value: s => s.reqPerMin, format: s => `${fmtNum(s.reqPerMin, 0)}/min` },
          { label: '5xx-Fehler', color: '--md-error', value: s => s.errPerMin, format: s => `${fmtNum(s.errPerMin, 0)}/min` },
        ],
      },
      {
        id: 'monitor-chart-resp', unit: ' ms', title: 'Antwortzeit',
        series: [
          { label: 'Durchschnitt', color: '--md-primary', value: s => s.respAvgMs, format: s => `${fmtNum(s.respAvgMs, 0)} ms` },
          { label: '95. Perzentil', color: '--md-tertiary', value: s => s.respP95Ms, format: s => `${fmtNum(s.respP95Ms, 0)} ms` },
        ],
      },
    ];

    let hoverT = null;       // Zeitstempel des markierten Messpunkts (null = keiner)
    let hoverChart = null;   // Diagramm, ueber dem gerade der Zeiger/Fokus ist
    let drawQueued = false;

    // "Schoene" Achsenschritte: 1, 2, 2.5, 5 x 10^n
    function niceStep(range, ticks) {
      const raw = range / Math.max(1, ticks);
      const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
      const norm = raw / mag;
      const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
      return nice * mag;
    }

    // Index des Messpunkts, der dem Zeitpunkt t am naechsten liegt (history ist nach t sortiert)
    function nearestIndex(t) {
      let lo = 0, hi = history.length - 1;
      if (hi < 0) return -1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (history[mid].t < t) lo = mid + 1; else hi = mid;
      }
      if (lo > 0 && Math.abs(history[lo - 1].t - t) <= Math.abs(history[lo].t - t)) lo--;
      return lo;
    }

    function chartGeometry(chart) {
      const canvas = chart.canvas;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h || !history.length) return null;
      const t1 = history[history.length - 1].t;
      const t0 = Math.min(history[0].t, t1 - SAMPLE_MS * 6); // mind. 1 min Breite
      const values = history.flatMap(s => chart.series.map(sr => sr.value(s)));
      const rawMax = Math.max(0, ...values);
      const step = niceStep(rawMax > 0 ? rawMax * 1.1 : 1, 4);
      const max = Math.max(step, Math.ceil((rawMax * 1.05) / step) * step);
      const ctx = canvas.getContext('2d');
      ctx.font = '11px ' + (css('--md-font') || 'sans-serif');
      const tickLabels = [];
      for (let v = 0; v <= max + step / 2; v += step) tickLabels.push({ v, text: `${fmtNum(v, step < 1 ? 1 : 0)}${chart.unit}` });
      const left = Math.ceil(Math.max(...tickLabels.map(l => ctx.measureText(l.text).width))) + 12;
      const pad = { l: left, r: 12, t: 10, b: 24 };
      const plotW = Math.max(10, w - pad.l - pad.r), plotH = Math.max(10, h - pad.t - pad.b);
      return {
        w, h, pad, plotW, plotH, t0, t1, max, step, tickLabels,
        x: (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * plotW,
        y: (v) => pad.t + (1 - v / max) * plotH,
        tAt: (px) => t0 + ((px - pad.l) / plotW) * (t1 - t0),
      };
    }

    function drawChart(chart) {
      const canvas = chart.canvas;
      const dpr = window.devicePixelRatio || 1;
      const g = chartGeometry(chart);
      if (!g) return;
      canvas.width = Math.round(g.w * dpr);
      canvas.height = Math.round(g.h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, g.w, g.h);
      ctx.font = '11px ' + (css('--md-font') || 'sans-serif');
      const muted = css('--md-on-surface-variant');

      // Y-Achse + Hilfslinien
      ctx.lineWidth = 1;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      g.tickLabels.forEach(({ v, text }) => {
        const gy = Math.round(g.y(v)) + 0.5;
        ctx.strokeStyle = css('--md-outline-variant');
        ctx.globalAlpha = v === 0 ? 0.9 : 0.45;
        ctx.beginPath(); ctx.moveTo(g.pad.l, gy); ctx.lineTo(g.w - g.pad.r, gy); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = muted;
        ctx.fillText(text, g.pad.l - 8, gy);
      });

      // X-Achse: Uhrzeiten auf runden Minuten, so viele wie mit ~70 px Abstand passen
      const spanMin = (g.t1 - g.t0) / 60000;
      const maxLabels = Math.max(2, Math.floor(g.plotW / 70));
      const stepMin = [1, 2, 5, 10, 15, 20, 30, 60].find(m => spanMin / m <= maxLabels) || 60;
      const first = Math.ceil(g.t0 / (stepMin * 60000)) * stepMin * 60000;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (let t = first; t <= g.t1; t += stepMin * 60000) {
        const px = g.x(t);
        if (px < g.pad.l + 14 || px > g.w - g.pad.r - 14) continue;
        ctx.strokeStyle = css('--md-outline-variant');
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, g.pad.t); ctx.lineTo(Math.round(px) + 0.5, g.h - g.pad.b); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = muted;
        ctx.fillText(fmtClock(t), px, g.h - 6);
      }

      // Reihen; Luecken > GAP_MS unterbrechen die Linie
      const segments = [];
      let seg = [];
      history.forEach((s, i) => {
        if (i && s.t - history[i - 1].t > GAP_MS) { segments.push(seg); seg = []; }
        seg.push(s);
      });
      if (seg.length) segments.push(seg);

      chart.series.forEach((sr, idx) => {
        const color = css(sr.color);
        segments.forEach(points => {
          ctx.beginPath();
          points.forEach((s, i) => {
            const px = g.x(s.t), py = g.y(sr.value(s));
            if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
          });
          if (points.length === 1) ctx.lineTo(g.x(points[0].t) + 1, g.y(sr.value(points[0])));
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.stroke();
          if (idx === 0) {
            ctx.lineTo(g.x(points[points.length - 1].t), g.y(0));
            ctx.lineTo(g.x(points[0].t), g.y(0));
            ctx.closePath();
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        });
      });

      // Fadenkreuz am markierten Messpunkt
      const tip = chart.tooltip;
      const i = hoverT == null ? -1 : nearestIndex(hoverT);
      if (i < 0) { tip.hidden = true; return; }
      const sample = history[i];
      const px = g.x(sample.t);
      ctx.strokeStyle = css('--md-on-surface');
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, g.pad.t); ctx.lineTo(Math.round(px) + 0.5, g.h - g.pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      chart.series.forEach(sr => {
        const py = g.y(sr.value(sample));
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = css(sr.color);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = css('--md-surface-container-low') || css('--md-surface');
        ctx.stroke();
      });

      if (chart !== hoverChart) { tip.hidden = true; return; }
      tip.replaceChildren(
        el('div', { class: 'monitor-tooltip-time', text: fmtClock(sample.t, true) }),
        ...chart.series.map(sr => el('div', { class: 'monitor-tooltip-row' },
          el('span', { class: 'monitor-tooltip-dot', style: `background: var(${sr.color})` }),
          el('span', { text: sr.label }),
          el('strong', { text: sr.format(sample) })
        ))
      );
      tip.hidden = false;
      // Box neben das Fadenkreuz setzen, am Rand auf die andere Seite wechseln
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = px + 14;
      if (left + tw > g.w - 4) left = px - 14 - tw;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${Math.max(4, Math.min(g.pad.t + 4, g.h - th - 4))}px`;
    }

    function drawCharts() {
      drawQueued = false;
      CHARTS.forEach(drawChart);
    }
    function queueDraw() {
      if (drawQueued) return;
      drawQueued = true;
      requestAnimationFrame(drawCharts);
    }

    function setHover(chart, t) {
      hoverChart = chart;
      hoverT = t;
      queueDraw();
    }

    CHARTS.forEach(chart => {
      chart.canvas = $(`#${chart.id}`);
      if (!chart.canvas) return;
      // Box fuer die Werte, positioniert ueber dem Diagramm
      const wrap = el('div', { class: 'monitor-plot' });
      chart.canvas.parentNode.insertBefore(wrap, chart.canvas);
      wrap.appendChild(chart.canvas);
      chart.tooltip = el('div', { class: 'monitor-tooltip', 'aria-live': 'polite', hidden: true });
      wrap.appendChild(chart.tooltip);
      chart.canvas.tabIndex = 0;
      chart.canvas.setAttribute('aria-description', 'Mit der Maus oder den Pfeiltasten einen Zeitpunkt auswählen, um die genauen Werte zu sehen.');

      const fromPointer = (e) => {
        const g = chartGeometry(chart);
        if (!g) return;
        const rect = chart.canvas.getBoundingClientRect();
        const px = Math.min(g.w - g.pad.r, Math.max(g.pad.l, e.clientX - rect.left));
        setHover(chart, g.tAt(px));
      };
      chart.canvas.addEventListener('pointermove', fromPointer);
      chart.canvas.addEventListener('pointerdown', fromPointer);
      chart.canvas.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse' && hoverChart === chart) setHover(null, null);
      });
      chart.canvas.addEventListener('keydown', (e) => {
        if (!history.length) return;
        let i = hoverT == null ? history.length - 1 : nearestIndex(hoverT);
        const jump = e.shiftKey ? 6 : 1; // Umschalt = 1 Minute
        if (e.key === 'ArrowLeft') i = Math.max(0, i - jump);
        else if (e.key === 'ArrowRight') i = Math.min(history.length - 1, i + jump);
        else if (e.key === 'Home') i = 0;
        else if (e.key === 'End') i = history.length - 1;
        else if (e.key === 'Escape') { setHover(null, null); return; }
        else return;
        e.preventDefault();
        setHover(chart, history[i].t);
      });
      chart.canvas.addEventListener('focus', () => {
        if (history.length) setHover(chart, hoverT ?? history[history.length - 1].t);
      });
      chart.canvas.addEventListener('blur', () => { if (hoverChart === chart) setHover(null, null); });
    });
    // Tippen ausserhalb der Diagramme blendet die Markierung auf Touch-Geraeten aus
    document.addEventListener('pointerdown', (e) => {
      if (hoverT != null && !e.target.closest?.('.monitor-plot')) setHover(null, null);
    });

    function card(label, value, sub = '', level = '') {
      return el('div', { class: `stat-card monitor-card ${level}`.trim() },
        el('strong', { text: value }),
        el('span', { text: label }),
        sub ? el('small', { class: 'hint', text: sub }) : null
      );
    }

    function render() {
      const last = history[history.length - 1];
      if (!info) return;
      if (!last) {
        cards.replaceChildren(el('p', { class: 'hint', text: 'Erste Messung läuft – die Werte erscheinen in wenigen Sekunden.' }));
        return;
      }
      cards.replaceChildren(
        card('CPU-Last', `${last.cpu.toFixed(1)} %`, `100 % = 1 Kern · ${info.cpuCores} Kerne`, last.cpu > 80 ? 'warn' : ''),
        card('Arbeitsspeicher', formatBytes(last.rss), `Heap ${formatBytes(last.heapUsed)} von ${formatBytes(info.heapLimit)}`,
          last.heapUsed / info.heapLimit > 0.8 ? 'warn' : ''),
        card('Event-Loop', `${last.loopP99Ms.toFixed(1)} ms`, `Verzögerung (99 %), Ø ${last.loopMeanMs.toFixed(1)} ms`, last.loopP99Ms > 100 ? 'warn' : ''),
        card('Anfragen', `${Math.round(last.reqPerMin)}/min`, `seit Messbeginn: ${info.totalsRequests.toLocaleString('de-DE')}`),
        card('Antwortzeit', `${Math.round(last.respAvgMs)} ms`, `95 % unter ${Math.round(last.respP95Ms)} ms`, last.respP95Ms > 1000 ? 'warn' : ''),
        card('Serverfehler', `${last.errPerMin}/min`, `seit Messbeginn: ${info.totalsErrors.toLocaleString('de-DE')}`, last.errPerMin > 0 ? 'warn' : ''),
        card('DB-Verbindungen', `${last.dbTotal - last.dbIdle} aktiv`, `${last.dbIdle} frei${last.dbWaiting ? ` · ${last.dbWaiting} wartend` : ''}`, last.dbWaiting > 0 ? 'warn' : ''),
        card('Laufzeit', fmtUptime(info.uptimeSec), `Node ${info.node}`)
      );

      drawCharts();

      const details = [
        ['Prozess', `PID ${info.pid} · ${info.platform}`],
        ['Node.js', info.node],
        ['Arbeitsspeicher des Servers', formatBytes(info.systemMemTotal)],
        ['Heap-Grenze', formatBytes(info.heapLimit)],
      ];
      if (storage) {
        details.push(
          ['Datenbankgröße', formatBytes(storage.dbBytes)],
          ['Aktive Sitzungen', String(storage.sessions)],
          ['Gespeicherte Klicks', storage.clicks.toLocaleString('de-DE')],
          ['Backups', `${storage.backupCount} Dateien · ${formatBytes(storage.backupBytes)}`]
        );
      }
      $('#monitor-details').replaceChildren(...details.map(([k, v]) =>
        el('li', {}, el('span', { text: k }), el('strong', { text: v }))
      ));
    }

    async function load() {
      try {
        let since = history.length ? history[history.length - 1].t : 0;
        if (since && Date.now() - since > 60 * 60 * 1000) {
          history = [];
          since = 0;
        }
        const data = await window.api.getMetrics(since);
        if (!active) return;
        info = { ...data.process, totalsRequests: data.totals.requests, totalsErrors: data.totals.errors };
        if (data.storage) storage = data.storage;
        history = since ? history.concat(data.history).slice(-360) : data.history;
        live.textContent = 'Live';
        live.className = 'badge on';
        if (history.length) {
          const lastSample = history[history.length - 1];
          updated.textContent = `Letzter Messpunkt ${formatSampleTime(lastSample)}`;
          updated.title = new Date(lastSample.t).toLocaleString('de-DE');
        } else {
          updated.textContent = 'Verbindung aktiv · erster Messpunkt wird erwartet.';
          updated.removeAttribute('title');
        }
        updated.classList.remove('error');
        render();
      } catch (err) {
        if (!active) return;
        live.textContent = 'Fehler';
        live.className = 'badge off';
        const lastSample = history[history.length - 1];
        updated.textContent = lastSample
          ? `Aktualisierung fehlgeschlagen · letzter Messpunkt ${formatSampleTime(lastSample)}`
          : 'Messdaten konnten nicht geladen werden. Der nächste Abruf folgt in 10 Sekunden.';
        updated.classList.add('error');
        if (!lastSample) cards.replaceChildren(el('p', { class: 'hint error', text: updated.textContent }));
      }
    }

    function startPolling() {
      if (timer) return;
      live.textContent = 'Verbinde …';
      live.className = 'badge';
      updated.textContent = 'Messdaten werden geladen …';
      updated.classList.remove('error');
      load();
      timer = setInterval(() => { if (!document.hidden) load(); }, 10000);
    }
    function stopPolling() {
      clearInterval(timer);
      timer = null;
      live.textContent = 'Pausiert';
      live.className = 'badge';
      const lastSample = history[history.length - 1];
      updated.textContent = lastSample
        ? `Aktualisierung pausiert · letzter Messpunkt ${formatSampleTime(lastSample)}`
        : 'Aktualisierung pausiert.';
      updated.classList.remove('error');
    }

    document.addEventListener('admin-tab-change', (e) => {
      active = e.detail === 'monitor';
      if (active) {
        // beim Oeffnen einmal alles inkl. Speichergroessen laden, danach nur neue Messpunkte
        storage = null;
        history = [];
        startPolling();
      } else {
        stopPolling();
      }
    });
    // Diagramme an neue Breite anpassen (Drehen, Fenstergroesse)
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (active) render(); }, 150);
    });
    if (!$('.tab[data-tab="monitor"]').hidden) {
      active = true;
      startPolling();
    }
  }

  let appInitialized = false;
  document.addEventListener('DOMContentLoaded', async () => {
    if (location.protocol === 'file:') console.warn('%c[Security]%c App läuft lokal über file://. Für Produktion über HTTPS hosten.', 'color:#f2b8b5;font-weight:bold', 'color:inherit');

    const ok = await checkSession();
    if (!ok) return;

    bindAdminTheme();
    bindTabs();
    bindProfile();
    bindPlayerProgress();
    bindAvatarUpload();
    bindLinks();
    bindLinkDialog();
    bindCategories();
    bindQRCode();
    bindPreview();
    bindStats();
    bindApiKeys();
    initIconPicker();
    bindData();
    bindSettings();
    bindAuditLog();
    bindNavidrome();
    bindMusicAssistant();
    bindSpotify();
    bindInstagram();
    bindMonitor();

    if (!appInitialized) {
      appInitialized = true;
      initApp();
    }
  });
})();
