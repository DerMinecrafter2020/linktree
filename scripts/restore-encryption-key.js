#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { restoreBackup, writeKeyToEnvFile } = require('../lib/encryption-key-backup');

function readHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('Bitte das Skript in einem interaktiven Terminal ausfuehren.'));
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    const finish = (error) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') return finish(new Error('Abgebrochen.'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') {
          if (value.length) {
            value = Array.from(value).slice(0, -1).join('');
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          value += char;
          process.stdout.write('*');
        }
      }
    };

    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function main() {
  const backupPath = process.argv[2];
  if (!backupPath) {
    throw new Error('Aufruf: node scripts/restore-encryption-key.js <Schluessel-Backup.json>');
  }

  const resolvedBackupPath = path.resolve(backupPath);
  const stat = fs.statSync(resolvedBackupPath);
  if (!stat.isFile() || stat.size > 64 * 1024) {
    throw new Error('Die Backup-Datei fehlt oder ist zu gross.');
  }

  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(resolvedBackupPath, 'utf8'));
  } catch {
    throw new Error('Die Backup-Datei enthaelt kein gueltiges JSON.');
  }

  const passphrase = await readHidden('Wiederherstellungspasswort: ');
  const keyHex = await restoreBackup(backup, passphrase);
  writeKeyToEnvFile(keyHex);
  console.log('Verschluesselungsschluessel wiederhergestellt und .env mit Dateirechten 600 gesichert.');
  console.log('Starte OpenWeb anschliessend neu, z. B. mit: sudo systemctl restart openweb');
}

main().catch((err) => {
  console.error(`[Schluessel-Wiederherstellung] ${err.message}`);
  process.exitCode = 1;
});
