const { EmbedBuilder } = require('discord.js');

const AUTHOR = Object.freeze({
  name: 'Millennia Fenix Bot',
});

function normalizeEmbedData(embed, { timestamp = true } = {}) {
  const source = typeof embed?.toJSON === 'function' ? embed.toJSON() : embed;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('El embed debe ser un objeto válido');
  const data = structuredClone(source);
  data.author = { ...AUTHOR };
  delete data.footer;
  if (timestamp === false) delete data.timestamp;
  else if (!data.timestamp) data.timestamp = new Date().toISOString();
  return data;
}

function createEmbed(options = {}) {
  const { timestamp = true, ...data } = options;
  return new EmbedBuilder(normalizeEmbedData(data, { timestamp }));
}

module.exports = { AUTHOR, createEmbed, normalizeEmbedData };
