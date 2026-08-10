// =========================================================
// OpenWeb API-Client
// =========================================================
// Ersatz für supabase-client.js

(() => {
  'use strict';

  const API_PREFIX = '/api';

  async function api(method, path, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_PREFIX}${path}`, opts);
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, error: text || `HTTP ${response.status}` };
    }

    if (!response.ok || !json.ok) {
      const err = new Error(json.error || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return json.data;
  }

  const get = (path) => api('GET', path);
  const post = (path, body) => api('POST', path, body);
  const patch = (path, body) => api('PATCH', path, body);
  const del = (path) => api('DELETE', path);

  window.api = {
    // Öffentlich
    getProfile: () => get('/profile'),
    getLinks: () => get('/links'),
    getLinkCategories: () => get('/link-categories'),
    trackLinkClick: (id) => post(`/links/${id}/click`, {}),

    // Auth
    login: (email, password) => post('/login', { email, password }),
    logout: () => post('/admin/logout'),
    me: () => get('/admin/me'),

    // Admin
    getDbInfo: () => get('/admin/db-info'),
    getAdminLinks: () => get('/admin/links'),
    createLink: (link) => post('/admin/links', link),
    updateLink: (id, patchObj) => patch(`/admin/links/${id}`, patchObj),
    deleteLink: (id) => del(`/admin/links/${id}`),
    reorderLinks: (orderedIds) => post('/admin/links/reorder', { orderedIds }),
    checkLink: (id) => get(`/admin/links/${id}/check`),
    getLinkStats: () => get('/admin/stats/links'),

    getLinkCategories: () => get('/admin/link-categories'),
    getQRCode: (text) => get(`/admin/qr-code?text=${encodeURIComponent(text)}`),
    createLinkCategory: (cat) => post('/admin/link-categories', cat),
    updateLinkCategory: (id, cat) => patch(`/admin/link-categories/${id}`, cat),
    deleteLinkCategory: (id) => del(`/admin/link-categories/${id}`),

    getAdminProfile: () => get('/admin/profile'),
    saveAdminProfile: (profile) => post('/admin/profile', profile),

    getAdminSettings: () => get('/admin/settings'),
    saveAdminSettings: (settings) => post('/admin/settings', settings),

    getNavidromeSettings: () => get('/admin/navidrome'),
    saveNavidromeSettings: (settings) => post('/admin/navidrome', settings),
    testNavidromeConnection: () => post('/admin/navidrome/test'),

    exportData: () => get('/admin/export'),
    importData: (data) => post('/admin/import', data),

    changePassword: (currentPassword, newPassword) => post('/admin/change-password', { currentPassword, newPassword }),

    // Navidrome (öffentlicher Proxy)
    navidromeNowPlaying: () => get('/navidrome/now-playing'),
    navidromeControl: (action) => post('/navidrome/control', { action }),
  };
})();
