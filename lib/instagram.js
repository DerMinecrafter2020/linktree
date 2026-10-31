// =========================================================
// Instagram-Profilabgleich (serverseitig)
// =========================================================
// Uebernimmt Profilbild, Beschreibung und auf Wunsch Namen aus dem eigenen Instagram-Konto.
// Offizieller Weg: "Business Login for Instagram" (nur Business-/Creator-Konten).
//   1. Anmeldung: https://www.instagram.com/oauth/authorize (Scope instagram_business_basic)
//   2. Code-Tausch: POST https://api.instagram.com/oauth/access_token -> kurzlebiger Token
//   3. Langlebiger Token (60 Tage): GET https://graph.instagram.com/access_token (ig_exchange_token)
//   4. Verlaengern: GET https://graph.instagram.com/refresh_access_token (ig_refresh_token,
//      fruehestens 24 h nach Ausstellung, solange der Token gueltig ist)
// App-Secret und Token liegen nur verschluesselt in instagram_settings; der Browser sieht sie nie.

const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { safeText } = require('./validators');
const redirectUris = require('./redirect-uri');

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH_URL = 'https://graph.instagram.com';
const GRAPH_VERSION = 'v26.0';
const SCOPES = ['instagram_business_basic'];
const CALLBACK_PATH = '/api/admin/instagram/callback';
const API_TIMEOUT_MS = 10_000;
const APP_ID_RE = /^\d{6,25}$/;
const APP_SECRET_RE = /^[A-Za-z0-9]{16,64}$/;
// Profilbilder kommen vom Instagram-/Facebook-CDN; andere Hosts werden nicht abgerufen
const AVATAR_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const AVATAR_TYPES = /^image\/(jpeg|png|webp|gif)$/;
const AVATAR_MAX_BYTES = 512 * 1024; // wie lib/validators.validateAvatarUrl
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_AFTER_MS = 7 * DAY_MS; // woechentlich verlaengern, weit vor Ablauf (60 Tage)

let syncInflight = null;

async function getSettings() {
  const { rows } = await db.query('SELECT * FROM instagram_settings WHERE id = 1 LIMIT 1');
  return rows[0] || null;
}

function isConfigured(settings) {
  return !!(settings && settings.app_id && settings.app_secret_encrypted);
}

function isConnected(settings) {
  return isConfigured(settings) && !!settings.access_token_encrypted;
}

function getRedirectUri(req) {
  return redirectUris.getRedirectUri(req, CALLBACK_PATH);
}

function getRedirectUriStatus(req) {
  return redirectUris.getRedirectUriStatus(req, CALLBACK_PATH);
}

function buildAuthorizeUrl(settings, state, redirectUri) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', settings.app_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('state', state);
  url.searchParams.set('enable_fb_login', '0');
  url.searchParams.set('force_reauth', 'true');
  return url.toString();
}

function igError(message, status, code) {
  const err = new Error(message);
  if (status) err.status = status;
  if (code !== undefined) err.code = code;
  return err;
}

// Fehlertext aus den verschiedenen Instagram-Antwortformaten lesen (nur fuer den Admin, gekuerzt)
function errorMessageOf(json) {
  const raw = json?.error?.message || json?.error_message || json?.error_description ||
    (typeof json?.error === 'string' ? json.error : '');
  return safeText(String(raw || ''), 200);
}

