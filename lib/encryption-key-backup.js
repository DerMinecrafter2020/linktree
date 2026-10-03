// =========================================================
// Verschluesseltes Backup und Wiederherstellung des App-Schluessels
// =========================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const FORMAT = 'openweb-encryption-key-backup';
const VERSION = 1;
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const PASSPHRASE_MIN_LENGTH = 16;
const PASSPHRASE_MAX_BYTES = 1024;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`, 'utf8');
let derivationInProgress = false;

function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string' ||
      passphrase.length < PASSPHRASE_MIN_LENGTH ||
      Buffer.byteLength(passphrase, 'utf8') > PASSPHRASE_MAX_BYTES) {
    throw new Error(`Das Wiederherstellungspasswort muss mindestens ${PASSPHRASE_MIN_LENGTH} Zeichen lang sein.`);
  }
}

async function deriveKey(passphrase, salt) {
  if (derivationInProgress) throw new Error('Ein Schluessel-Backup-Vorgang laeuft bereits.');
  derivationInProgress = true;
  try {
    return await scrypt(passphrase, salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  } finally {
    derivationInProgress = false;
  }
}

async function createBackup(encryptionKey, passphrase) {
  validatePassphrase(passphrase);
  if (typeof encryptionKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
    throw new Error('Der Anwendungsschluessel ist ungueltig.');
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const derivedKey = await deriveKey(passphrase, salt);
  const rawEncryptionKey = Buffer.from(encryptionKey, 'hex');
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
      cipher.update(rawEncryptionKey),
      cipher.final(),
    ]);

    return {
      format: FORMAT,
      version: VERSION,
      kdf: {
        name: 'scrypt',
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        salt: salt.toString('hex'),
      },
      cipher: {
        name: 'aes-256-gcm',
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        ciphertext: ciphertext.toString('hex'),
      },
    };
  } finally {
    derivedKey.fill(0);
    rawEncryptionKey.fill(0);
  }
}

async function restoreBackup(backup, passphrase) {
  validatePassphrase(passphrase);
  if (!backup || typeof backup !== 'object' || Array.isArray(backup) ||
      backup.format !== FORMAT || backup.version !== VERSION ||
      backup.kdf?.name !== 'scrypt' || backup.kdf.N !== SCRYPT_N ||
      backup.kdf.r !== SCRYPT_R || backup.kdf.p !== SCRYPT_P ||
      !/^[0-9a-f]{32}$/i.test(backup.kdf.salt || '') ||
      backup.cipher?.name !== 'aes-256-gcm' ||
      !/^[0-9a-f]{24}$/i.test(backup.cipher.iv || '') ||
      !/^[0-9a-f]{32}$/i.test(backup.cipher.tag || '') ||
      !/^[0-9a-f]{64}$/i.test(backup.cipher.ciphertext || '')) {
    throw new Error('Die Schluessel-Backup-Datei ist ungueltig oder wird nicht unterstuetzt.');
  }

  const salt = Buffer.from(backup.kdf.salt, 'hex');
  const iv = Buffer.from(backup.cipher.iv, 'hex');
  const tag = Buffer.from(backup.cipher.tag, 'hex');
  const ciphertext = Buffer.from(backup.cipher.ciphertext, 'hex');
  const derivedKey = await deriveKey(passphrase, salt);
  let plaintextKey;

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintextKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintextKey.length !== 32) throw new Error('Ungueltige Schluessellaenge');
    return plaintextKey.toString('hex');
  } catch {
    throw new Error('Backup konnte nicht entschluesselt werden. Wiederherstellungspasswort pruefen.');
  } finally {
    derivedKey.fill(0);
    plaintextKey?.fill(0);
  }
}

function writeKeyToEnvFile(keyHex, envFile = path.join(process.cwd(), '.env')) {
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('Der wiederhergestellte Anwendungsschluessel ist ungueltig.');
  }

  let contents = '';
  if (fs.existsSync(envFile)) {
    fs.chmodSync(envFile, 0o600);
    contents = fs.readFileSync(envFile, 'utf8');
  }

  const lines = contents ? contents.split(/\r?\n/) : [];
  const keyLinePattern = /^\s*(?:export\s+)?NAVIDROME_ENCRYPTION_KEY\s*=/;
  let found = false;
  const updatedLines = lines.map((line) => {
    if (!keyLinePattern.test(line)) return line;
    found = true;
    return `NAVIDROME_ENCRYPTION_KEY=${keyHex}`;
  });
  if (!found) updatedLines.push(`NAVIDROME_ENCRYPTION_KEY=${keyHex}`);

  const tempFile = path.join(
    path.dirname(envFile),
    `.${path.basename(envFile)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tempFile, `${updatedLines.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, envFile);
    fs.chmodSync(envFile, 0o600);
  } finally {
    try { fs.unlinkSync(tempFile); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = {
  createBackup,
  restoreBackup,
  writeKeyToEnvFile,
  PASSPHRASE_MIN_LENGTH,
};
