// =========================================================
// OpenWeb Admin-Logik
// =========================================================

(() => {
  'use strict';

  const AVATAR_MAX_PX = 512;
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
  const AVATAR_TARGET_BYTES = 80 * 1024;
  const POPULAR_IDS = ['instagram','tiktok','youtube','github','discord','twitch','spotify','x','linkedin','whatsapp','telegram','snapchat','reddit','facebook','figma','notion'];
  const DASHBOARD_ICON_IDS = ['plex','jellyfin','emby','navidrome','spotify','youtube','netflix','disneyplus','primevideo','protonmail','nextcloud','homeassistant','pihole','adguard','traefik','nginx','portainer','docker','github','gitlab','discord','telegram','whatsapp','reddit','twitch','instagram','tiktok'];
  const TAB_TITLES = { links: 'Links', stats: 'Statistik', apikeys: 'API-Keys', profile: 'Profil', music: 'Musik', data: 'Daten', settings: 'Einstellungen', audit: 'Audit-Log' };

  const state = { profile: null, links: [], navidrome: null };
  const TAB_STORAGE_KEY = 'openweb-admin-active-tab';

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

  function renderIcon(value, size = 40) {
    const span = el('span', { class: 'icon', style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px` });
    if (!value) { span.textContent = '🔗'; return span; }
    if (/^https?:\/\//.test(value)) {
      const img = el('img', { src: value, alt: '', referrerpolicy: 'no-referrer' });
      img.onerror = () => { span.textContent = '🔗'; };
      span.appendChild(img);
    } else if (value.startsWith('simpleicon:')) {
      const id = value.slice(11);
      if (window.icons?.getInfo?.(id)) {
        const img = el('img', { src: window.icons.url(id), alt: '' });
        img.onerror = () => { span.textContent = '🔗'; };
        span.appendChild(img);
      } else {
        span.textContent = '🔗';
      }
    } else if (value.startsWith('dashboardicon:')) {
      const parsed = window.icons?.parse?.(value);
      if (parsed?.url) {
        const img = el('img', { src: parsed.url, alt: '', referrerpolicy: 'no-referrer' });
        img.onerror = () => { span.textContent = '🔗'; };
        span.appendChild(img);
      } else {
        span.textContent = '🔗';
      }
    } else {
      span.textContent = value.toString().slice(0, 8);
    }
    return span;
  }

  function refreshIconPreview() {
    const input = $('#link-form [name="icon"]');
    const preview = $('#icon-preview-target');
    const previewName = $('#icon-preview-name');
    if (!input || !preview) return;
    const value = input.value;
    preview.replaceChildren(renderIcon(value, 32));
    previewName.textContent = value.startsWith('simpleicon:') ? `simpleicon: ${value.slice(11)}`
      : value.startsWith('dashboardicon:') ? value
      : /^https?:\/\//.test(value) ? value
      : value || 'Emoji / Text';
  }

  function switchTab(name) {
    name = TAB_TITLES[name] ? name : 'links';
    $$('.side-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach(t => t.hidden = t.dataset.tab !== name);
    $('#tab-title').textContent = TAB_TITLES[name];
    sessionStorage.setItem(TAB_STORAGE_KEY, name);
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
      location.href = '/login';
      return false;
    }
  }

  async function logout() {
    try {
      await window.api.logout();
    } catch (err) {
      console.warn('[logout]', err.message);
    }
    location.href = '/login';
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
        toast('✅ Profil gespeichert');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
  }

  function renderProfile() {
    if (!state.profile) return;
    const f = $('#profile-form');
    f.name.value = state.profile.name || '';
    f.handle.value = state.profile.handle || '';
    f.bio.value = state.profile.bio || '';
    f.avatar.value = state.profile.avatar || '';
    f.is_public.checked = state.profile.is_public !== false;
    f.allow_visitor_theme.checked = state.profile.allow_visitor_theme !== false;
    f.custom_css.value = state.profile.custom_css || '';
    updateAvatarPreview(state.profile.avatar_url || null);
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
      renderIcon(link.icon, 40),
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
      renderIcon(link.icon, 40),
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

    const selectIcon = (value) => {
      input.value = value;
      refreshIconPreview();
      panel.hidden = true;
      toggle.classList.remove('active');
    };

    const renderSuggested = () => {
      suggested.replaceChildren(...POPULAR_IDS.map(id => {
        const info = window.ICON_LIBRARY?.[id];
        const btn = el('button', { 'data-icon': `simpleicon:${id}`, title: info?.title || id },
          el('img', { src: window.icons.url(id), alt: '' }),
          ' ' + (info?.title || id)
        );
        btn.addEventListener('click', () => selectIcon(`simpleicon:${id}`));
        return btn;
      }));
      // Dashboardicons-Vorschläge als separate Gruppe
      const dashGroup = el('div', { class: 'icon-dash-group' });
      DASHBOARD_ICON_IDS.slice(0, 8).forEach(name => {
        const url = window.icons.dashboardUrl(name);
        const btn = el('button', { 'data-icon': `dashboardicon:${name}`, title: name },
          el('img', { src: url, alt: '', loading: 'lazy', onerror: function() { this.style.display='none'; } }),
          ' ' + name
        );
        btn.addEventListener('click', () => selectIcon(`dashboardicon:${name}`));
        dashGroup.appendChild(btn);
      });
      if (dashGroup.children.length) {
        suggested.appendChild(el('div', { class: 'icon-group-label', text: 'Dashboardicons (PNG):' }));
        suggested.appendChild(dashGroup);
      }
    };

    const renderGrid = (query = '') => {
      const q = query.toLowerCase();
      const entries = window.icons?.allEntries?.() || [];
      let matched = q
        ? entries.filter(e => e.id.includes(q) || e.title?.toLowerCase().includes(q) || e.matchAlias?.includes(q))
        : entries.filter(e => !e.matchAlias);
      const seen = new Set();
      matched = matched.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
      if (!matched.length) {
        grid.replaceChildren(el('div', { class: 'icon-empty', text: `Keine Treffer für „${query}"` }));
        return;
      }
      grid.replaceChildren(...matched.slice(0, 200).map(e => {
        const cell = el('div', { class: 'icon-cell', 'data-id': e.id, 'data-tip': e.title },
          el('img', { src: window.icons.url(e.id), alt: e.title, loading: 'lazy' })
        );
        cell.addEventListener('click', () => selectIcon(`simpleicon:${e.id}`));
        return cell;
      }));
      const current = (input.value || '').startsWith('simpleicon:') ? input.value.slice(11) : null;
      if (current) grid.querySelector(`[data-id="${current}"]`)?.classList.add('selected');
    };

    const suggestForCurrent = () => {
      const guess = window.icons?.detectFromUrl?.($('#link-form [name="url"]').value || '', $('#link-form [name="title"]').value || '');
      if (!guess || input.value) return;
      const info = window.ICON_LIBRARY?.[guess];
      const btn = el('button', { 'data-icon': `simpleicon:${guess}`, style: 'border-color:var(--neon-cyan);color:var(--neon-cyan)' },
        el('img', { src: window.icons.url(guess), alt: '' }),
        ' ✨ Empfohlen: ' + (info?.title || guess)
      );
      btn.addEventListener('click', () => selectIcon(`simpleicon:${guess}`));
      suggested.insertBefore(btn, suggested.firstChild);
    };

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.classList.toggle('active', !panel.hidden);
      if (!panel.hidden) { renderGrid(''); refreshIconPreview(); suggestForCurrent(); setTimeout(() => search.focus(), 50); }
    });

    input.addEventListener('input', () => {
      refreshIconPreview();
      const raw = input.value.trim();
      if (raw && !/^https?:\/\//.test(raw) && !raw.startsWith('simpleicon:') && !raw.startsWith('dashboardicon:') && window.icons?.getInfo?.(raw)) {
        input.value = `simpleicon:${raw}`;
        refreshIconPreview();
      }
    });

    let searchTimer;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderGrid(search.value.trim().toLowerCase()), 120);
    });

    grid.addEventListener('click', e => {
      const id = e.target.closest('.icon-cell')?.dataset?.id;
      if (id) selectIcon(`simpleicon:${id}`);
    });
    suggested.addEventListener('click', e => {
      const icon = e.target.closest('button[data-icon]')?.dataset?.icon;
      if (icon) selectIcon(icon);
    });

    renderSuggested();
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
    if (!summary || !list || !canvas) return;

    let currentDays = 30;

    function setRange(days) {
      currentDays = days;
      rangeGroup?.querySelectorAll('button').forEach(b => {
        b.classList.toggle('primary', parseInt(b.dataset.days, 10) === days);
      });
    }

    function drawChart(timeline, days) {
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const labels = [];
      const counts = [];
      const end = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        labels.push(key);
        const found = timeline.find(t => t.day === key);
        counts.push(found ? found.count : 0);
      }
      const max = Math.max(1, ...counts);

      // Gitter
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = h - 30 - (h - 50) * (i / 4);
        ctx.beginPath();
        ctx.moveTo(40, y);
        ctx.lineTo(w - 10, y);
        ctx.stroke();
      }

      // Balken
      const barPad = 4;
      const chartW = w - 50;
      const barW = chartW / days - barPad;
      counts.forEach((c, i) => {
        const x = 40 + i * (barW + barPad);
        const barH = (c / max) * (h - 50);
        const y = h - 30 - barH;
        const grad = ctx.createLinearGradient(0, y, 0, h - 30);
        grad.addColorStop(0, 'rgba(0, 240, 255, 0.9)');
        grad.addColorStop(1, 'rgba(138, 92, 255, 0.4)');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, Math.max(1, barW), barH);
      });

      // Achsenbeschriftung
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      const step = days > 14 ? Math.ceil(days / 7) : 1;
      for (let i = 0; i < days; i += step) {
        const x = 40 + i * (barW + barPad) + barW / 2;
        const date = new Date(labels[i]);
        ctx.fillText(`${date.getDate()}.${date.getMonth() + 1}.`, x, h - 12);
      }
    }

    async function render(days = currentDays) {
      setRange(days);
      try {
        const stats = await window.api.getLinkStats(days);
        summary.innerHTML = `
          <div class="stat-card"><strong>${stats.total.toLocaleString('de-DE')}</strong><span>Gesamtklicks</span></div>
          <div class="stat-card"><strong>${stats.links.length}</strong><span>Links</span></div>
        `;
        list.replaceChildren();
        stats.links.forEach(l => {
          const item = el('li', { class: 'stat-row' },
            el('div', { class: 'stat-info' },
              el('span', { class: 'stat-title', text: l.title || l.url }),
              el('span', { class: 'stat-url', text: l.url })
            ),
            el('div', { class: 'stat-counts' },
              el('span', { class: 'stat-clicks', text: `${l.clicks} Klicks` }),
              el('span', { class: 'stat-unique', text: `${l.unique_visitors} Unique` })
            )
          );
          list.appendChild(item);
        });
        drawChart(stats.timeline, stats.days);

        function renderBreakdown(container, items) {
          if (!container) return;
          container.replaceChildren();
          if (!items?.length) {
            container.appendChild(el('li', { class: 'hint', text: 'Keine Daten.' }));
            return;
          }
          items.forEach(i => {
            container.appendChild(el('li', { class: 'stat-row' },
              el('span', { class: 'stat-title', text: i.device_type || i.browser || i.os || i.country_code }),
              el('span', { class: 'stat-clicks', text: `${i.count} Klicks` })
            ));
          });
        }
        renderBreakdown(devicesEl, stats.devices);
        renderBreakdown(browsersEl, stats.browsers);
        renderBreakdown(osEl, stats.os);
        renderBreakdown(countriesEl, stats.countries);

        if (utmEl) {
          if (stats.utm?.length) {
            const table = el('table', { class: 'utm-table' });
            table.innerHTML = `<thead><tr><th>Quelle</th><th>Medium</th><th>Klicks</th></tr></thead>`;
            const tbody = el('tbody');
            stats.utm.forEach(u => {
              tbody.appendChild(el('tr', {},
                el('td', { text: u.source }),
                el('td', { text: u.medium }),
                el('td', { text: u.count })
              ));
            });
            table.appendChild(tbody);
            utmEl.replaceChildren(table);
          } else {
            utmEl.replaceChildren(el('p', { class: 'hint', text: 'Keine UTM-Parameter in diesem Zeitraum.' }));
          }
        }
      } catch (err) {
        summary.innerHTML = `<p class="hint error">Fehler: ${escapeHtml(err.message)}</p>`;
      }
    }

    // Neu zeichnen bei Resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 200);
    });

    rangeGroup?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-days]');
      if (!btn) return;
      render(parseInt(btn.dataset.days, 10));
    });

    function exportCSV() {
      const days = currentDays;
      window.api.getLinkStats(days).then(stats => {
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
            const v = String(c ?? '').replace(/"/g, '""');
            return /[;\n",]/.test(v) ? `"${v}"` : v;
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

    // Erst laden, wenn der Tab sichtbar wird
    const tab = document.querySelector('[data-tab="stats"]');
    const observer = new MutationObserver(() => {
      if (!tab.hidden) render(currentDays);
    });
    if (tab) {
      observer.observe(tab, { attributes: true, attributeFilter: ['hidden'] });
      if (!tab.hidden) render(currentDays);
    }
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

    const tab = document.querySelector('[data-tab="apikeys"]');
    if (tab) {
      const observer = new MutationObserver(() => { if (!tab.hidden) render(); });
      observer.observe(tab, { attributes: true, attributeFilter: ['hidden'] });
      if (!tab.hidden) render();
    }
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
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
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
        await window.api.importData(data);
        await reloadAll();
        toast('📥 Importiert');
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
    const dataTab = document.querySelector('[data-tab="data"]');
    if (dataTab) {
      const observer = new MutationObserver(() => { if (!dataTab.hidden) renderBackups(); });
      observer.observe(dataTab, { attributes: true, attributeFilter: ['hidden'] });
      if (!dataTab.hidden) renderBackups();
    }

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
    const tab = document.querySelector('[data-tab="audit"]');
    const observer = new MutationObserver(() => { if (!tab.hidden) render(); });
    if (tab) {
      observer.observe(tab, { attributes: true, attributeFilter: ['hidden'] });
      if (!tab.hidden) render();
    }
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
    } catch (err) {
      console.warn('[admin] Navidrome-Settings konnten nicht geladen werden:', err.message);
    }
  }

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
        if (!s?.configured) {
          status.textContent = '❌ Navidrome nicht konfiguriert oder nicht erreichbar';
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

  async function reloadCategories() { state.categories = await window.api.getLinkCategories(); }
  async function reloadLinks() { state.links = await window.api.getAdminLinks(); renderLinks(); }
  async function reloadAll() {
    [state.profile, state.links, state.categories] = await Promise.all([
      window.api.getAdminProfile(),
      window.api.getAdminLinks(),
      window.api.getLinkCategories(),
    ]);
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
      badge.textContent = 'Not playing';
      clearMarquee(titleEl);
      titleEl.textContent = 'Momentan läuft nichts';
      clearMarquee(metaEl);
      metaEl.textContent = 'Starte Musik in Navidrome, um die Vorschau zu sehen.';
      progressEl.textContent = '00:00 / 00:00';
      cover.classList.add('placeholder');
      cover.replaceChildren();
    }

    function renderTrack(track) {
      const state = track.paused ? 'paused' : 'playing';
      setState(state);
      badge.textContent = track.paused ? 'Stopped' : (track.isRadio ? '📡 LIVE' : 'Playing');
      applyMarquee(titleEl, escapeHtml(track.title || 'Unbekannt'));

      const parts = [];
      if (track.isRadio) {
        parts.push(escapeHtml(track.artist || 'Internetradio'));
      } else if (track.artist) {
        parts.push(escapeHtml(track.artist));
      }
      if (track.album && !track.isRadio) parts.push(escapeHtml(track.album));

      const bitrate = track.bitrate ? `${track.bitrate} kbps` : null;
      const extra = [];
      if (track.isRadio) extra.push('<span class="admin-np-radio-badge">📡 LIVE</span>');
      if (bitrate) extra.push(`Bitrate: <span class="admin-np-bitrate">${bitrate}</span>`);
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
      if (duration > 0) localPosition = Math.min(localPosition, duration);
      progressEl.textContent = `${formatDuration(localPosition)} / ${formatDuration(duration)}`;
    }

    function trackId(track) {
      return [track.title, track.artist, track.album].filter(Boolean).join('::');
    }

    async function tick() {
      try {
        const track = await window.NavidromeAPI.nowPlaying();
        if (!track || !track.playing) {
          if (currentTrack) renderIdle();
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
    }

    tick();
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(updateProgress, 1000);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, 30_000);
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

  let appInitialized = false;
  document.addEventListener('DOMContentLoaded', async () => {
    if (location.protocol === 'file:') console.warn('%c[Security]%c App läuft lokal über file://. Für Produktion über HTTPS hosten.', 'color:#ff2bd6;font-weight:bold', 'color:inherit');

    const ok = await checkSession();
    if (!ok) return;

    bindTabs();
    bindProfile();
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

    if (!appInitialized) {
      appInitialized = true;
      initApp();
    }
  });
})();
