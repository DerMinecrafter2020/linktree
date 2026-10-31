// =========================================================
// OpenWeb API-Client
// =========================================================

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
      if (json.field) err.field = json.field; // z. B. Kontaktformular: betroffenes Feld
      if (json.code) err.code = json.code;
      throw err;
    }
    return json.data;
  }

  const get = (path) => api('GET', path);
  const post = (path, body) => api('POST', path, body);
  const put = (path, body) => api('PUT', path, body);
  const patch = (path, body) => api('PATCH', path, body);
  const del = (path, body = null) => api('DELETE', path, body);

  window.api = {
    // Öffentlich
    getProfile: () => get('/profile'),
    getLegalContent: () => get('/legal-content'),
    getLinks: () => get('/links'),
    getLinkCategories: () => get('/links/categories'),
    trackLinkClick: (id, utm) => post(`/links/${id}/click`, { utm }),
    unlockLink: (id, password) => post(`/links/${id}/unlock`, { password }),

    // Auth
    login: (email, password, remember = false) => post('/login', { email, password, remember }),
    logout: () => post('/admin/logout'),
    me: () => get('/admin/me'),

    // Admin
    getDbInfo: () => get('/admin/db-info'),
    getServerInfo: () => get('/admin/server-info'),
    getAuditLog: () => get('/admin/audit-log'),
    getAdminLinks: () => get('/admin/links'),
    createLink: (link) => post('/admin/links', link),
    updateLink: (id, patchObj) => patch(`/admin/links/${id}`, patchObj),
    deleteLink: (id) => del(`/admin/links/${id}`),
    reorderLinks: (orderedIds) => post('/admin/links/reorder', { orderedIds }),
    checkLink: (id) => get(`/admin/links/${id}/check`),
    getLinkStats: (days = 30, tz = '') => get(`/admin/stats/links?days=${encodeURIComponent(days)}${tz ? `&tz=${encodeURIComponent(tz)}` : ''}`),

    getAdminLinkCategories: () => get('/admin/link-categories'),
    getQRCode: (text) => get(`/qr-code?text=${encodeURIComponent(text)}`),
    createLinkCategory: (cat) => post('/admin/link-categories', cat),
    updateLinkCategory: (id, cat) => patch(`/admin/link-categories/${id}`, cat),
    deleteLinkCategory: (id) => del(`/admin/link-categories/${id}`),

    getMetrics: (since = 0) => get(`/admin/metrics${since ? `?since=${encodeURIComponent(since)}` : ''}`),
    getDashboardIcons: (q = '') => get(`/admin/icons/dashboard?q=${encodeURIComponent(q)}`),
    resolveIcon: ({ icon = '', url = '', title = '' }) =>
      get(`/admin/icons/resolve?icon=${encodeURIComponent(icon)}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`),

    getAdminProfile: () => get('/admin/profile'),
    saveAdminProfile: (profile) => post('/admin/profile', profile),

    getAdminSettings: () => get('/admin/settings'),
    saveAdminSettings: (settings) => post('/admin/settings', settings),
    testDiscordWebhook: () => post('/admin/settings/discord/test'),

    getAlertSettings: () => get('/admin/alert-settings'),
    saveAlertSettings: (settings) => post('/admin/alert-settings', settings),
    getContactSettings: () => get('/admin/settings/contact'),
    saveContactSettings: (settings) => post('/admin/settings/contact', settings),
    testContactForm: () => post('/admin/settings/contact/test', {}),
    getContactToken: () => get('/contact/token'),
    sendContactMessage: (message) => post('/contact', message),
    testAlertSettings: () => post('/admin/alert-settings/test'),
    getBackups: () => get('/admin/backups'),
    createBackup: () => post('/admin/backups', {}),
    createEncryptionKeyBackup: (password, backupPassword) =>
      post('/admin/encryption-key/backup', { password, backupPassword }),
    restoreEncryptionKey: (payload) => post('/admin/encryption-key/restore', payload),
    getApiKeys: () => get('/admin/api-keys'),
    createApiKey: (name) => post('/admin/api-keys', { name }),
    deleteApiKey: (id) => del(`/admin/api-keys/${id}`),

    getMusicHistory: () => get('/admin/music-history'),

    getNavidromeSettings: () => get('/admin/settings/navidrome'),
    saveNavidromeSettings: (cfg) => post('/admin/settings/navidrome', cfg),
    // Ohne Argument: gespeicherte Werte pruefen; mit { url, username, password } bzw. { url, probe }: ohne Speichern
    testNavidromeConnection: (candidate) => post('/admin/settings/navidrome/test', candidate || {}),
    testNavidromeDiscordWebhook: (source) => post('/admin/settings/navidrome/discord-test', source ? { source } : {}),

    getInstagramSettings: () => get('/admin/settings/instagram'),
    saveInstagramSettings: (cfg) => post('/admin/settings/instagram', cfg),
    startInstagramAuthorization: () => post('/admin/settings/instagram/authorize'),
    disconnectInstagram: () => post('/admin/settings/instagram/disconnect'),
    syncInstagram: () => post('/admin/settings/instagram/sync'),

    getSpotifySettings: () => get('/admin/settings/spotify'),
    saveSpotifySettings: (cfg) => post('/admin/settings/spotify', cfg),
    startSpotifyAuthorization: () => post('/admin/settings/spotify/authorize'),
    disconnectSpotify: () => post('/admin/settings/spotify/disconnect'),
    testSpotifyConnection: () => post('/admin/settings/spotify/test'),

    getMusicAssistantSettings: () => get('/admin/settings/musicassistant'),
    saveMusicAssistantSettings: (cfg) => post('/admin/settings/musicassistant', cfg),
    getMusicAssistantUsers: () => get('/admin/settings/musicassistant/users'),
    // Ohne Argument: gespeicherte Werte pruefen; mit { url, token }: ohne Speichern
    testMusicAssistantConnection: (candidate) => post('/admin/settings/musicassistant/test', candidate || {}),

    exportData: () => get('/admin/export'),
    importData: (data) => post('/admin/import', data),
    importLinktreeCSV: (rows) => post('/admin/import/linktree-csv', { rows }),

    changePassword: (currentPassword, newPassword) => post('/admin/change-password', { currentPassword, newPassword }),

    // Navidrome (öffentlicher Proxy)
    navidromeNowPlaying: () => get('/navidrome/now-playing'),
    navidromeControl: (action) => post('/navidrome/control', { action }),

    // 2FA & WebAuthn
    get2faStatus: () => get('/admin/settings/2fa/status'),
    setupTotp: (password) => post('/admin/settings/2fa/totp/setup', { password }),
    verifyTotp: (code) => post('/admin/settings/2fa/totp/verify', { code }),
    disableTotp: (password) => post('/admin/settings/2fa/totp/disable', { password }),
    getWebauthnRegisterOptions: (password) => post('/admin/settings/2fa/webauthn/register-options', { password }),
    verifyWebauthnRegister: (res) => post('/admin/settings/2fa/webauthn/register-verify', res),
    deleteWebauthn: (id, password) => del(`/admin/settings/2fa/webauthn/${encodeURIComponent(id)}`, { password }),
    renameWebauthn: (id, name) => put(`/admin/settings/2fa/webauthn/${id}`, { name }),

    loginTotp: (code) => post('/login/totp', { code }),
    getWebauthnLoginOptions: () => post('/login/webauthn/options'),
    verifyWebauthnLogin: (res) => post('/login/webauthn/verify', res)
  };
})();
