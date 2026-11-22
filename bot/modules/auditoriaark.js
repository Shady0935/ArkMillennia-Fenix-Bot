const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder, Events, MessageFlags, PermissionsBitField, SlashCommandBuilder } = require('discord.js');
const { ROOT, BRAND, COLORS, env, channelId, getGuildChannel, mentionsNone, text } = require('../features/ark/common.cjs');

const EVENT_ID = /^[a-f0-9]{32}$/;
const MAP_CODE = /^[A-Za-z0-9_-]{1,32}$/;
const SENSITIVE = /(enablecheats|password|passwd|token|secret|authorization|webhook|discord\.com\/api\/|discordapp\.com\/api\/|scriptcommand|exec[ \t]|api[_-]?key|access[_-]?key|login[ \t]|auth[ \t])/i;
const COMMAND_ORIGINS = {
  in_game: 'Dentro del juego',
  remote_player_command: 'Comando remoto del jugador',
  panel_rcon: 'Panel / RCON; persona no identificada',
};
function validate(event, filename) {
  if (!event || Array.isArray(event) || typeof event !== 'object' || event.schema !== 1 || !EVENT_ID.test(String(event.event_id || ''))
    || filename !== event.event_id || !MAP_CODE.test(String(event.map_code || '')) || event.map_code === 'CHANGE_ME'
    || !Number.isInteger(event.utc_ms) || event.utc_ms < 1577836800000 || event.utc_ms > 4102444800000
    || typeof event.map_display !== 'string' || event.map_display.length < 1 || event.map_display.length > 96) throw Error('Evento de auditoría inválido');
  if (event.type === 'command') {
    const actor = event.actor;
    if (!actor || typeof actor !== 'object' || typeof actor.name !== 'string' || actor.name.length > 96
      || (actor.account_hash != null && !/^[0-9a-f]{64}$/.test(String(actor.account_hash)))
      || actor.admin !== true || typeof actor.identity_verified !== 'boolean'
      || !Object.hasOwn(COMMAND_ORIGINS, event.origin) || typeof event.command !== 'string' || event.command.length < 1
      || event.command.length > 4096 || event.outcome !== 'received_not_effect_verified') throw Error('Evento de comando no válido');
  } else if (event.type === 'compatibility') {
    if (!event.routes || Array.isArray(event.routes) || typeof event.routes !== 'object' || JSON.stringify(event.routes).length > 8192) throw Error('Estado de compatibilidad inválido');
  } else throw Error('Tipo de evento de auditoría no permitido');
  return event;
}
function auditEmbed(event) {
  const embed = new EmbedBuilder().setColor(COLORS.brown).setTitle('🛠️ Registro administrativo')
    .setTimestamp(new Date(event.utc_ms)).setFooter({ text: `Audit ID: ${event.event_id}` })
    .addFields({ name: '🗺️ Mapa', value: text(event.map_display, 96), inline: true });
  if (event.type === 'command') {
    const actor = event.actor;
    const source = COMMAND_ORIGINS[event.origin];
    let command = event.command;
    if (event.redacted || SENSITIVE.test(command)) command = '[Contenido sensible oculto]';
    else command = text(command, 900);
    embed.addFields(
      { name: 'Administrador', value: text(actor.name || 'Nombre no disponible', 96), inline: true },
      { name: 'Origen', value: text(source, 100), inline: true },
      { name: 'Identidad verificada', value: actor.identity_verified ? 'Sí' : 'No', inline: true },
      { name: 'Comando recibido', value: command, inline: false },
      { name: 'Resultado', value: 'Recibido; el efecto en el juego no está verificado.', inline: false },
    );
  } else {
    const entries = Object.entries(event.routes).slice(0, 12).map(([key, route]) => {
      const label = text(key, 80);
      const active = route && typeof route === 'object' && route.capturing === true;
      return `${active ? '✅' : '⛔'} ${label}: ${active ? 'captura activa' : 'sin captura'}`;
    });
    embed.setDescription(entries.join('\n').slice(0, 3500) || 'No hay rutas reportadas.');
  }
  return embed;
}
function auditDirectory() {
  const name = env('ARK_AUDIT_DIRECTORY', 'admin-audit');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw Error('Nombre de carpeta de auditoría inválido');
  return path.join(ROOT, 'data', 'ark', name);
}
function privateChannel(channel, context) {
  if (!channel?.guild || channel.guild.id !== context.guildId || !channel.isTextBased?.()) return false;
  const everyone = channel.guild.roles.everyone;
  if (channel.permissionsFor(everyone)?.has(PermissionsBitField.Flags.ViewChannel)) return false;
  return context.adminRoleIds.some(roleId => {
    const role = channel.guild.roles.cache.get(roleId);
    return role && channel.permissionsFor(role)?.has(PermissionsBitField.Flags.ViewChannel);
  });
}
async function findDelivery(channel, client, eventId) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const footer = `Audit ID: ${eventId}`;
  return messages?.find(message => message.author.id === client.user.id && message.embeds.some(embed => embed.footer?.text === footer)) || null;
}
module.exports = {
  version: '1.0.0',
  commands: [{
    data: new SlashCommandBuilder().setName('auditoriaark').setDescription('Muestra el estado de entrega de la auditoría ARK').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    execute: async (interaction, context) => {
      const service = context.services.get('ark:audit');
      const status = await service?.status();
      return interaction.reply({ content: status?.enabled
        ? `Auditoría activa · ${status.pending} eventos pendientes de entregar.`
        : 'Auditoría ARK desactivada o sin un canal privado válido.',
      flags: MessageFlags.Ephemeral, allowedMentions: mentionsNone() });
    },
  }],
  async setup(context) {
    const enabled = env('ARK_ADMIN_AUDIT_ENABLED', 'false').toLowerCase() === 'true';
    let channel = null;
    let safe = false;
    let warnedPrivate = false;
    const refreshChannel = async () => {
      channel = await getGuildChannel(context.client, context.guildId, channelId('ARK_ADMIN_AUDIT_CHANNEL_ID'));
      safe = !!channel && privateChannel(channel, context);
      if (enabled && channel && !safe && !warnedPrivate) {
        context.log('Auditoría pausada: el canal debe ocultarse de @everyone y permitir acceso a un rol admin configurado.');
        warnedPrivate = true;
      }
      if (safe) warnedPrivate = false;
    };
    const status = async () => {
      const entries = await context.storage.entries();
      return { enabled: enabled && safe, pending: entries.filter(([key, value]) => key.startsWith('event:') && value?.state === 'pending').length };
    };
    const service = { status };
    context.provide('ark:audit', service);
    let ticking = false;
    const tick = async () => {
      if (!enabled || ticking) return;
      ticking = true;
      try {
        if (!channel || !safe) await refreshChannel();
        if (!safe) return;
        const directory = auditDirectory();
        if (!fs.existsSync(directory)) return;
        const names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name)).sort().slice(0, 1000);
        for (const name of names) {
          const id = name.slice(0, 32);
          const key = `event:${id}`;
          const previous = await context.storage.get(key, null);
          if (previous?.state === 'sent' || previous?.state === 'uncertain') continue;
          let event;
          try {
            const filename = path.join(directory, name);
            const stat = fs.lstatSync(filename);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue;
            event = validate(JSON.parse(fs.readFileSync(filename, 'utf8')), id);
          } catch { continue; }
          const existing = await findDelivery(channel, context.client, id);
          if (existing) {
            await context.storage.set(key, { state: 'sent', messageId: existing.id, deliveredAt: Date.now() });
            continue;
          }
          if (previous?.state === 'sending') {
            await context.storage.set(key, { state: 'uncertain', reason: 'No se encontró el mensaje en el historial consultado; no se repetirá automáticamente.' });
            continue;
          }
          await context.storage.set(key, { state: 'sending', startedAt: Date.now() });
          try {
            const message = await channel.send({ embeds: [auditEmbed(event)], allowedMentions: mentionsNone() });
            await context.storage.set(key, { state: 'sent', messageId: message.id, deliveredAt: Date.now() });
          } catch (error) {
            await context.storage.set(key, { state: 'uncertain', reason: String(error?.code || error?.name || 'send error') });
            context.log(`Resultado de entrega incierto para el evento ${id}; no se reintentará para evitar duplicados.`);
            break;
          }
        }
      } finally { ticking = false; }
    };
    context.on(Events.ClientReady, () => refreshChannel().then(tick));
    context.every(5000, () => tick());
    context.onClose(() => { channel = null; safe = false; });
  },
};
