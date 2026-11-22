const { EmbedBuilder, Events, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { BRAND, COLORS, env, channelId, dataFile, readJson, getGuildChannel, mentionsNone, updatePanel, text } = require('../features/ark/common.cjs');

function loadSchedule() {
  const filename = dataFile('ARK_MODE_SCHEDULE_FILE', 'mode-schedule.json');
  try { return readJson(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function validNext(item) {
  return item && ['pvp', 'pve'].includes(String(item.mode).toLowerCase()) && Number.isFinite(Number(item.epoch));
}
function calendarEmbed(data) {
  const lines = [
    '**Horario de Chile continental**',
    '⚔️ PvP: sábado 00:00 · farmeo/tameo x10',
    '🌿 PvE: lunes 00:00 · farmeo x8 / tameo x6',
  ];
  for (const item of (Array.isArray(data?.next) ? data.next.filter(validNext).slice(0, 2) : [])) {
    const mode = String(item.mode).toUpperCase();
    const cdmx = text(item.cdmx || 'Hora pendiente', 40);
    const chile = text(item.chile || 'Hora pendiente', 40);
    lines.push(`**${mode}** · ${cdmx} CDMX / ${chile} Chile · <t:${Math.floor(Number(item.epoch))}:R>`);
  }
  lines.push('Genesis y Ragnarok · El rotativo conserva PvP permanente.');
  return new EmbedBuilder().setColor(COLORS.brown).setTitle('🗓️ Calendario de modalidades')
    .setDescription(lines.join('\n')).setFooter({ text: 'MF:mode-calendar' });
}
function operationEmbed(operation) {
  const mode = String(operation.mode).toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(String(operation.id || '')) || !['pvp', 'pve'].includes(mode)
    || !Number.isFinite(Number(operation.epoch))) throw Error('Operación de modalidad inválida');
  const phase = String(operation.phase || 'waiting');
  const complete = phase === 'complete' || phase === 'already_applied';
  const failed = phase === 'failed';
  const when = Math.floor(Number(operation.epoch));
  const modeName = mode === 'pvp' ? 'PvP' : 'PvE';
  const lines = [
    '**Genesis y Ragnarok**',
    '',
    `📅 ${text(operation.cdmx || 'Hora pendiente', 40)} CDMX / ${text(operation.chile || 'Hora pendiente', 40)} Chile`,
    `🕰️ Tu hora: <t:${when}:F>`,
    '',
    mode === 'pvp' ? '🌾 Farmeo **x10** · 🦖 Tameo **x10**' : '🌾 Farmeo **x8** · 🦖 Tameo **x6**',
    '',
    failed ? '⚠️ **El mantenimiento requiere revisión.**' : complete ? '✅ **Modalidad aplicada y disponibilidad comprobada.**' : '🔔 Reinicio programado. Protejan a sus personajes y criaturas.',
  ];
  const embed = new EmbedBuilder().setColor(failed ? 0xb33a3a : complete ? 0x517a4d : COLORS.gold)
    .setTitle(`Cambio de modalidad · ${modeName}`).setDescription(lines.join('\n'))
    .setFooter({ text: `MF:mode:${operation.id}` }).setTimestamp(new Date());
  const phaseNames = { preparing: 'Preparando', waiting: 'Programado', warnings: 'Cuenta atrás', saving: 'Guardando mundo', stopping: 'Deteniendo', applying: 'Aplicando modalidad', starting: 'Iniciando y comprobando', complete: 'Disponible y verificado', already_applied: 'Modalidad ya verificada', failed: 'Requiere revisión' };
  for (const [name, row] of Object.entries(operation.maps || {}).slice(0, 10)) {
    const status = phaseNames[row?.phase] || 'Pendiente';
    const due = Number.isFinite(Number(row?.due_epoch)) ? ` · <t:${Math.floor(Number(row.due_epoch))}:R>` : '';
    embed.addFields({ name: text(name, 100), value: `${status}${due}`, inline: true });
  }
  embed.addFields({ name: '🗺️ Mapa rotativo', value: 'Conserva su modalidad PvP permanente.', inline: false });
  return embed;
}
async function sendOperation(context, channel, operation) {
  const marker = `MF:mode:${operation.id}`;
  const key = `operation:${operation.id}`;
  const record = await context.storage.get(key, null);
  let message = typeof record === 'string' ? await channel.messages.fetch(record).catch(() => null) : null;
  if (!message) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    message = messages?.find(item => item.author.id === context.client.user.id && item.embeds.some(embed => embed.footer?.text === marker)) || null;
  }
  if (!message) {
    if (record?.pending) throw Error('No se pudo reconciliar el anuncio anterior; no se duplicará');
    await context.storage.set(key, { pending: true, marker });
    message = await channel.send({ embeds: [operationEmbed(operation)], allowedMentions: mentionsNone() });
  }
  if (message.author.id !== context.client.user.id) throw Error('El anuncio guardado no pertenece al bot');
  await message.edit({ embeds: [operationEmbed(operation)], allowedMentions: mentionsNone() });
  await context.storage.set(key, message.id);
}
module.exports = {
  version: '1.0.0',
  commands: [{
    data: new SlashCommandBuilder().setName('horariomodos').setDescription('Consulta el horario de PvP y PvE de ARK'),
    execute: async interaction => {
      const data = loadSchedule();
      if (!data) return interaction.reply({ content: 'El calendario aún no está configurado.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [calendarEmbed(data)], flags: MessageFlags.Ephemeral, allowedMentions: mentionsNone() });
    },
  }],
  async setup(context) {
    let ticking = false;
    const tick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        const data = loadSchedule();
        if (!data) return;
        const channel = await getGuildChannel(context.client, context.guildId, channelId('ARK_MODE_ANNOUNCEMENTS_CHANNEL_ID'));
        if (!channel) return;
        await updatePanel(context, { channel, key: 'mode-calendar-message', marker: 'MF:mode-calendar', payload: { embeds: [calendarEmbed(data)] } });
        const operation = data.operation;
        if (!operation || !Number.isFinite(Number(operation.epoch))
          || (Date.now() / 1000 < Number(operation.epoch) - 610 && !['complete', 'failed', 'already_applied'].includes(operation.phase))) return;
        await sendOperation(context, channel, operation);
      } finally { ticking = false; }
    };
    context.on(Events.ClientReady, () => tick());
    context.every(Math.min(300, Math.max(15, Number(env('ARK_MODE_SCHEDULE_POLL_SECONDS', '30')) || 30)) * 1000, () => tick());
  },
};
