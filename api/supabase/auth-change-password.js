// =========================================================
// SupabaseAPI — Auth Change Password
// =========================================================
// Passwort ändern via auth-change-password Edge-Function.
// Erfordert eingeloggtes JWT.
//
// Verwendung:
//   await SupabaseAPI.authChangePassword({
//     url: window.SUPABASE_CONFIG.authChangePasswordUrl,
//     token: getToken(),
//     oldPassword: '...',
//     newPassword: '...',
//   });
// =========================================================

window.SupabaseAPI = window.SupabaseAPI || {};
window.SupabaseAPI.authChangePassword = async function ({ url, token, oldPassword, newPassword }) {
  if (!url) throw new Error('authChangePasswordUrl not set');
  if (!token) throw new Error('not logged in');
  return await window.SupabaseHelpers.postJSON(
    url,
    { 'Authorization': 'Bearer ' + token },
    { old_password: oldPassword, new_password: newPassword }
  );
};