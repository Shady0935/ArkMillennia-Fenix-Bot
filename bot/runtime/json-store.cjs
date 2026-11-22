const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class JsonStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  file(name) {
    if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) throw Error('Nombre de datos inválido');
    return path.join(this.directory, name);
  }
  read(name, fallback) {
    const file = this.file(name);
    if (!fs.existsSync(file)) { this.write(name, fallback); return structuredClone(fallback); }
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8 * 1024 * 1024) throw Error(`Archivo de datos no permitido: ${name}`);
    // Corruption must reject the module; it must never silently reset a consent list.
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  write(name, value) {
    const file = this.file(name), temporary = file + '.' + crypto.randomUUID() + '.tmp';
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
module.exports = { JsonStore };
