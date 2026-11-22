const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

function readEnvironment(root = process.env.MILLENNIAFENIXBOT_CONFIG_ROOT || path.resolve(__dirname, '..')) {
  const filename = path.join(root, '.env');
  if (!fs.existsSync(filename) && fs.existsSync(path.join(root, '.env.example'))) {
    try { fs.copyFileSync(path.join(root, '.env.example'), filename, fs.constants.COPYFILE_EXCL); fs.chmodSync(filename, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!fs.existsSync(filename)) return { ...process.env };
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('Archivo .env inválido');
  return { ...process.env, ...parseEnv(fs.readFileSync(filename, 'utf8')) };
}
module.exports = { readEnvironment };
