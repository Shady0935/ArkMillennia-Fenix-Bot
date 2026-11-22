const fs = require('node:fs');
const path = require('node:path');

const JSON_IMPORTS = [
  ['anuncios', 'config', 'data/js/anuncios/config.json'],
  ['anuncios', 'consents', 'data/js/anuncios/consentidos.json'],
  ['anuncios', 'failures', 'data/js/anuncios/failed-users.json'],
  ['anuncios', 'jobs', 'data/js/anuncios/jobs.json'],
  ['launcher', 'sessions', 'data/js/launcher/sessions.json'],
  ['runtime', 'slash-owned', 'data/bot/slash-owned.json'],
];
const BLOB_DIRECTORY = 'data/js/anuncios/uploads';
const SAFE_UPLOAD = /^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/;
const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

async function migrateLegacy(root, database, log = () => {}) {
  const imported = { records: 0, files: 0, bytes: 0 };
  const removeAfterCommit = [];

  for (const [namespace, key, relative] of JSON_IMPORTS) {
    const filename = path.join(root, relative);
    if (!fs.existsSync(filename)) continue;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error(`Archivo anterior no permitido: ${relative}`);
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    await database.setIfAbsent(namespace, key, value);
    removeAfterCommit.push(filename);
    imported.records++;
  }

  const secretFile = path.join(root, 'data/dashboard/session-secret');
  if (fs.existsSync(secretFile)) {
    const stat = fs.lstatSync(secretFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw Error('Secreto de sesión anterior no permitido');
    const value = fs.readFileSync(secretFile, 'utf8').trim();
    if (value && value.length >= 48) {
      await database.setIfAbsent('dashboard', 'session-secret', value);
      removeAfterCommit.push(secretFile);
      imported.records++;
    }
  }

  const uploadDirectory = path.join(root, BLOB_DIRECTORY);
  if (fs.existsSync(uploadDirectory)) {
    const directory = fs.lstatSync(uploadDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('La carpeta de archivos anteriores no está permitida');
    for (const name of fs.readdirSync(uploadDirectory)) {
      if (!SAFE_UPLOAD.test(name)) continue;
      const filename = path.join(uploadDirectory, name), stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1048576) throw Error(`Imagen anterior no permitida: ${name}`);
      const extension = name.slice(name.lastIndexOf('.') + 1);
      const buffer = fs.readFileSync(filename);
      await database.setBlobIfAbsent('anuncios', name, buffer, CONTENT_TYPES[extension]);
      removeAfterCommit.push(filename);
      imported.files++; imported.bytes += buffer.length;
    }
  }

  // Remove only the exact legacy persistence files after every database write
  // has completed. On a database failure the originals remain available.
  for (const filename of removeAfterCommit) fs.rmSync(filename, { force: true });
  for (const relative of ['data/js/anuncios/uploads', 'data/js/anuncios', 'data/js/launcher', 'data/js', 'data/bot', 'data/dashboard']) {
    const directory = path.join(root, relative);
    try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
  if (imported.records || imported.files) log(`Migración de datos locales a MySQL completada · ${imported.records} registros · ${imported.files} archivos`);
  return imported;
}

module.exports = { migrateLegacy, JSON_IMPORTS, BLOB_DIRECTORY };
