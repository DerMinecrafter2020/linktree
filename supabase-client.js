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

  // Edge-Function URL (optional)
  const ADMIN_PROXY_URL  = window.SUPABASE_CONFIG?.adminProxyUrl;

  // Shared Secret fuer admin-proxy/save-config.
  // Wird erst im Admin-Panel eingegeben (aus /var/html/.openweb.env)
  // und NICHT in config.js gespeichert.
  let sharedSecret = '';

  if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_KEY.startsWith('YOUR-') || SUPABASE_KEY.startsWith('HIER_')) {
    console.warn('[db] Supabase ist nicht konfiguriert. Bitte URL + Key im Admin-Panel eintragen.');
    window.sb = null;
    window.db = needsSetupDb();
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
  async function adminProxy(action, data, extra) {
    if (!ADMIN_PROXY_URL) {
      throw new Error('adminProxyUrl nicht konfiguriert — siehe supabase/functions/admin-proxy/README');
    }
    if (!sharedSecret) {
      sharedSecret = prompt('🔐 Shared Secret aus /var/html/.openweb.env (CONFIG_SHARED_SECRET):');
      if (!sharedSecret) throw new Error('Shared Secret erforderlich');
    }
    return await window.SupabaseAPI.adminProxy({
      url: ADMIN_PROXY_URL,
      action: action,
      data: data || {},
      extra: extra || {},
      anonKey: SUPABASE_KEY,
      secret: sharedSecret,
    });
  }

  window.setAdminSharedSecret = function (v) {
    sharedSecret = String(v || '').trim();
  };

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
      allowsDirectWrites: ALLOW_DIRECT_WRITES,
      setSharedSecret(v) { sharedSecret = String(v || '').trim(); },

      // Login geschieht über nginx Basic Auth; kein Browser-Token nötig.
      logout() { /* Basic-Auth-Cache wird via admin.js zurückgesetzt */ },

      async getProfile() {
        const { data, error } = await client
          .from('profile').select('*').eq('id', 1).maybeSingle();
        if (error) throw error;
        return data;
      },

      async saveProfile(profile) {
        if (ADMIN_PROXY_URL) {
          return adminProxy('saveProfile', profile);
        }
        const { data, error } = await client
          .from('profile').update(profile).eq('id', 1).select().maybeSingle();
        if (error) throw error;
        if (!data) {
          throw new Error('saveProfile fehlgeschlagen: RLS-Policy blockt anon-Write. Setze adminProxyUrl oder lockere RLS-Policy.');
        }
        return data;
      },

      async getAdminSettings() {
        if (ADMIN_PROXY_URL) {
          return adminProxy('getAdminSettings');
        }
        throw new Error('getAdminSettings erfordert adminProxyUrl');
      },

      async saveAdminSettings(settings) {
        if (ADMIN_PROXY_URL) {
          return adminProxy('saveAdminSettings', settings);
        }
        throw new Error('saveAdminSettings erfordert adminProxyUrl');
      },

      async sendDiscordWebhook(track) {
        const url = window.SUPABASE_CONFIG?.discordWebhookUrl;
        if (!url) {
          // Kein Fehler werfen: bei Updates kann config.js kurzzeitig
          // fehlen, Discord ist optional.
          return { sent: false, reason: 'discordWebhookUrl nicht konfiguriert' };
        }
        // Kein Admin-Token nötig: die Edge Function liest die Webhook-URL
        // serverseitig aus admin_settings und postet selbst zu Discord.
        return window.SupabaseAPI.discordWebhook({
          url,
          track,
          anonKey: SUPABASE_KEY,
        });
      },

      async listLinks() {
        const { data, error } = await client
          .from('links').select('*').order('position', { ascending: true });
        if (error) throw error;
        return data || [];
      },

      async createLink(link) {
        if (ADMIN_PROXY_URL) {
          return adminProxy('createLink', link);
        }
        const { data, error } = await client
          .from('links').insert(link).select().maybeSingle();
        if (error) throw error;
        return data;
      },

      async updateLink(id, patch) {
        if (ADMIN_PROXY_URL) {
          return adminProxy('updateLink', patch, { id: id });
        }
        const { data, error } = await client
          .from('links').update(patch).eq('id', id).select().maybeSingle();
        if (error) throw error;
        return data;
      },

      async deleteLink(id) {
        if (ADMIN_PROXY_URL) {
          return adminProxy('deleteLink', null, { id: id });
        }
        const { error } = await client.from('links').delete().eq('id', id);
        if (error) throw error;
        return true;
      },

      async reorderLinks(orderedIds) {
        if (ADMIN_PROXY_URL) {
          return adminProxy('reorderLinks', { orderedIds });
        }
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
  // needsSetupDb: Supabase ist nicht konfiguriert
  // =========================================================
  // Wir geben eine DB zurueck, deren Methoden klar signalisieren,
  // dass Supabase konfiguriert werden muss. Das Admin-Panel zeigt
  // dann ein Setup-Formular mit URL + Anon-Key Eingabefeldern.
  function needsSetupDb() {
    const err = new Error('Supabase nicht konfiguriert — bitte im Setup-Form eintragen');
    return {
      isMock: true,
      needsSetup: true,
      async getProfile() { throw err; },
      async saveProfile() { throw err; },
      async getAdminSettings() { throw err; },
      async saveAdminSettings() { throw err; },
      async sendDiscordWebhook() { throw err; },
      async listLinks() { throw err; },
      async createLink() { throw err; },
      async updateLink() { throw err; },
      async deleteLink() { throw err; },
      async reorderLinks() { throw err; },
      subscribe() { return { unsubscribe() {} }; }
    };
  }
})();
