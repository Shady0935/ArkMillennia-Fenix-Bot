const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, MessageFlags,
  ModalBuilder, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const crypto = require('node:crypto');
const { BRAND, COLORS, env, channelId, getGuildChannel, mentionsNone, updatePanel, text } = require('../features/ark/common.cjs');

const CATALOGUE = require('../features/ark/data/catalogue.json');
const OFFERS = require('../features/ark/data/premium.json');
const SECTIONS = [
  ['dinos', 'Dinosaurios', '🦖'], ['buy', 'Comprar', '🛒'], ['sell', 'Vender', '💰'],
  ['boxes', 'Cajas y kits', '📦'], ['buffs', 'Mejoras', '✨'], ['premium', 'Kits y puntos · USD', '💎'],
];
const searchTokens = new Map();

function sectionLabel(section) { return SECTIONS.find(row => row[0] === section)?.[1] || 'Catálogo'; }
function readCatalogue() {
  if (!CATALOGUE || !Array.isArray(CATALOGUE.dinos)) throw Error('Catálogo no disponible');
  return CATALOGUE;
}
function number(value) { return Number(value || 0).toLocaleString('es-ES'); }
function catalogueEmbed(section, query = '', page = 0) {
  const data = readCatalogue();
  const rows = data[section];
  if (!Array.isArray(rows)) throw Error('Categoría inválida');
  const normalized = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const filtered = rows.filter(item => !normalized || JSON.stringify(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').includes(normalized));
  const pageSize = section === 'dinos' ? 8 : 15;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(Math.max(0, page), pages - 1);
  const items = filtered.slice(current * pageSize, (current + 1) * pageSize);
  const body = items.map(item => {
    const name = item.name || 'Artículo';
    const cost = `${number(item.points)} puntos`;
    if (section === 'dinos') return `**${name}** · ${cost}\nNv. ${item.level ?? '—'} · Tier ${item.tier ?? '—'} · Montura: ${item.saddle || '—'} · Cantidad: ${item.quantity ?? 1}`;
    if (section === 'boxes') return `**${name}** · ${cost}\n${item.description || 'Caja o kit del catálogo'}`;
    return `**${name}** · ${cost} · Cantidad: ${item.quantity ?? 1}`;
  }).join('\n\n') || 'No hay resultados para esta búsqueda.';
  const embed = new EmbedBuilder().setColor(COLORS.brown).setTitle(`🛒 ${sectionLabel(section)}`)
    .setDescription(body.slice(0, 4000))
    .setFooter({ text: `${BRAND} · ${filtered.length} opciones · Página ${current + 1}/${pages}${query ? ` · Buscar: ${text(query, 40)}` : ''}` });
  if (query) embed.setAuthor({ name: 'Resultados de búsqueda' });
  return { embeds: [embed], components: catalogueComponents(section, current, pages, query) };
}
function catalogueComponents(section, page, pages, query, owner, token) {
  const who = owner || 'public';
  const select = new StringSelectMenuBuilder().setCustomId(`tienda:seccion:${who}`)
    .setPlaceholder('Selecciona una categoría')
    .addOptions(SECTIONS.filter(row => row[0] !== 'premium').map(([value, label, emoji]) => ({ value, label, emoji, default: value === section })));
  const search = new ButtonBuilder().setCustomId(`tienda:buscar:${who}:${section}`).setLabel('Buscar').setEmoji('🔎').setStyle(ButtonStyle.Secondary);
  const searchToken = token || '-';
  const previous = new ButtonBuilder().setCustomId(`tienda:pagina:${who}:${section}:${page - 1}:${searchToken}`).setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0);
  const next = new ButtonBuilder().setCustomId(`tienda:pagina:${who}:${section}:${page + 1}:${searchToken}`).setLabel('Siguiente').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1);
  return [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(previous, search, next)];
}
function premiumPayload() {
  const points = OFFERS.points.map(row => `• **$${Number(row.usd).toFixed(2)} USD** · ${number(row.points)} puntos`).join('\n');
  const kits = OFFERS.kits.map(row => `• **${row.name}** · $${Number(row.usd).toFixed(2)} USD · ${number(row.points)} pts\n  ${row.dinoCount} dino(s) tier ${row.tier} · ${row.armor} · ${row.weapons} · ${row.saddles}`).join('\n');
  const embed = new EmbedBuilder().setColor(COLORS.gold).setTitle('💎 Kits y paquetes de puntos')
    .setDescription('Ofertas en USD. La compra se coordina por ticket; revisa los detalles antes de solicitar.')
    .addFields({ name: '🪙 Paquetes de puntos', value: points.slice(0, 1024) }, { name: '🧰 Kits', value: kits.slice(0, 1024) })
    .setFooter({ text: `${BRAND} · Precios en USD · Las compras se atienden por ticket` });
  const ticket = env('ARK_TICKET_URL') || (channelId('ARK_TICKET_CHANNEL_ID') && `https://discord.com/channels/${env('DISCORD_GUILD_ID')}/${channelId('ARK_TICKET_CHANNEL_ID')}`);
  const components = ticket?.startsWith('https://') ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir ticket de compra').setURL(ticket),
  )] : [];
  return { embeds: [embed], components, allowedMentions: mentionsNone() };
}
function panelPayload() {
  const data = readCatalogue();
  const embed = new EmbedBuilder().setColor(COLORS.wine).setTitle('🛒 Bazar de ArkMillennia Fenix')
    .setDescription('Consulta criaturas, artículos, cajas, mejoras y ofertas premium. Las búsquedas y fichas se muestran en privado.')
    .addFields(...SECTIONS.filter(row => row[0] !== 'premium').map(([key, label, emoji]) => ({
      name: `${emoji} ${label}`, value: `**${data[key]?.length || 0}** opciones`, inline: true,
    })), { name: '💎 Kits y puntos · USD', value: `${OFFERS.points.length} paquetes de puntos y ${OFFERS.kits.length} kits disponibles.`, inline: false })
    .setFooter({ text: 'MF:shop-panel' });
  const select = new StringSelectMenuBuilder().setCustomId('tienda:panel').setPlaceholder('Selecciona qué quieres consultar')
    .addOptions(SECTIONS.map(([value, label, emoji]) => ({ value, label, emoji })));
  const rows = [new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tienda:premium').setLabel('Kits y puntos · USD').setEmoji('💎').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tienda:buscar:public:dinos').setLabel('Buscar dinosaurio').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
  )];
  return { embeds: [embed], components: rows };
}
async function showCatalog(interaction, section, query = '', page = 0, owner = interaction.user.id, mode = 'reply', token = '') {
  const payload = catalogueEmbed(section, query, page);
  const normalized = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  const count = CATALOGUE[section].filter(item => !normalized || JSON.stringify(item).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').includes(normalized)).length;
  const pageSize = section === 'dinos' ? 8 : 15;
  const pages = Math.max(1, Math.ceil(count / pageSize));
  if (query && !token) {
    token = crypto.randomBytes(6).toString('hex');
    for (const [key, value] of searchTokens) if (value.expiresAt < Date.now()) searchTokens.delete(key);
    searchTokens.set(token, { owner, section, query, expiresAt: Date.now() + 600000 });
    while (searchTokens.size > 1000) searchTokens.delete(searchTokens.keys().next().value);
  }
  payload.components = catalogueComponents(section, Math.min(page, pages - 1), pages, query, owner, token);
  if (mode === 'update') return interaction.update({ ...payload, allowedMentions: mentionsNone() });
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral, allowedMentions: mentionsNone() });
}
async function showPremium(interaction, update = false) {
  const payload = premiumPayload();
  if (update) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}
