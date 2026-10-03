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
      if (f.icon_style) f.icon_style.value = state.profile.icon_style === 'color' ? 'color' : 'white';
      f.custom_css.value = state.profile.custom_css || '';
      updateAvatarPreview(state.profile.avatar_url || null);
    }
    
    const fLegal = $('#legal-form');
    if (fLegal) {
      fLegal.impressum_text.value = state.profile.impressum_text || '';
      fLegal.datenschutz_text.value = state.profile.datenschutz_text || '';
    }
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
        const found = timeline.find(t => String(t.day).slice(0, 10) === key);
        counts.push(found ? found.count : 0);
      }
      const max = Math.max(1, ...counts);

      // Farben aus den M3-Farbrollen (admin.css) lesen
      const css = getComputedStyle(document.documentElement);
      const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      const primary = color('--md-primary', '#d0bcff');
      const primaryContainer = color('--md-primary-container', '#4f378b');

      // Gitter
      ctx.strokeStyle = color('--md-outline-variant', '#49454f');
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
        grad.addColorStop(0, primary);
        grad.addColorStop(1, primaryContainer);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, Math.max(1, barW), barH);
      });

      // Achsenbeschriftung
      ctx.fillStyle = color('--md-on-surface-variant', '#cac4d0');
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
          <div class="stat-card"><strong>${stats.musicHistory?.length || 0}</strong><span>Songs gehört</span></div>
        `;
        
        if (window.renderMusicHistory) {
          window.renderMusicHistory(stats.musicHistory || []);
        }

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
      if (!tab.hidden) {
        render(currentDays);
      }
    });
    if (tab) {
      observer.observe(tab, { attributes: true, attributeFilter: ['hidden'] });
      if (!tab.hidden) {
        render(currentDays);
      }
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

        return el('li', { class: 'stat-row' },
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

  async function loadMusicAssistantSettings() {
    try {
      state.musicassistant = await window.api.getMusicAssistantSettings();
      renderMusicAssistantForm();
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
  }

  function bindMusicAssistant() {
    const form = $('#musicassistant-form');
    if (!form || !window.api) return;
    loadMusicAssistantSettings();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = (form.url.value || '').trim();
      const token = form.token.value;
      if (form.enabled.checked && !url) {
        toast('URL ist Pflicht, wenn der Player aktiviert ist', true);
        return;
      }
      const cfg = {
        enabled: !!form.enabled.checked,
        url,
        token
      };
      try {
        await window.api.saveMusicAssistantSettings(cfg);
        state.musicassistant = await window.api.getMusicAssistantSettings();
        renderMusicAssistantForm();
        toast('🎵 Music Assistant-Einstellungen gespeichert');
      } catch (err) {
        toast('Fehler: ' + (err.message || 'Speichern fehlgeschlagen'), true);
      }
    });
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
      badge.textContent = 'Not playing';
      clearMarquee(titleEl);
      titleEl.textContent = 'Momentan läuft nichts';
      clearMarquee(metaEl);
      metaEl.textContent = 'Starte Musik im aktiven Player, um die Vorschau zu sehen.';
      progressEl.textContent = '00:00 / 00:00';
      cover.classList.add('placeholder');
      cover.replaceChildren();
    }

    function renderTrack(track) {
      const state = track.paused ? 'paused' : 'playing';
      setState(state);
      const sourceName = track.source === 'musicassistant' ? 'MA' : 'ND';
      badge.textContent = `${sourceName} | ${track.paused ? 'Stopped' : (track.isRadio ? '📡 LIVE' : 'Playing')}`;
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

    // Einfaches Liniendiagramm (mehrere Reihen, gefuellte Flaeche fuer die erste)
    function drawChart(canvas, series, { unit = '', min = 0 } = {}) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 140;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const pad = { l: 48, r: 8, t: 8, b: 20 };
      const all = series.flatMap(sr => sr.values);
      const rawMax = Math.max(...all, 0);
      const max = rawMax <= 0 ? 1 : rawMax * 1.15;
      const n = Math.max(...series.map(sr => sr.values.length), 2);
      const x = (i) => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
      const y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * (h - pad.t - pad.b);

      // Hilfslinien + Beschriftung
      ctx.strokeStyle = css('--md-outline-variant');
      ctx.fillStyle = css('--md-on-surface-variant');
      ctx.font = '11px ' + (css('--md-font') || 'sans-serif');
      ctx.lineWidth = 1;
      for (let g = 0; g <= 2; g++) {
        const v = min + ((max - min) * g) / 2;
        const gy = y(v);
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(w - pad.r, gy); ctx.stroke();
        ctx.globalAlpha = 1;
        const label = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
        ctx.fillText(`${label}${unit}`, 4, gy + 4);
      }
      ctx.fillText(`vor ${Math.max(1, Math.round((n * 10) / 60))} min`, pad.l, h - 4);
      const nowLabel = 'jetzt';
      ctx.fillText(nowLabel, w - pad.r - ctx.measureText(nowLabel).width, h - 4);

      series.forEach((sr, idx) => {
        const vals = sr.values;
        if (!vals.length) return;
        const offset = n - vals.length;
        ctx.beginPath();
        vals.forEach((v, i) => { const px = x(i + offset), py = y(v); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.strokeStyle = sr.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
        if (idx === 0) {
          ctx.lineTo(x(n - 1), y(min));
          ctx.lineTo(x(offset), y(min));
          ctx.closePath();
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = sr.color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      });
    }

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

      const primary = css('--md-primary');
      const tertiary = css('--md-tertiary');
      drawChart($('#monitor-chart-cpu'), [{ values: history.map(s => s.cpu), color: primary }], { unit: ' %' });
      drawChart($('#monitor-chart-mem'), [
        { values: history.map(s => s.rss / 1048576), color: primary },
        { values: history.map(s => s.heapUsed / 1048576), color: tertiary },
      ], { unit: ' MB' });
      drawChart($('#monitor-chart-req'), [
        { values: history.map(s => s.reqPerMin), color: primary },
        { values: history.map(s => s.errPerMin), color: css('--md-error') },
      ]);
      drawChart($('#monitor-chart-resp'), [
        { values: history.map(s => s.respAvgMs), color: primary },
        { values: history.map(s => s.respP95Ms), color: tertiary },
      ], { unit: ' ms' });

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
    bindMusicAssistant();
    bindMonitor();

    if (!appInitialized) {
      appInitialized = true;
      initApp();
    }
  });
})();
