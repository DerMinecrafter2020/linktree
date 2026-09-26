// Ausgelagert aus login.html (CSP ohne 'unsafe-inline')
(() => {
  'use strict';
  const loginForm = document.getElementById('login-form');
  const totpForm = document.getElementById('totp-form');
  const webauthnContainer = document.getElementById('webauthn-container');
  const webauthnBtn = document.getElementById('webauthn-btn');
  const errorEl = document.getElementById('login-error');
  const descEl = document.getElementById('login-desc');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const email = loginForm.email.value.trim();
    const password = loginForm.password.value;
    const remember = loginForm.remember?.checked || false;
    try {
      const res = await window.api.login(email, password, remember);
      if (res && res.requires_2fa) {
        loginForm.hidden = true;
        descEl.textContent = 'Zwei-Faktor-Authentifizierung erforderlich.';
        if (res.methods.includes('totp')) {
          totpForm.hidden = false;
          totpForm.code.focus();
        }
        if (res.methods.includes('webauthn')) {
          webauthnContainer.hidden = false;
        }
      } else {
        location.href = '/admin';
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Login fehlgeschlagen';
    }
  });

  totpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const code = totpForm.code.value.trim();
    if (!code) return;
    try {
      await window.api.loginTotp(code);
      location.href = '/admin';
    } catch (err) {
      errorEl.textContent = err.message || 'Code ungültig';
    }
  });
  
  webauthnBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    try {
      const options = await window.api.getWebauthnLoginOptions();
      const { startAuthentication } = window.SimpleWebAuthnBrowser;
      const authResp = await startAuthentication(options);
      await window.api.verifyWebauthnLogin(authResp);
      location.href = '/admin';
    } catch (err) {
      console.error(err);
      errorEl.textContent = err.message || 'YubiKey Fehler';
    }
  });
})();