async function command(interaction) {
  const section = interaction.options.getString('categoria') || 'dinos';
  const query = (interaction.options.getString('buscar') || '').slice(0, 80);
  if (section === 'premium') return showPremium(interaction);
  return showCatalog(interaction, section, query);
}
function modal(owner, section) {
  const form = new ModalBuilder().setCustomId(`tienda:modal:${owner}:${section}`).setTitle(`Buscar en ${sectionLabel(section)}`);
  const input = new TextInputBuilder().setCustomId('consulta').setLabel('Nombre o palabra clave')
    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setPlaceholder('Ej. rex');
  return form.addComponents(new ActionRowBuilder().addComponents(input));
}
module.exports = {
  version: '1.0.0',
  commands: [{
    data: new SlashCommandBuilder().setName('tienda').setDescription('Consulta el catálogo y las ofertas de ARK')
      .addStringOption(option => option.setName('categoria').setDescription('Sección del bazar').setRequired(false)
        .addChoices(...SECTIONS.map(([value, name]) => ({ name, value }))))
      .addStringOption(option => option.setName('buscar').setDescription('Filtra por nombre o detalle').setMaxLength(80)),
    execute: command,
  }],
  async setup(context) {
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const id = channelId('ARK_SHOP_CHANNEL_ID');
        const channel = await getGuildChannel(context.client, context.guildId, id);
        if (!channel) return;
        await updatePanel(context, { channel, key: 'shop-panel-message', marker: 'MF:shop-panel', payload: panelPayload() });
      } finally { refreshing = false; }
    };
    context.on(Events.ClientReady, () => refresh());
    context.every(300000, () => refresh());
    context.on(Events.InteractionCreate, async interaction => {
      if (interaction.isStringSelectMenu?.() && ['tienda:panel'].includes(interaction.customId)) {
        const section = interaction.values[0];
        if (section === 'premium') return showPremium(interaction);
        return showCatalog(interaction, section);
      }
      if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('tienda:seccion:')) {
        const [, , owner] = interaction.customId.split(':');
        if (owner !== 'public' && owner !== interaction.user.id) return interaction.reply({ content: 'Este menú pertenece a otra persona.', flags: MessageFlags.Ephemeral });
        return showCatalog(interaction, interaction.values[0], '', 0, owner === 'public' ? interaction.user.id : owner, owner === 'public' ? 'reply' : 'update');
      }
      if (interaction.isButton?.() && interaction.customId === 'tienda:premium') return showPremium(interaction);
      if (interaction.isButton?.() && interaction.customId.startsWith('tienda:buscar:')) {
        const [, , owner, section] = interaction.customId.split(':');
        if (owner !== 'public' && owner !== interaction.user.id) return interaction.reply({ content: 'Este menú pertenece a otra persona.', flags: MessageFlags.Ephemeral });
        return interaction.showModal(modal(interaction.user.id, section));
      }
      if (interaction.isButton?.() && interaction.customId.startsWith('tienda:pagina:')) {
        const [, , owner, section, page, token] = interaction.customId.split(':');
        if (owner !== interaction.user.id) return interaction.reply({ content: 'Este menú pertenece a otra persona.', flags: MessageFlags.Ephemeral });
        const search = token && token !== '-' ? searchTokens.get(token) : null;
        if (search && (search.owner !== owner || search.section !== section || search.expiresAt < Date.now())) return interaction.reply({ content: 'La búsqueda caducó. Ejecuta /tienda para comenzar otra.', flags: MessageFlags.Ephemeral });
        return showCatalog(interaction, section, search?.query || '', Number(page), owner, 'update', search ? token : '');
      }
      if (interaction.isModalSubmit?.() && interaction.customId.startsWith('tienda:modal:')) {
        const [, , owner, section] = interaction.customId.split(':');
        if (owner !== interaction.user.id) return interaction.reply({ content: 'Este formulario pertenece a otra persona.', flags: MessageFlags.Ephemeral });
        const query = interaction.fields.getTextInputValue('consulta').slice(0, 80);
        return showCatalog(interaction, section, query);
      }
    });
  },
};
