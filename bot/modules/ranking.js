const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, MessageFlags, SlashCommandBuilder, StringSelectMenuBuilder } = require('discord.js');
const { BRAND, COLORS, env, channelId, dataFile, readJson, getGuildChannel, mentionsNone, updatePanel, text } = require('../features/ark/common.cjs');

const CATEGORIES = [
  ['Tribus y puntos', '🏆'], ['Bajas de jugadores', '⚔️'], ['Dinos enemigos', '🦖'], ['Eficiencia PvP', '🎯'],
  ['Caza de salvajes', '🏹'], ['Domesticaciones', '🤝'], ['Tiempo jugado', '⏱️'], ['Muertes registradas', '💀'],
];
function loadRanking() {
  const payload = readJson(dataFile('ARK_RANKING_DATA_FILE', 'ranking.json'));
  if (!Array.isArray(payload.categories) || payload.categories.length !== 8
    || payload.categories.some(category => !category || typeof category.name !== 'string' || typeof category.value !== 'string')
    || typeof payload.updatedAt !== 'string' || !Number.isFinite(Date.parse(payload.updatedAt))) throw Error('El ranking aún no tiene un archivo de datos válido');
  return payload;
}
function rankedLines(payload, index) {
  const lines = payload.categories[index].value.split(/\r?\n/);
  const rows = lines.filter(line => /^(?:[🥇🥈🥉]|\*\*\d+\.\*\*) /.test(line));
  const prefix = lines.filter(line => line && !rows.includes(line));
  return { rows, prefix };
}
function rankingEmbed(payload, index, page = 0, panel = false) {
  if (!Number.isInteger(index) || index < 0 || index >= 8) throw Error('Categoría de ranking inválida');
  const category = payload.categories[index];
  const { rows, prefix } = rankedLines(payload, index);
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.max(0, Math.min(page, pages - 1));
  const visible = rows.slice(current * pageSize, (current + 1) * pageSize).map(row => text(row, 180));
  const blocks = [];
  for (let i = 0; i < visible.length; i += 5) blocks.push(visible.slice(i, i + 5).join('\n'));
  let description = [...prefix.map(line => text(line, 500)), ...blocks].filter(Boolean).join('\n\n') || 'Aún no hay registros elegibles.';
  const updated = new Date(payload.updatedAt);
  const stale = Date.now() - updated.getTime() > 1800000 ? ' · datos pendientes de actualizar' : '';
  if (panel) description = `**🏅 Las hazañas de la season**\n\n${description}\n\n**Explora las 8 categorías en el selector.**\nHasta 50 puestos · 20 por página · consulta privada.${stale ? '\n\n⚠️ Datos pendientes de actualizar.' : ''}`;
  return new EmbedBuilder().setColor(COLORS.ember).setTitle(text(category.name, 256))
    .setAuthor({ name: `${BRAND} · Ranking de la season` })
    .setDescription(description.slice(0, 4000))
    .setFooter({ text: panel ? 'MF:ranking-panel' : `Genesis + Ragnarok · Top ${Number(payload.rankingLimit) || 50} · Página ${current + 1}/${pages} · CDMX${stale}` })
    .setTimestamp(updated);
}
function categorySelect(customId, selected) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(customId)
    .setPlaceholder('Elige qué ranking quieres consultar…')
    .addOptions(CATEGORIES.map(([label, emoji], index) => ({ label, value: String(index), emoji, default: selected === index }))));
}
function privatePayload(payload, index, page, owner) {
  const { rows } = rankedLines(payload, index);
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const current = Math.max(0, Math.min(page, pages - 1));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ranking:page:${owner}:${index}:${current - 1}`).setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(current <= 0),
    new ButtonBuilder().setCustomId(`ranking:page:${owner}:${index}:${current + 1}`).setLabel('Siguiente').setStyle(ButtonStyle.Secondary).setDisabled(current >= pages - 1),
  );
  return { embeds: [rankingEmbed(payload, index, current)], components: [categorySelect(`ranking:select:${owner}`, index), buttons], allowedMentions: mentionsNone() };
}
function initialPayload(owner) {
  const embed = new EmbedBuilder().setColor(COLORS.dark).setTitle('🏆 Ranking de la season')
    .setDescription('Selecciona una categoría para ver la clasificación. La consulta se abrirá solo para ti.')
    .setFooter({ text: BRAND });
  return { embeds: [embed], components: [categorySelect(`ranking:select:${owner}`)], flags: MessageFlags.Ephemeral, allowedMentions: mentionsNone() };
}
async function showPrivate(interaction, index, page = 0, update = false) {
  try {
    const payload = loadRanking();
    const view = privatePayload(payload, index, page, interaction.user.id);
    return update ? interaction.update(view) : interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
  } catch {
    const reply = { content: 'El ranking está actualizándose. Inténtalo de nuevo en un momento.', embeds: [], components: [], allowedMentions: mentionsNone() };
    return update ? interaction.update(reply) : interaction.reply({ ...reply, flags: MessageFlags.Ephemeral });
  }
}
function panelPayload(context) {
  let payload;
  try { payload = loadRanking(); } catch {
    return {
      embeds: [new EmbedBuilder().setColor(COLORS.dark).setTitle('🏆 Ranking de la season')
        .setDescription('El ranking todavía no está disponible. El panel se actualizará cuando llegue el próximo archivo de datos.')
        .setFooter({ text: 'MF:ranking-panel' })],
      components: [categorySelect('ranking:panel')],
    };
  }
  const modeIndex = payload.mode === 'PvE' ? 4 : 0;
  return { embeds: [rankingEmbed(payload, modeIndex, 0, true)], components: [categorySelect('ranking:panel')] };
}
module.exports = {
  version: '1.0.0',
  commands: [{
    data: new SlashCommandBuilder().setName('ranking').setDescription('Consulta las clasificaciones de ARK')
      .addStringOption(option => option.setName('categoria').setDescription('Clasificación para abrir directamente').setRequired(false)
        .addChoices(...CATEGORIES.map(([name], index) => ({ name, value: String(index) })))),
    execute: async interaction => {
      const selected = interaction.options.getString('categoria');
      if (selected === null) return interaction.reply(initialPayload(interaction.user.id));
      return showPrivate(interaction, Number(selected));
    },
  }],
  async setup(context) {
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const channel = await getGuildChannel(context.client, context.guildId, channelId('ARK_RANKING_CHANNEL_ID'));
        if (!channel) return;
        await updatePanel(context, { channel, key: 'ranking-panel-message', marker: 'MF:ranking-panel', payload: panelPayload(context) });
      } finally { refreshing = false; }
    };
    context.on(Events.ClientReady, () => refresh());
    context.every(60000, () => refresh());
    context.on(Events.InteractionCreate, async interaction => {
      if (interaction.isStringSelectMenu?.() && interaction.customId === 'ranking:panel') {
        const index = Number(interaction.values[0]);
        return showPrivate(interaction, index);
      }
      if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('ranking:select:')) {
        const owner = interaction.customId.split(':')[2];
        if (owner !== interaction.user.id) return interaction.reply({ content: 'Este menú pertenece a otra persona.', flags: MessageFlags.Ephemeral });
        return showPrivate(interaction, Number(interaction.values[0]), 0, true);
      }
      if (interaction.isButton?.() && interaction.customId.startsWith('ranking:page:')) {
        const [, , owner, category, page] = interaction.customId.split(':');
        if (owner !== interaction.user.id) return interaction.reply({ content: 'Este menú pertenece a otra persona.', flags: MessageFlags.Ephemeral });
        return showPrivate(interaction, Number(category), Number(page), true);
      }
    });
  },
};
