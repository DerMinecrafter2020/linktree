// =========================================================
// Supabase-Client-Wrapper (über offizielles CDN)
// =========================================================
// Lädt die Supabase-Lib dynamisch und stellt ein globales
// `sb` (Supabase-Client) sowie `db` (Methoden-Wrapper) bereit.
//
// Sicherheits-Architektur:
//   • Read  → anon-Key (öffentlich, durch RLS-Policies geschützt)
//   • Write → bevorzugt via Edge-Function "admin-proxy"
//            (Service-Role-Key bleibt serverseitig!)
//            Fallback: direkter anon-Write (RLS-Policies müssen
//            dann Schreibzugriff für anon erlauben).
// =========================================================

(function () {
  'use strict';

  const SUPABASE_URL = window.SUPABASE_CONFIG?.url;
  const SUPABASE_KEY = window.SUPABASE_CONFIG?.anonKey;

  // Edge-Function URLs (optional)
  const ADMIN_PROXY_URL  = window.SUPABASE_CONFIG?.adminProxyUrl;
  const AUTH_LOGIN_URL   = window.SUPABASE_CONFIG?.authLoginUrl;
  const AUTH_CHANGE_PW   = window.SUPABASE_CONFIG?.authChangePasswordUrl;
  const AUTH_ENABLED     = !!window.SUPABASE_CONFIG?.authEnabled;

  // Session-Storage Keys (einmalig hier, damit andere Module übereinstimmen)
  const TOKEN_KEY   = 'admin-token';
  const TOKEN_TS    = 'admin-token-created';
  const TOKEN_EXP   = 'admin-token-exp';

  function getToken() { return sessionStorage.getItem(TOKEN_KEY) || null; }
  function setToken(token, expSec) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(TOKEN_TS, String(Date.now()));
    sessionStorage.setItem(TOKEN_EXP, String(expSec));
  }
  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_TS);
    sessionStorage.removeItem(TOKEN_EXP);
  }
  function isTokenValid() {
    const exp = parseInt(sessionStorage.getItem(TOKEN_EXP) || '0', 10);
    if (!exp) return false;
    // 60s Sicherheitspuffer
    return Date.now() < (exp * 1000) - 60_000;
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_KEY.startsWith('HIER_')) {
    console.warn('[db] Supabase ist nicht konfiguriert. Trage die Daten in config.js ein.');
    window.sb = null;
    window.db = mockDb();
    return;
  }

  // Supabase-Lib dynamisch laden
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  script.onload = () => {
    try {
      const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      window.sb = client;
      window.db = createDb(client);
      window.dispatchEvent(new Event('supabase:ready'));
    } catch (err) {
      console.error('[db] Supabase init failed:', err);
      window.db = mockDb();
      window.dispatchEvent(new Event('supabase:ready'));
    }
  };
  script.onerror = () => {
    console.error('[db] Konnte Supabase-Lib nicht laden (offline?) — fallback auf Mock');
    window.db = mockDb();
    window.dispatchEvent(new Event('supabase:ready'));
  };
  document.head.appendChild(script);

  // =========================================================
  // SCHREIBEN: bevorzugt via Edge-Function
  // =========================================================
  // Wenn authEnabled + gültiges JWT vorhanden → Header: Bearer <JWT>
  // Edge-Function nutzt SERVICE_ROLE_KEY und JWT-Verifikation.
  //
  // Fallback (kein authEnabled): anon-Key + token im Body.
  async function adminProxy(action, data, token, extra) {
    if (!ADMIN_PROXY_URL) {
      throw new Error('adminProxyUrl nicht konfiguriert — siehe supabase/functions/admin-proxy/README');
    }
    // extra (z.B. { id }) wird als Top-Level-Feld gemerged, damit die
    // Edge-Function es als body.id / body.X lesen kann.
    // body.data bleibt separat (für validateLink etc.).
    return await window.SupabaseAPI.adminProxy({
      url: ADMIN_PROXY_URL,
      token: token,
      action: action,
      data: data || {},
      extra: extra || {},
      authEnabled: AUTH_ENABLED,
      anonKey: SUPABASE_KEY,
    });
  }

  // =========================================================
  // AUTH: Server-seitige Passwortprüfung + JWT
  // =========================================================
  // Die Funktion auth-init (One-Time-Setup) ist absichtlich
  // NICHT im Client verfügbar: Sie braucht SERVICE_ROLE_KEY
  // und darf nur via curl auf der Konsole aufgerufen werden.
  // Siehe DEPLOYMENT.md Schritt 4.
  async function authLogin(password, honeypot) {
    if (!AUTH_LOGIN_URL) throw new Error('authLoginUrl nicht konfiguriert');
    return await window.SupabaseAPI.authLogin({
      url: AUTH_LOGIN_URL,
      password: password,
      honeypot: honeypot,
      onToken: (token, expiresAt) => setToken(token, expiresAt),
    });
  }

  async function authChangePassword(oldPassword, newPassword) {
    if (!AUTH_CHANGE_PW) throw new Error('authChangePasswordUrl nicht konfiguriert');
    const token = getToken();
    if (!token) throw new Error('nicht eingeloggt');
    return await window.SupabaseAPI.authChangePassword({
      url: AUTH_CHANGE_PW,
      token: token,
      oldPassword: oldPassword,
      newPassword: newPassword,
    });
  }

  function createDb(client) {
    // Defense-in-Depth: Wenn KEIN Edge-Proxy und KEIN Edge-Auth
    // konfiguriert ist, blocken wir Schreiboperationen komplett.
    // Grund: anon-Writes wären über den anon-Key möglich, das
    // war vor dem Server-Side-Auth ein bewusstes Restrisiko.
    // Mit aktivem Edge-Auth/Proxy ist Schreiben ausschließlich
    // über die signierten Edge-Functions möglich.
    const ALLOW_DIRECT_WRITES = !!ADMIN_PROXY_URL;

    return {
      isMock: false,
      usesProxy: !!ADMIN_PROXY_URL,
      authEnabledFlag: AUTH_ENABLED,
      allowsDirectWrites: ALLOW_DIRECT_WRITES,

      // ---- AUTH ----
      isLoggedIn() { return AUTH_ENABLED && isTokenValid(); },
      getToken() { return getToken(); },
      async login(password, honeypot) {
        return authLogin(password, honeypot);
      },
      async changePassword(oldPw, newPw) {
        return authChangePassword(oldPw, newPw);
      },
      logout() { clearToken(); },

      async getProfile() {
        const { data, error } = await client
          .from('profile').select('*').eq('id', 1).maybeSingle();
        if (error) throw error;
        return data;
      },

      async saveProfile(profile) {
        // Bei aktiviertem Edge-Auth: nur ueber Proxy schreiben
        if (AUTH_ENABLED && ADMIN_PROXY_URL) {
          return adminProxy('saveProfile', profile, getToken());
        }
        // Fallback: ohne Edge-Auth direkt via REST schreiben.
        // Voraussetzung: RLS-Policies muessen Schreibzugriff erlauben
        // (siehe fix-policies.sql).
        const { data, error } = await client
          .from('profile').update(profile).eq('id', 1).select().maybeSingle();
        if (error) throw error;
        if (!data) {
          // RLS hat den Write stillschweigend geblockt. Das passiert wenn
          // eine Tabelle RLS aktiv hat aber keine passende Policy für anon.
          // Wir werfen einen klaren Fehler statt den User im Unklaren zu lassen.
          throw new Error('saveProfile fehlgeschlagen: RLS-Policy blockt anon-Write. Setze adminProxyUrl + authEnabled=true oder lockere RLS-Policy.');
        }
        return data;
      },

      async listLinks() {
        const { data, error } = await client
          .from('links').select('*').order('position', { ascending: true });
        if (error) throw error;
        return data || [];
      },

      async createLink(link) {
        if (AUTH_ENABLED && ADMIN_PROXY_URL) {
          return adminProxy('createLink', link, getToken());
        }
        const { data, error } = await client
          .from('links').insert(link).select().maybeSingle();
        if (error) throw error;
        return data;
      },

      async updateLink(id, patch) {
        if (AUTH_ENABLED && ADMIN_PROXY_URL) {
          // id muss mitgeschickt werden — die Edge-Function liest body.id
          return adminProxy('updateLink', patch, getToken(), { id: id });
        }
        const { data, error } = await client
          .from('links').update(patch).eq('id', id).select().maybeSingle();
        if (error) throw error;
        return data;
      },

      async deleteLink(id) {
        if (AUTH_ENABLED && ADMIN_PROXY_URL) {
          return adminProxy('deleteLink', null, getToken(), { id: id });
        }
        const { error } = await client.from('links').delete().eq('id', id);
        if (error) throw error;
        return true;
      },

      async reorderLinks(orderedIds) {
        if (AUTH_ENABLED && ADMIN_PROXY_URL) {
          return adminProxy('reorderLinks', { orderedIds }, getToken());
        }
        // Sequenzielle Updates — eine Transaktion ist auf REST-Ebene nicht trivial
        for (let i = 0; i < orderedIds.length; i++) {
          const { error } = await client
            .from('links').update({ position: i }).eq('id', orderedIds[i]);
          if (error) throw error;
        }
        return true;
      },

      subscribe(onChange) {
        return client
          .channel('links-and-profile')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'links' },
            () => onChange('links'))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profile' },
            () => onChange('profile'))
          .subscribe();
      }
    };
  }

  // =========================================================
  // Mock-DB: lokale Fallback-Lösung, falls Supabase nicht
  // konfiguriert ist. Daten liegen in localStorage.
  // =========================================================
  function mockDb() {
    const STORAGE_KEY = 'linktree-mock-db';
    const defaultData = {
      profile: {
        id: 1,
        name: '@corneliusahner',
        handle: 'Cornelius Ahner',
        bio: 'Azubi, 21 Jahre alt',
        avatar: 'CA'
      },
      links: [
        { id: cryptoId(), title: 'Instagram', subtitle: '@cornelius_0511', url: 'https://www.instagram.com/cornelius_0511/', icon: '📸', position: 0, is_active: true, open_new: true },
        { id: cryptoId(), title: 'GitHub',    subtitle: 'Projekte auf Github', url: 'https://github.com/DerMinecrafter2020', icon: '💻', position: 1, is_active: true, open_new: true },
        { id: cryptoId(), title: 'Kontakt',   subtitle: 'admin@derminecrafter2020.com', url: 'mailto:admin@derminecrafter2020.com', icon: '✉️', position: 2, is_active: true, open_new: false }
      ]
    };

    function cryptoId() {
      if (window.crypto?.randomUUID) return crypto.randomUUID();
      return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    function load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return structuredClone(defaultData);
        return JSON.parse(raw);
      } catch { return structuredClone(defaultData); }
    }
    function save(state) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    return {
      isMock: true,

      async getProfile() {
        return load().profile;
      },

      async saveProfile(profile) {
        const state = load();
        state.profile = { ...state.profile, ...profile };
        save(state);
      },

      async listLinks() {
        return load().links.sort((a, b) => a.position - b.position);
      },

      async createLink(link) {
        const state = load();
        const next = { id: cryptoId(), is_active: true, open_new: true, position: state.links.length, ...link };
        state.links.push(next);
        save(state);
        return next;
      },

      async updateLink(id, patch) {
        const state = load();
        const i = state.links.findIndex((l) => l.id === id);
        if (i >= 0) { state.links[i] = { ...state.links[i], ...patch }; save(state); }
      },

      async deleteLink(id) {
        const state = load();
        state.links = state.links.filter((l) => l.id !== id);
        save(state);
      },

      async reorderLinks(orderedIds) {
        const state = load();
        orderedIds.forEach((id, idx) => {
          const link = state.links.find((l) => l.id === id);
          if (link) link.position = idx;
        });
        save(state);
      },

      subscribe() {
        // localStorage hat keine Realtime-Subscriptions
        return { unsubscribe() {} };
      }
    };
  }
})();
