// =========================================================
// OpenWeb — Alert-Benachrichtigungen für kritische Ereignisse
// =========================================================

const db = require('./db');
const { encrypt, decrypt, isEncrypted } = require('./crypto');

async function loadSettings() {
  const { rows } = await db.query('SELECT * FROM alert_settings WHERE id = 1 LIMIT 1');
  const settings = rows[0] || null;
  if (!settings?.smtp_password || isEncrypted(settings.smtp_password)) return settings;

  // Aeltere Installationen koennen noch SMTP-Passwoerter im Klartext enthalten.
  // Beim ersten Laden in ein authentifiziertes Chiffrat migrieren.
  const legacyPassword = settings.smtp_password;
  const encryptedPassword = encrypt(legacyPassword);
  const result = await db.query(
    'UPDATE alert_settings SET smtp_password = $1 WHERE id = 1 AND smtp_password = $2 RETURNING smtp_password',
    [encryptedPassword, legacyPassword]
  );
  if (result.rows[0]) {
    settings.smtp_password = result.rows[0].smtp_password;
  } else {
    const { rows: latest } = await db.query('SELECT smtp_password FROM alert_settings WHERE id = 1 LIMIT 1');
    settings.smtp_password = latest[0]?.smtp_password || null;
  }
  return settings;
}

async function sendWebhook(url, text) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    console.warn('[alert] webhook failed:', err.message);
    return false;
  }
}

async function sendEmail(to, subject, body, settings) {
  try {
    const nodemailer = require('nodemailer');
    const smtpPassword = settings.smtp_password ? decrypt(settings.smtp_password) : '';
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host,
      port: settings.smtp_port || 587,
      secure: settings.smtp_secure,
      auth: settings.smtp_user ? { user: settings.smtp_user, pass: smtpPassword } : undefined,
    });
    await transporter.sendMail({
      from: settings.smtp_user || 'openweb@localhost',
      to,
      subject,
      text: body,
    });
    return true;
  } catch (err) {
    console.warn('[alert] email failed:', err.message);
    return false;
  }
}

async function notify(type, message, details = {}) {
  const settings = await loadSettings();
  if (!settings) return { sent: false };

  const flagMap = {
    login: 'notify_login',
    backup_fail: 'notify_backup_fail',
    password: 'notify_password',
  };
  const flag = flagMap[type];
  if (flag && !settings[flag]) return { sent: false };

  const fullText = `[OpenWeb ${type}] ${message}\n${Object.entries(details).map(([k, v]) => `${k}: ${v}`).join('\n')}`.trim();
  const results = {};

  if (settings.webhook_url) {
    results.webhook = await sendWebhook(settings.webhook_url, fullText);
  }
  if (settings.email_enabled && settings.email_to && settings.smtp_host) {
    results.email = await sendEmail(settings.email_to, `OpenWeb Alert: ${type}`, fullText, settings);
  }

  return { sent: Object.values(results).some(Boolean), results };
}

module.exports = { notify, loadSettings };
