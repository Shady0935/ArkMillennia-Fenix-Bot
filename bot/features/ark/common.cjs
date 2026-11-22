const fs = require('node:fs');
const path = require('node:path');
const { readEnvironment } = require('../../runtime/environment.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const ENV = readEnvironment(ROOT);
const BRAND = 'ArkMillennia Fenix';
const COLORS = { dark: 0x171313, wine: 0x741d31, brown: 0x6a4332, ember: 0xc45b43, gold: 0xc58a45 };

function env(name, fallback = '') { return String(ENV[name] ?? fallback).trim(); }
function channelId(name) { const value = env(name); return /^[0-9]{17,20}$/.test(value) ? value : ''; }
function readJson(filename, maxBytes = 1024 * 1024) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw Error('El archivo de datos no es válido');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function dataFile(envName, defaultName) {
  const name = env(envName, defaultName);
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw Error('Nombre de archivo de datos inválido');
  return path.join(ROOT, 'data', 'ark', name);
}
function text(value, maximum = 1000) {
  return String(value ?? '').replace(/@/g, '@\u200b').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maximum);
}
async function getGuildChannel(client, guildId, id) {
  if (!id) return null;
  const channel = client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
  return channel && channel.guildId === guildId && channel.isTextBased?.() ? channel : null;
}
function mentionsNone() { return { parse: [], users: [], roles: [], repliedUser: false }; }
async function findOwnedPanel(channel, client, marker) {
  if (!channel?.messages?.fetch || !client.user) return null;
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  return messages?.find(message => message.author.id === client.user.id
    && message.embeds?.some(embed => embed.footer?.text === marker)) || null;
}
async function updatePanel(context, { channel, key, marker, payload }) {
  if (!channel) return null;
  const record = await context.storage.get(key, null);
  let message = null;
  if (typeof record === 'string' && record) message = await channel.messages.fetch(record).catch(() => null);
  if (!message) message = await findOwnedPanel(channel, context.client, marker);
  if (!message) {
    if (record && typeof record === 'object' && record.pending) throw Error('No se pudo reconciliar el envío anterior del panel; no se enviará otro para evitar duplicados');
    await context.storage.set(key, { pending: true, marker });
    message = await channel.send({ ...payload, allowedMentions: mentionsNone() });
  }
  if (message.author.id !== context.client.user.id) throw Error('El panel guardado no pertenece al bot');
  await message.edit({ ...payload, allowedMentions: mentionsNone() });
  await context.storage.set(key, message.id);
  return message;
}

module.exports = { ROOT, ENV, BRAND, COLORS, env, channelId, readJson, dataFile, text, getGuildChannel, mentionsNone, findOwnedPanel, updatePanel };
