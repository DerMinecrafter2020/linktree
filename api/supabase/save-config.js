// =========================================================
// SupabaseAPI — Save Config (Schreibt URL in server-seitige config.js)
// =========================================================
// Wird vom Admin-Panel aufgerufen, wenn der User eine neue
// Supabase-URL eintippt. Die Server-Edge-Function 'save-config'
// schreibt die URL in /var/html/config.js zurueck.
//
// Verwendung:
//   await SupabaseAPI.saveConfig({
//     url: 'https://xxx.supabase.co',
//     anonKey: 'eyJhbGciOi...',
//     secret: 'shared-secret'  // optional, gegen Missbrauch
//   });
// =========================================================

window.SupabaseAPI = window.SupabaseAPI || {};
window.SupabaseAPI.saveConfig = async function ({ url, anonKey, secret }) {
  // Hardcoded Supabase-Project-Ref (siehe config.example.js oder ENV)
  // Da die URL selbst noch nicht im Browser ist (sonst braeuchten wir
  // diese Funktion nicht), leiten wir aus der uebergebenen URL den
  // Project-Ref ab.
  const m = String(url || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) throw new Error('Ungueltige Supabase-URL (Format: https://<ref>.supabase.co)');
  const projectRef = m[1];
  const endpoint = `https://${projectRef}.supabase.co/functions/v1/save-config`;

  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-config-secret'] = secret;

  const r = await fetch(endpoint, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ url: url, anonKey: anonKey }),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { ok: false, error: text }; }
  if (!r.ok || !json.ok) {
    throw new Error(json.error || ('HTTP ' + r.status));
  }
  return json;
};