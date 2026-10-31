// =========================================================
// OpenWeb — E-Mail-Versand ueber die SMTP-Einstellungen
// ---------------------------------------------------------
// Gemeinsam genutzt von Alerts (lib/alert.js) und Kontaktformular (lib/contact.js).
// SMTP-Daten stehen in alert_settings (Admin > Einstellungen > Benachrichtigungen),
// das Passwort nur verschluesselt (lib/crypto). Nie Passwort oder Inhalte loggen.
// =========================================================

const { decrypt } = require('./crypto');

// Absender: der SMTP-Benutzer, wenn er eine E-Mail-Adresse ist (die meisten Anbieter
// akzeptieren nur diese als Absender), sonst die Ersatzadresse.
function senderAddress(settings, fallback) {
  const user = String(settings?.smtp_user || '').trim();
  if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user)) return user;
  return fallback || 'openweb@localhost';
}

function isConfigured(settings) {
  return Boolean(settings?.smtp_host);
}

function createTransport(settings) {
  const nodemailer = require('nodemailer');
  const smtpPassword = settings.smtp_password ? decrypt(settings.smtp_password) : '';
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port || 587,
    secure: settings.smtp_secure,
    auth: settings.smtp_user ? { user: settings.smtp_user, pass: smtpPassword } : undefined,
    // Ein haengender SMTP-Server darf Anfragen nicht ewig offen halten
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

/**
 * Sendet eine reine Text-Mail. Wirft bei Fehlern (Aufrufer entscheidet ueber die Meldung).
 * @param {object} settings  Zeile aus alert_settings
 * @param {{to: string, subject: string, text: string, replyTo?: object|string, from?: string}} mail
 */
async function sendMail(settings, mail) {
  if (!isConfigured(settings)) throw new Error('SMTP ist nicht eingerichtet');
  const transporter = createTransport(settings);
  // Betreff ohne Zeilenumbrueche (Header-Injection); Adressen/Namen kodiert nodemailer selbst
  const subject = String(mail.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
  return transporter.sendMail({
    from: mail.from || senderAddress(settings, mail.to),
    to: mail.to,
    replyTo: mail.replyTo,
    subject,
    text: mail.text,
  });
}

module.exports = { sendMail, senderAddress, isConfigured };