function errorCodeOf(json) {
  const code = json?.error?.code ?? json?.code;
  return code === undefined ? undefined : Number(code);
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

// GET gegen graph.instagram.com. Der Token steht in der Query (so verlangt es die API);
// URLs mit Token werden deshalb nie geloggt.
async function graphGet(path, params) {
  const url = new URL(path, GRAPH_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const json = await readJson(res);
  if (!res.ok || json.error) {
    throw igError(errorMessageOf(json) || `Instagram HTTP ${res.status}`, res.status, errorCodeOf(json));
  }
  return json;
}

// Code aus dem OAuth-Callback gegen einen langlebigen Token tauschen
async function exchangeCode(settings, code, redirectUri) {
  const secret = decrypt(settings.app_secret_encrypted);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: settings.app_id,
      client_secret: secret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code: String(code).replace(/#_$/, ''),
    }).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const json = await readJson(res);
  if (!res.ok || json.error || json.error_type) {
    throw igError(errorMessageOf(json) || `Instagram-Anmeldung fehlgeschlagen (HTTP ${res.status})`, res.status);
  }
  // Antwort ist je nach API-Stand in "data" verpackt oder flach
  const shortLived = Array.isArray(json.data) ? json.data[0] : json;
  if (!shortLived?.access_token) throw igError('Instagram hat keinen Zugriffstoken geliefert');
  const permissions = Array.isArray(shortLived.permissions)
    ? shortLived.permissions
    : String(shortLived.permissions || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (permissions.length && !permissions.includes('instagram_business_basic')) {
    throw igError('Die Berechtigung "instagram_business_basic" wurde nicht erteilt');
  }

  const longLived = await graphGet('/access_token', {
    grant_type: 'ig_exchange_token',
    client_secret: secret,
    access_token: shortLived.access_token,
  });
  if (!longLived.access_token) throw igError('Instagram hat keinen langlebigen Token geliefert');
  return {
    accessToken: longLived.access_token,
    expiresIn: Number(longLived.expires_in) || 60 * 24 * 3600,
    userId: shortLived.user_id != null ? String(shortLived.user_id) : null,
  };
}

async function refreshToken(token) {
  const json = await graphGet('/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: token });
  if (!json.access_token) throw igError('Instagram hat keinen verlaengerten Token geliefert');
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 60 * 24 * 3600 };
}

// Profil lesen. "biography" ist je nach Kontotyp/API-Stand nicht immer abrufbar – dann ohne.
async function fetchProfile(token) {
  const base = ['user_id', 'username', 'name', 'profile_picture_url'];
  let bioAvailable = true;
  let json;
  try {
    json = await graphGet(`/${GRAPH_VERSION}/me`, { fields: [...base, 'biography'].join(','), access_token: token });
  } catch (err) {
    if (err.code === 100 || /biography/i.test(err.message)) {
      bioAvailable = false;
      json = await graphGet(`/${GRAPH_VERSION}/me`, { fields: base.join(','), access_token: token });
    } else {
      throw err;
    }
  }
  const me = Array.isArray(json.data) ? json.data[0] || {} : json;
  if (bioAvailable && me.biography === undefined) bioAvailable = false;
  return {
    userId: me.user_id != null ? String(me.user_id) : (me.id != null ? String(me.id) : null),
    username: safeText(String(me.username || ''), 80),
    name: safeText(String(me.name || ''), 80),
    biography: bioAvailable ? String(me.biography || '') : null,
    pictureUrl: typeof me.profile_picture_url === 'string' ? me.profile_picture_url : null,
    bioAvailable,
  };
}

// Profilbild herunterladen und als Data-URL zurueckgeben (Instagram-Bildlinks laufen ab).
// Nur https vom Instagram-/Facebook-CDN, ohne Weiterleitungen, Bildtypen und Groesse begrenzt.
async function downloadAvatar(pictureUrl) {
  let url;
  try { url = new URL(pictureUrl); } catch { return null; }
  if (url.protocol !== 'https:' || !AVATAR_HOST_RE.test(url.hostname)) return null;
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!AVATAR_TYPES.test(type)) return null;
  if (Number(res.headers.get('content-length') || 0) > AVATAR_MAX_BYTES) return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > AVATAR_MAX_BYTES) return null;
    chunks.push(chunk);
  }
  return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
}

// Bio wie im Profil-Formular saeubern (Steuerzeichen raus, Zeilenumbrueche erlaubt, max. 280)
function cleanBio(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .slice(0, 280)
    .trim();
}

async function saveToken(accessToken, expiresIn, extra = {}) {
  const enc = encrypt(accessToken);
  await db.query(`
    UPDATE instagram_settings SET
      access_token_encrypted = $1,
      token_expires_at = NOW() + ($2::int * INTERVAL '1 second'),
      token_refreshed_at = NOW(),
      ig_user_id = COALESCE($3, ig_user_id),
      connected_at = COALESCE($4, connected_at),
      updated_at = NOW()
    WHERE id = 1
  `, [enc, Math.round(expiresIn), extra.userId || null, extra.connected ? new Date() : null]);
  return enc;
}

async function recordSync(ok, message, profile) {
  await db.query(`
    UPDATE instagram_settings SET
      last_sync_at = NOW(), last_sync_ok = $1, last_sync_message = $2,
      username = COALESCE($3, username), bio_available = COALESCE($4, bio_available),
      updated_at = NOW()
    WHERE id = 1
  `, [ok, safeText(String(message || ''), 480) || null, profile?.username || null,
    profile ? profile.bioAvailable : null]);
}

// Token bei Bedarf verlaengern (frueheste 24 h nach Ausstellung, sonst woechentlich)
async function ensureFreshToken(settings) {
  let token = decrypt(settings.access_token_encrypted);
  const refreshedAt = settings.token_refreshed_at ? new Date(settings.token_refreshed_at).getTime() : 0;
  const expiresAt = settings.token_expires_at ? new Date(settings.token_expires_at).getTime() : 0;
  const age = Date.now() - refreshedAt;
  const soonExpiring = expiresAt && expiresAt - Date.now() < 30 * DAY_MS;
  if (age >= DAY_MS && (age >= REFRESH_AFTER_MS || soonExpiring)) {
    const fresh = await refreshToken(token);
    await saveToken(fresh.accessToken, fresh.expiresIn);
    token = fresh.accessToken;
  }
  return token;
}

