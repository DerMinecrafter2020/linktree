// =========================================================
// AES-256-GCM Verschluesselung fuer Navidrome-Passwort
// =========================================================
// Der Key liegt in NAVIDROME_ENCRYPTION_KEY (32 Byte Hex).
// Format der verschluesselten Payload:
//   iv:authTag:ciphertext  (jeweils hex-kodiert)

const crypto = require('crypto');

const KEY_HEX = process.env.NAVIDROME_ENCRYPTION_KEY;

function getKey() {
  if (!KEY_HEX || KEY_HEX.startsWith('__SET_ME')) {
    throw new Error('NAVIDROME_ENCRYPTION_KEY ist nicht konfiguriert');
  }
  const key = Buffer.from(KEY_HEX, 'hex');
  if (key.length !== 32) {
    throw new Error(`NAVIDROME_ENCRYPTION_KEY muss 32 Byte (64 Hex-Zeichen) lang sein, hat aber ${key.length} Byte`);
  }
  return key;
}

function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = getKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(String(plaintext), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decrypt(payload) {
  if (!payload) return '';
  const key = getKey();
  const parts = String(payload).split(':');
  if (parts.length !== 3) {
    throw new Error('Ungueltiges verschluesseltes Navidrome-Passwort-Format');
  }
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = {
  encrypt,
  decrypt,
};
