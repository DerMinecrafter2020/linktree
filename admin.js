// =========================================================
// Admin-Logik (refactored)
// =========================================================
// Funktionen:
//   - Tab-Navigation
//   - Profil bearbeiten (inkl. Avatar-Upload)
//   - Links: CRUD + Drag & Drop + Pfeile
//   - Export / Import / Reset (JSON)
//   - Navidrome-Player-Konfiguration
//   - Realtime-Update über Supabase
//   - nginx Basic Auth-Logout
// =========================================================
(() => {
  'use strict';

  // ---- Konfiguration ----
  const AVATAR_MAX_PX = 512;
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
  const AVATAR_TARGET_BYTES = 80 * 1024;
  const POPULAR_IDS = ['instagram','tiktok','youtube','github','discord','twitch','spotify','x','linkedin','whatsapp','telegram','snapchat','reddit','facebook','figma','notion'];
  const TAB_TITLES = { links: 'Links', profile: 'Profil', music: 'Musik', data: 'Daten', settings: 'Einstellungen' };

  // ---- State ----
  const state = { profile: null, links: [] };

  // ---- App-Boot vereinfachen: nginx Basic Auth erledigt den Login ----
  const TAB_STORAGE_KEY = 'linktree-admin-active-tab';

  // ---- DOM helpers ----
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

  // ---- Text / URL helpers ----
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const safeText = (s, max = 200) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '';

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
    if (/^https?:\/\//i.test(t)) return safeUrl(t) || '🔗';
    return t.slice(0, 8).replace(/[<>"']/g, '');
  }



  // ---- Toast ----
  let toastTimer;
  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2500);
  }

  // ---- Icon rendering ----
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
      : /^https?:\/\//.test(value) ? value
      : value || 'Emoji / Text';
  }

  // ---- Tabs ----
  function switchTab(name) {
    name = TAB_TITLES[name] ? name : 'links';
    $$('.side-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach(t => t.hidden = t.dataset.tab !== name);
    $('#tab-title').textContent = TAB_TITLES[name];
    sessionStorage.setItem(TAB_STORAGE_KEY, name);
  }
  function bindTabs() {
    $$('.side-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    $('#logout-btn').addEventListener('click', () => browserLogout());
    const saved = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (saved && TAB_TITLES[saved]) switchTab(saved);
  }

  // ---- Connection status ----
  function setConnection(connState) {
    const el = $('#connection-state');
    if (el) {
      el.className = 'connection-state ' + connState;
      el.textContent = { ok: '● Supabase', mock: '● Setup fehlt', err: '● Offline' }[connState] || '● Offline';
    }
    const setEl = $('#settings-connection');
    const urlEl = $('#settings-url');
    if (setEl && urlEl) {
      const cfg = window.SUPABASE_CONFIG;
      const messages = {
        ok: '✅ Mit Supabase verbunden. Daten werden in der Cloud gespeichert.',
        mock: '⚠️ Supabase nicht konfiguriert. Bitte URL + Anon-Key unten eintragen.',
        err: '❌ Keine Verbindung. Prüfe Internet.'
      };
      setEl.textContent = messages[connState] || messages.err;
      urlEl.textContent = cfg?.url || '(keine URL)';
    }
  }

  // ---- Modals ----
  function makeModal(id, title, bodyNodes) {
    let modal = document.getElementById(id);
    if (modal) { modal.hidden = false; return modal; }
    modal = el('div', { id, class: 'modal-overlay' },
      el('div', { class: 'modal-card' },
        el('h2', { text: title }),
        ...bodyNodes
      )
    );
    modal.hidden = false;
    document.body.appendChild(modal);
    return modal;
  }

  function showSetupForm() {
    const err = el('p', { id: 'setup-error', class: 'form-error' });
    const form = el('form', { id: 'setup-form' },
      el('label', {}, el('span', { text: 'Supabase URL' }), el('input', { type: 'url', name: 'url', required: true, placeholder: 'https://… .supabase.co' })),
      el('label', {}, el('span', { text: 'anon-key' }), el('input', { type: 'text', name: 'anonKey', required: true, placeholder: 'eyJhbGciOi…' })),
      el('label', {}, el('span', { text: 'Shared Secret' }), el('input', { type: 'password', name: 'secret', placeholder: 'aus /var/html/.openweb.env (CONFIG_SHARED_SECRET)' })),
      el('div', { class: 'form-actions' }, el('button', { type: 'submit', class: 'btn primary', text: 'Speichern & neu laden' })),
      err
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.style.color = 'var(--text-dim)';
      err.textContent = 'Speichere…';
      const secret = form.secret.value.trim();
      try {
        await window.SupabaseAPI.saveConfig({
          url: form.url.value.trim(),
          anonKey: form.anonKey.value.trim(),
          secret: secret
        });
        window.setAdminSharedSecret?.(secret);
        err.style.color = 'var(--neon-lime)';
        err.textContent = 'Gespeichert! Lade neu…';
        setTimeout(() => location.reload(), 1500);
      } catch (err2) {
        err.style.color = 'var(--neon-red)';
        let msg = 'Fehler: ' + err2.message;
        if (err2.message.includes('401')) {
          msg += ' — Shared Secret falsch oder leer. Prüfe /var/html/.openweb.env (CONFIG_SHARED_SECRET) und trage es oben ein.';
        }
        err.textContent = msg;
      }
    });
    makeModal('supabase-setup-modal', '🔧 Supabase konfigurieren', [
      el('p', { text: 'Trage deine Supabase-Projekt-URL und den anon-Key ein. Diese werden in config.js auf dem Server gespeichert.' }),
      form
    ]);
  }

  // ---- Logout (Browser-Basic-Auth-Cache löschen) ----
  function browserLogout() {
    // Hinweis: Browser-Cache für Basic Auth kann nur durch reload mit 401 gelöscht werden.
    sessionStorage.removeItem(TAB_STORAGE_KEY);
    location.href = 'https://logout:logout@' + location.host + location.pathname;
  }

  // ---- nginx Basic Auth übernimmt das Login. Nur Logout-Button binden. ----
  function bindLogin() {
    $('#logout-btn').addEventListener('click', () => browserLogout());
  }

  // ---- Avatar ----
  function processAvatar(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Keine Datei'));
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error('Nur PNG, JPG, WebP oder GIF erlaubt.'));
      if (file.size > AVATAR_MAX_BYTES) return reject(new Error('Datei zu groß (max. 5 MB).'));
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

  // ---- Profile ----
  function bindProfile() {
    $('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const profile = {
        name: safeText(fd.get('name'), 80),
        handle: safeText(fd.get('handle'), 80),
        bio: safeText(fd.get('bio'), 280),
        avatar: String(fd.get('avatar') || '').trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 2) || 'CA'
      };
      const av = state.profile?.avatar_url;
      if (av !== undefined) {
        if (!av) profile.avatar_url = null;
        else if (/^data:image\/svg\+xml/i.test(av)) { toast('SVG-Avatare nicht erlaubt', true); return; }
        else if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(av)) { toast('Ungültiges Avatar-Format', true); return; }
        else if (av.length > 700_000) { toast('Avatar zu groß (max. 500 KB)', true); return; }
        else profile.avatar_url = av;
      }
      try {
        await window.db.saveProfile(profile);
        state.profile = await window.db.getProfile();
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
    updateAvatarPreview(state.profile.avatar_url || null);
  }

  // ---- Links ----
  function buildLinkRow(link) {
    const badgeCls = link.is_active ? 'on' : 'off';
    const actions = [
      { act: 'up', title: 'Nach oben', text: '↑' },
      { act: 'down', title: 'Nach unten', text: '↓' },
      { act: 'edit', title: 'Bearbeiten', text: '✎' },
      { act: 'del', title: 'Löschen', text: '🗑', cls: 'danger' }
    ];
    return el('li', { class: 'link-row', draggable: true, 'data-id': link.id },
      el('span', { class: 'link-handle', title: 'Ziehen zum Sortieren', text: '⠿' }),
      renderIcon(link.icon, 40),
      el('div', { class: 'link-info' },
        el('div', { class: 'title' },
          el('span', { text: link.title || '' }),
          el('span', { class: `badge ${badgeCls}`, text: link.is_active ? 'aktiv' : 'inaktiv' })
        ),
        el('div', { class: 'sub', text: link.url || '' })
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

  function renderLinks() {
    const list = $('#links-list');
    list.replaceChildren();
    if (!state.links.length) {
      list.appendChild(el('li', { class: 'hint', text: 'Noch keine Links – leg den ersten an.' }));
      return;
    }
    state.links.forEach(link => list.appendChild(buildLinkRow(link)));
  }

  function bindLinks() {
    $('#add-link-btn').addEventListener('click', () => openLinkDialog(null));
    $('#links-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const row = btn.closest('.link-row');
      const id = row.dataset.id;
      const idx = state.links.findIndex(l => l.id === id);
      if (idx < 0) return;
      try {
        if (btn.dataset.act === 'edit') openLinkDialog(state.links[idx]);
        else if (btn.dataset.act === 'del') {
          if (!confirm(`„${state.links[idx].title}" wirklich löschen?`)) return;
          await window.db.deleteLink(id);
          await reloadLinks();
          toast('🗑️ Gelöscht');
        } else if (btn.dataset.act === 'up' && idx > 0) await moveLink(idx, idx - 1);
        else if (btn.dataset.act === 'down' && idx < state.links.length - 1) await moveLink(idx, idx + 1);
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
    try { await window.db.reorderLinks(links.map(l => l.id)); } catch (err) { toast('Fehler: ' + err.message, true); }
  }

  // ---- Icon picker ----
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
      if (raw && !/^https?:\/\//.test(raw) && !raw.startsWith('simpleicon:') && window.icons?.getInfo?.(raw)) {
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

  // ---- Link dialog ----
  function openLinkDialog(link) {
    const dlg = $('#link-dialog');
    const form = $('#link-form');
    form.reset();
    $('#link-dialog-title').textContent = link ? 'Link bearbeiten' : 'Neuer Link';
    if (link) {
      form.title.value = link.title || '';
      form.subtitle.value = link.subtitle || '';
      form.url.value = link.url || '';
      form.icon.value = link.icon || '';
      form.is_active.checked = link.is_active !== false;
      form.open_new.checked = link.open_new !== false;
      form.dataset.id = link.id;
    } else {
      delete form.dataset.id;
      form.is_active.checked = true;
      form.open_new.checked = true;
    }
    refreshIconPreview();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeLinkDialog() {
    const dlg = $('#link-dialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function bindLinkDialog() {
    $('#link-cancel').addEventListener('click', closeLinkDialog);
    $('#link-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const urlClean = safeUrl(form.url.value);
      if (!urlClean) { toast('Ungültige URL (nur http, https oder mailto erlaubt)', true); return; }
      const data = {
        title: safeText(form.title.value, 80),
        subtitle: safeText(form.subtitle.value, 120),
        url: urlClean,
        icon: sanitizeIconField(form.icon.value),
        is_active: form.is_active.checked,
        open_new: form.open_new.checked
      };
      if (!data.title || !data.url) { toast('Titel und URL sind Pflicht', true); return; }
      try {
        if (form.dataset.id) { await window.db.updateLink(form.dataset.id, data); toast('✅ Gespeichert'); }
        else { await window.db.createLink({ ...data, position: state.links.length }); toast('✅ Hinzugefügt'); }
        closeLinkDialog();
        await reloadLinks();
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
  }

  // ---- Data ----
  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  }

  function bindData() {
    $('#export-btn').addEventListener('click', () => {
      downloadJSON({
        version: 1,
        exportedAt: new Date().toISOString(),
        profile: state.profile,
        links: state.links
      }, `linktree-backup-${new Date().toISOString().slice(0,10)}.json`);
      toast('📤 Exportiert');
    });

    $('#import-btn').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!confirm('Beim Import werden alle bestehenden Links und das Profil überschrieben. Fortfahren?')) { e.target.value = ''; return; }
      try {
        const data = JSON.parse(await file.text());
        if (data.profile && typeof data.profile === 'object') {
          const p = {
            name: safeText(data.profile.name, 80),
            handle: safeText(data.profile.handle, 80),
            bio: safeText(data.profile.bio, 280),
            avatar: String(data.profile.avatar || 'CA').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 2) || 'CA'
          };
          if (typeof data.profile.avatar_url === 'string' && data.profile.avatar_url.startsWith('data:image/')) p.avatar_url = data.profile.avatar_url.slice(0, 500_000);
          await window.db.saveProfile(p);
        }
        if (Array.isArray(data.links)) {
          for (const l of state.links) await window.db.deleteLink(l.id);
          for (let i = 0; i < data.links.length; i++) {
            const l = data.links[i];
            const urlClean = safeUrl(l.url);
            if (!urlClean) continue;
            await window.db.createLink({
              title: safeText(l.title, 80),
              subtitle: safeText(l.subtitle, 120),
              url: urlClean,
              icon: sanitizeIconField(l.icon),
              is_active: l.is_active !== false,
              open_new: l.open_new !== false,
              position: i
            });
          }
        }
        await reloadAll();
        toast('📥 Importiert');
      } catch (err) { toast('Import fehlgeschlagen: ' + err.message, true); }
      e.target.value = '';
    });

    $('#reset-btn').addEventListener('click', async () => {
      if (!confirm('Wirklich alles zurücksetzen? Das löscht alle Links und setzt das Profil zurück.')) return;
      try {
        for (const l of state.links) await window.db.deleteLink(l.id);
        await window.db.saveProfile({ name: '@corneliusahner', handle: 'Cornelius Ahner', bio: 'Azubi, 21 Jahre alt', avatar: 'CA' });
        const defaults = [
          { title: 'Instagram', subtitle: '@cornelius_0511', url: 'https://www.instagram.com/cornelius_0511/', icon: '📸', is_active: true, open_new: true, position: 0 },
          { title: 'GitHub', subtitle: 'Projekte auf Github', url: 'https://github.com/DerMinecrafter2020', icon: '💻', is_active: true, open_new: true, position: 1 },
          { title: 'Kontakt', subtitle: 'admin@derminecrafter2020.com', url: 'mailto:admin@derminecrafter2020.com', icon: '✉️', is_active: true, open_new: false, position: 2 }
        ];
        for (const d of defaults) await window.db.createLink(d);
        await reloadAll();
        toast('🔄 Zurückgesetzt');
      } catch (err) { toast('Fehler: ' + err.message, true); }
    });
  }

  // ---- Settings ----
  let adminEnabled = true;

  async function loadAdminStatus() {
    const statusText = $('#admin-status-text');
    const hint = $('#admin-status-hint');
    try {
      const res = await window.db.getAdminSettings();
      const s = res?.data || res || {};
      adminEnabled = typeof s.admin_enabled === 'boolean' ? s.admin_enabled : true;
      if (statusText) {
        statusText.textContent = adminEnabled
          ? '✅ Admin-Bereich ist aktiviert.'
          : '🔒 Admin-Bereich ist deaktiviert — nur dieser Status-Bildschirm ist verfügbar.';
      }
      applyAdminLock();
    } catch (err) {
      console.warn('[admin] Admin-Status konnte nicht geladen werden:', err.message);
      if (statusText) statusText.textContent = 'Status konnte nicht geladen werden.';
      if (hint) hint.textContent = 'Fehler: ' + err.message;
    }
  }

  function applyAdminLock() {
    if (adminEnabled) {
      document.body.classList.remove('admin-locked');
      return;
    }
    document.body.classList.add('admin-locked');
    // Alle Tabs außer Settings blockieren
    $$('.side-btn[data-tab]:not([data-tab="settings"])').forEach(btn => {
      btn.disabled = true;
      btn.title = 'Admin-Bereich deaktiviert';
    });
    // Alle Tab-Inhalte außer Settings ausblenden
    $$('.tab[data-tab]:not([data-tab="settings"])').forEach(t => t.hidden = true);
    // Titel anpassen
    $('#tab-title').textContent = 'Einstellungen';
  }

  function bindSettings() {
    const hint = $('#change-pw-hint');
    if (hint) {
      hint.textContent = 'Das Admin-Passwort liegt nur serverseitig in /etc/nginx/openweb-admin.htpasswd. Ändere es über "sudo bash install.sh" → "Passwort ändern".';
    }
  }

  // ---- Navidrome ----
  function saveNavidromeConfig(cfg) {
    window.NAVIDROME_CONFIG = Object.assign({}, window.NAVIDROME_CONFIG || {}, {
      enabled: !!cfg.enabled,
      proxyUrl: cfg.proxyUrl || '',
      pollIntervalSec: cfg.pollIntervalSec || 30
    });
  }

  function renderNavidromeForm() {
    const form = $('#navidrome-form');
    if (!form) return;
    const cfg = window.NAVIDROME_CONFIG || {
      enabled: false,
      proxyUrl: (window.SUPABASE_CONFIG?.url || '').replace(/\/$/, '') + '/functions/v1/navidrome-proxy',
      pollIntervalSec: 30
    };
    form.enabled.checked = !!cfg.enabled;
    form.proxyUrl.value = cfg.proxyUrl;
    form.pollIntervalSec.value = cfg.pollIntervalSec;
  }

  async function loadNavidromeSettings() {
    try {
      const res = await window.db.getAdminSettings();
      const s = res?.data || res || {};
      if (s.navidrome_proxy_url || s.navidrome_enabled !== undefined) {
        saveNavidromeConfig({
          enabled: !!s.navidrome_enabled,
          proxyUrl: s.navidrome_proxy_url || '',
          pollIntervalSec: Number(s.navidrome_poll_interval_sec) || 30,
        });
        renderNavidromeForm();
      }
    } catch (err) {
      console.warn('[admin] Navidrome-Settings konnten nicht geladen werden:', err.message);
    }
  }

  function bindNavidrome() {
    const form = $('#navidrome-form');
    if (!form || !window.db) return;
    renderNavidromeForm();
    if (!window.db.needsSetup) {
      loadNavidromeSettings();
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const proxyUrl = (form.proxyUrl.value || '').trim();
      const poll = parseInt(form.pollIntervalSec.value || '30', 10) || 30;
      if (proxyUrl && !/^https?:\/\//i.test(proxyUrl)) { toast('Proxy-URL muss mit http(s) beginnen', true); return; }
      if (form.enabled.checked && !proxyUrl) { toast('Bitte Proxy-URL eintragen oder Player deaktivieren', true); return; }
      const cfg = { enabled: !!form.enabled.checked, proxyUrl, pollIntervalSec: Math.min(600, Math.max(10, poll)) };
      try {
        await window.db.saveAdminSettings({
          navidrome_enabled: cfg.enabled,
          navidrome_proxy_url: cfg.proxyUrl,
          navidrome_poll_interval_sec: cfg.pollIntervalSec,
        });
        saveNavidromeConfig(cfg);
        toast('🎵 Navidrome-Einstellungen gespeichert');
      } catch (err) {
        toast('Fehler: ' + (err.message || 'Speichern fehlgeschlagen'), true);
      }
    });

    $('#navidrome-test-btn')?.addEventListener('click', async () => {
      const status = $('#navidrome-status');
      const proxyUrl = (form.proxyUrl.value || '').trim();
      if (!proxyUrl) { status.textContent = '❌ Proxy-URL fehlt'; return; }
      status.textContent = 'Prüfe…';
      const saved = window.NAVIDROME_CONFIG?.proxyUrl;
      window.NAVIDROME_CONFIG = Object.assign({}, window.NAVIDROME_CONFIG || {}, { proxyUrl });
      try {
        const s1 = await window.NavidromeAPI.status();
        if (!s1?.configured) {
          status.replaceChildren('❌ Secrets fehlen in Supabase.', el('br'), 'Lege sie an mit:', el('br'), el('code', { text: 'supabase secrets set NAVIDROME_URL=…' }));
          return;
        }
        const s2 = await window.NavidromeAPI.nowPlaying();
        if (!s2) { status.textContent = '❌ Status-Call fehlgeschagen'; return; }
        status.textContent = s2.playing ? `✅ ${s2.url} — spielt: ${s2.title} (${s2.artist})` : `✅ ${s2.url} — momentan läuft nichts`;
      } catch (err) { status.textContent = '❌ ' + (err.message || 'Netzwerkfehler'); }
      finally { if (saved !== undefined) window.NAVIDROME_CONFIG.proxyUrl = saved; }
    });
  }

  // ---- Reload ----
  async function reloadLinks() { state.links = await window.db.listLinks(); renderLinks(); }
  async function reloadAll() {
    [state.profile, state.links] = await Promise.all([window.db.getProfile(), window.db.listLinks()]);
    renderProfile();
    renderLinks();
  }

  // ---- App init ----
  async function initApp() {
    try {
      setConnection(window.db?.isMock ? 'mock' : 'ok');
      await reloadAll();
      if (window.db?.subscribe) window.db.subscribe(() => reloadAll());
    } catch (err) {
      setConnection('err');
      toast('Verbindung fehlgeschlagen: ' + err.message, true);
    }
  }

  // ---- Boot ----
  let appInitialized = false;
  document.addEventListener('DOMContentLoaded', async () => {
    if (location.protocol === 'file:') console.warn('%c[Security]%c App läuft lokal über file://. Für Produktion über HTTPS hosten.', 'color:#ff2bd6;font-weight:bold', 'color:inherit');
    bindLogin();
    bindTabs();
    bindProfile();
    bindAvatarUpload();
    bindLinks();
    bindLinkDialog();
    initIconPicker();
    bindData();
    bindSettings();
    bindNavidrome();

    // Keine Admin-Daten laden, wenn Supabase nicht initialisiert oder noch nicht konfiguriert ist
    if (!window.db || window.db.needsSetup) {
      showSetupForm();
      return;
    }

    // Admin-Status früh laden (auch wenn db noch nicht ready)
    loadAdminStatus();

    const start = () => {
      if (appInitialized) return;
      if (window.db) { appInitialized = true; initApp(); }
      else setTimeout(start, 50);
    };
    if (window.db && !appInitialized) { appInitialized = true; initApp(); }
    else window.addEventListener('supabase:ready', start);
  });
})();