// Abgleich: Profil von Instagram holen und die gewaehlten Felder ins OpenWeb-Profil schreiben.
// force = auch ausfuehren, wenn der automatische Abgleich deaktiviert ist (Knopf im Admin).
async function syncNow({ force = false } = {}) {
  if (syncInflight) return syncInflight;
  syncInflight = (async () => {
    const settings = await getSettings();
    if (!isConnected(settings)) return { ok: false, skipped: true, message: 'Instagram ist nicht verbunden.' };
    if (!settings.enabled && !force) return { ok: false, skipped: true, message: 'Automatischer Abgleich ist deaktiviert.' };

    let profile;
    try {
      const token = await ensureFreshToken(settings);
      profile = await fetchProfile(token);
    } catch (err) {
      // Abgelaufener/widerrufener Token (OAuthException 190): Verbindung trennen, neu verbinden noetig
      const expired = err.code === 190 || err.status === 401;
      if (expired) {
        await db.query('UPDATE instagram_settings SET access_token_encrypted = NULL, token_expires_at = NULL, updated_at = NOW() WHERE id = 1');
      }
      const message = expired
        ? 'Die Instagram-Anmeldung ist abgelaufen oder wurde widerrufen. Bitte neu verbinden.'
        : 'Instagram nicht erreichbar: ' + (err.message || 'unbekannter Fehler');
      console.warn('[instagram] Abgleich fehlgeschlagen:', err.message);
      await recordSync(false, message, null);
      return { ok: false, message };
    }

    const sets = [];
    const values = [];
    const changed = [];
    const { rows } = await db.query('SELECT name, handle, bio, avatar_url FROM profile WHERE id = 1 LIMIT 1');
    const current = rows[0] || {};
    const set = (column, value, label) => {
      if (value === undefined || value === null || current[column] === value) return;
      values.push(value);
      sets.push(`${column} = $${values.length}`); // nur feste Spaltennamen
      changed.push(label);
    };

    if (settings.sync_avatar && profile.pictureUrl) {
      try {
        const dataUrl = await downloadAvatar(profile.pictureUrl);
        if (dataUrl) set('avatar_url', dataUrl, 'Profilbild');
      } catch (err) {
        console.warn('[instagram] Profilbild nicht ladbar:', err.message);
      }
    }
    if (settings.sync_bio && profile.bioAvailable) set('bio', cleanBio(profile.biography), 'Beschreibung');
    if (settings.sync_name && profile.username) {
      set('name', `@${profile.username}`.slice(0, 80), 'Name');
      set('handle', (profile.name || profile.username).slice(0, 80), 'Untertitel');
    }

    if (sets.length) {
      await db.query(`UPDATE profile SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`, values);
    }
    const parts = [changed.length ? `Übernommen: ${changed.join(', ')}` : 'Keine Änderungen'];
    if (settings.sync_bio && !profile.bioAvailable) parts.push('Beschreibung ist über die Instagram-API für dieses Konto nicht abrufbar');
    const message = parts.join(' · ');
    await recordSync(true, message, profile);
    return { ok: true, changed, username: profile.username, bioAvailable: profile.bioAvailable, message };
  })();
  try {
    return await syncInflight;
  } finally {
    syncInflight = null;
  }
}

// Taeglicher Abgleich (server.js): nur wenn aktiviert und der letzte Abgleich > 20 h her ist
async function syncIfDue() {
  try {
    const settings = await getSettings();
    if (!settings?.enabled || !isConnected(settings)) return;
    const last = settings.last_sync_at ? new Date(settings.last_sync_at).getTime() : 0;
    if (Date.now() - last < 20 * 60 * 60 * 1000) return;
    const result = await syncNow();
    console.log('[instagram] Abgleich:', result.message);
  } catch (err) {
    console.error('[instagram] Abgleich-Fehler:', err.message);
  }
}

module.exports = {
  SCOPES,
  CALLBACK_PATH,
  APP_ID_RE,
  APP_SECRET_RE,
  getSettings,
  isConfigured,
  isConnected,
  getRedirectUri,
  getRedirectUriStatus,
  buildAuthorizeUrl,
  exchangeCode,
  saveToken,
  fetchProfile,
  syncNow,
  syncIfDue,
  // fuer Tests
  _downloadAvatar: downloadAvatar,
  _cleanBio: cleanBio,
};
