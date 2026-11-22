const dgram = require('node:dgram');
const net = require('node:net');
const { EmbedBuilder } = require('discord.js');
const { BRAND, COLORS, env, text } = require('./common.cjs');

const INFO_QUERY = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0')]);
function infoRequest(challenge) {
  const packet = Buffer.alloc(1200);
  INFO_QUERY.copy(packet);
  if (challenge) Buffer.from(challenge).copy(packet, INFO_QUERY.length);
  return packet;
}
function configuredMaps() {
  const raw = env('ARK_STATUS_MAPS');
  if (!raw) return [];
  return raw.split(';').map(entry => {
    const [name, host, portText, mode] = entry.split('|').map(part => part.trim());
    const port = Number(portText);
    if (!name || !/^[a-zA-Z0-9.-]{1,253}$/.test(host || '') || (!net.isIP(host) && host.split('.').some(label => !/^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)$/.test(label)))
      || !Number.isInteger(port) || port < 1 || port > 65535 || !mode) return null;
    return { name: text(name, 80), host, port, mode: text(mode, 24) };
  }).filter(Boolean).slice(0, 8);
}
function parseCString(packet, cursor) {
  const end = packet.indexOf(0, cursor);
  if (end < 0) throw Error('Respuesta A2S incompleta');
  return { value: packet.toString('utf8', cursor, end), next: end + 1 };
}
function parseInfo(packet) {
  if (packet.length < 6 || packet.readInt32LE(0) !== -1 || packet[4] !== 0x49) throw Error('Respuesta A2S no reconocida');
  let cursor = 6;
  const name = parseCString(packet, cursor); cursor = name.next;
  const map = parseCString(packet, cursor); cursor = map.next;
  const folder = parseCString(packet, cursor); cursor = folder.next;
  const game = parseCString(packet, cursor); cursor = game.next;
  if (cursor + 6 > packet.length) throw Error('Respuesta A2S incompleta');
  const appId = packet.readUInt16LE(cursor); cursor += 2;
  const players = packet[cursor++], maxPlayers = packet[cursor++];
  return { serverName: name.value, map: map.value, folder: folder.value, game: game.value, appId, players, maxPlayers };
}
function queryInfo(target, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let timer;
    let challenged = false;
    const finish = (error, value) => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    socket.once('error', error => finish(error));
    timer = setTimeout(() => finish(Error('A2S timeout')), timeoutMs);
    socket.on('message', packet => {
      if (packet.length < 5) return finish(Error('Respuesta A2S vacía'));
      if (packet.readInt32LE(0) !== -1) return finish(Error('Fragmentación A2S no soportada'));
      if (packet[4] === 0x41) {
        if (challenged || packet.length < 9) return finish(Error('Desafío A2S inválido'));
        challenged = true;
        const retry = infoRequest(packet.subarray(5, 9));
        socket.send(retry, error => { if (error) finish(error); });
        return;
      }
      try { finish(null, parseInfo(packet)); } catch (error) { finish(error); }
    });
    socket.connect(target.port, target.host, error => {
      if (error) return finish(error);
      socket.send(infoRequest(), sendError => { if (sendError) finish(sendError); });
    });
  });
}
async function collectStatus(maps) {
  const results = await Promise.all(maps.map(async target => {
    try {
      const info = await queryInfo(target);
      return { name: target.name, mode: target.mode, online: true, players: info.players, maxPlayers: info.maxPlayers, map: text(info.map, 80) };
    } catch {
      return { name: target.name, mode: target.mode, online: false, players: null, maxPlayers: null, map: '' };
    }
  }));
  return { updatedAt: new Date().toISOString(), maps: results };
}
function statusEmbed(status) {
  const online = status.maps.filter(map => map.online).length;
  const total = status.maps.length;
  const embed = new EmbedBuilder().setColor(online ? COLORS.wine : COLORS.dark).setTitle('🛰️ Estado de los servidores ARK')
    .setDescription('Estado consultado mediante Steam A2S (solo lectura). No se envían comandos de control a los servidores.')
    .addFields(...status.maps.map(map => ({
      name: text(map.name, 80),
      value: map.online
        ? `✅ En línea · **${map.players}/${map.maxPlayers}** jugadores\nMapa: ${text(map.map || 'No informado', 80)} · Modalidad: ${text(map.mode, 24)}`
        : `⚫ Sin respuesta de consulta · Modalidad: ${text(map.mode, 24)}`,
      inline: true,
    })))
    .setFooter({ text: 'MF:ark-status' })
    .setTimestamp(new Date(status.updatedAt));
  return embed;
}
module.exports = { configuredMaps, queryInfo, collectStatus, statusEmbed };
