const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ContainerBuilder, MessageFlags,
  PermissionFlagsBits, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize,
  StringSelectMenuBuilder, TextDisplayBuilder, ThumbnailBuilder,
} = require('discord.js');
const { Readable, Transform } = require('node:stream');

const SNOWFLAKE = /^[0-9]{17,20}$/;
const KEY = /^[a-z][a-z0-9_-]{1,31}$/;
const MAX_TRANSCRIPT_MESSAGES = 500;
const TICKET_ARCHIVE_GUILD_ID = '1347720640882413659';
const TICKET_ARCHIVE_CHANNEL_ID = '1569784973790281758';
const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_CATEGORIES = [
  { key: 'ficha', name: 'Creación Ficha de PJ', description: 'Solicita la creación de tu ficha de personaje', emoji: '📄', requiredRoleId: '', enabled: true },
  { key: 'dudas', name: 'Dudas', description: 'Resuelve tus consultas sobre la comunidad', emoji: '❓', requiredRoleId: '', enabled: true },
  { key: 'bug', name: 'Reporte de Bug', description: 'Reporta errores del servidor o del bot', emoji: '👾', requiredRoleId: '', enabled: true },
  { key: 'reporte-jugador', name: 'Reporte de jugador', description: 'Informa sobre una situación con un jugador', emoji: '⚠️', requiredRoleId: '', enabled: true },
  { key: 'otro', name: 'Otro', description: 'Otras consultas que no encajan en las categorías', emoji: '💬', requiredRoleId: '', enabled: true },
];
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  panelChannelId: '', panelMessageId: '', ticketCategoryId: '', archiveCategoryId: '',
  supportRoleId: '', logChannelId: '', maxOpenPerUser: 1, panelStyle: 'buttons', panelDisplay: 'embed', panelImageName: '',
  panelTitle: 'Equipo de soporte de ArkMillennia Fenix',
  panelDescription: 'Centro de Ayuda y Soporte\n¡Hola! Bienvenid@ al soporte de la comunidad. Selecciona una categoría a continuación según tu consulta para abrir un canal privado con nuestro equipo:',
  welcomeMessage: 'Hola {user}, cuéntanos qué necesitas y el equipo de {support} te responderá aquí.',
  categories: DEFAULT_CATEGORIES,
});
const clone = value => structuredClone(value);
const safeSlug = value => String(value || 'usuario').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'usuario';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

class TicketService {
  constructor(context) {
    this.context = context;
    this.client = context.client;
    this.storage = context.storage;
    this.guildId = String(context.guildId || '');
    this.adminRoleIds = new Set((context.adminRoleIds || []).map(String));
    for (const roleId of context.dashboardRoleIds || [context.dashboardRoleId]) if (roleId) this.adminRoleIds.add(String(roleId));
    this.config = clone(DEFAULT_CONFIG);
    this.publishedPanelDisplay = '';
    this.closed = false;
    this.userLocks = new Map();
  }

  async initialize() {
    const saved = await this.storage.get('config', null);
    if (saved) {
      const migrated = { ...clone(DEFAULT_CONFIG), ...saved };
      if (saved.panelTitle === 'Centro de ayuda') migrated.panelTitle = DEFAULT_CONFIG.panelTitle;
      if (saved.panelDescription === 'Selecciona una categoría para abrir un ticket privado. El equipo de soporte te atenderá dentro del canal.') migrated.panelDescription = DEFAULT_CONFIG.panelDescription;
      if (Array.isArray(saved.categories) && saved.categories.length === 3 && ['general', 'support', 'billing'].every(key => saved.categories.some(item => item.key === key))) migrated.categories = clone(DEFAULT_CATEGORIES);
      if (!['buttons', 'select'].includes(saved.panelStyle)) migrated.panelStyle = DEFAULT_CONFIG.panelStyle;
      if (typeof migrated.panelImageName !== 'string' || !/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(migrated.panelImageName)) migrated.panelImageName = '';
      this.publishedPanelDisplay = await this.storage.get('panelDisplayPublished', saved.panelMessageId ? 'embed' : '');
      this.config = this.normalizeConfig(migrated);
      await this.storage.set('config', this.config);
    } else await this.storage.set('config', this.config);
    this.refreshTicketTopics().catch(error => this.context.log(`No se pudieron normalizar los temas de tickets: ${error.code || error.name}`));
    return this;
  }

  async refreshTicketTopics() {
    const guild = await this.guild().catch(() => null);
    if (!guild) return;
    for (const ticket of (await this.allTickets()).filter(item => item.status === 'open' || item.status === 'archived').slice(0, 100)) {
      if (!ticket.ownerId || !ticket.categoryKey) continue;
      const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
      if (!channel?.isTextBased?.()) continue;
      const topic = `Propietario: <@${ticket.ownerId}> | Categoría: ${ticket.categoryKey} | Ticket ArkMillennia Fenix`;
      if (channel.topic === topic) continue;
      await channel.setTopic(topic, 'Normalizar el tema del ticket para mostrar la mención del propietario').catch(error => {
        this.context.log(`No se pudo actualizar el tema del ticket ${ticket.channelId}: ${error.code || error.name}`);
      });
    }
  }

  async guild() {
    return this.client.guilds.cache.get(this.guildId) || await this.client.guilds.fetch(this.guildId);
  }

  hasRole(member, roleId) { return !!roleId && !!member?.roles?.cache?.has(roleId); }

  canManage(member) {
    if (!member) return false;
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return [...this.adminRoleIds].some(roleId => this.hasRole(member, roleId));
  }

  isSupport(member) { return this.canManage(member) || this.hasRole(member, this.config.supportRoleId); }
  canAccess(member) { return this.isSupport(member); }
  canManageTickets(member) { return this.isSupport(member); }

  normalizeConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Configuración de tickets inválida');
    const id = (key, required = false) => {
      const entry = value[key] ?? '';
      if (typeof entry !== 'string' || entry && !SNOWFLAKE.test(entry) || required && !entry) throw Error(`Selecciona ${key}`);
      return entry;
    };
    if (typeof value.enabled !== 'boolean') throw Error('Estado de tickets inválido');
    if (!['buttons', 'select'].includes(value.panelStyle)) throw Error('Elige botones o menú desplegable para el panel');
    if (!['embed', 'components_v2'].includes(value.panelDisplay)) throw Error('Elige un formato válido para el panel');
    if (!Number.isInteger(value.maxOpenPerUser) || value.maxOpenPerUser < 1 || value.maxOpenPerUser > 5) throw Error('El límite por usuario debe estar entre 1 y 5');
    const panelTitle = String(value.panelTitle || '').trim(), panelDescription = String(value.panelDescription || '').trim();
    const welcomeMessage = String(value.welcomeMessage || '').trim();
    if (!panelTitle || panelTitle.length > 100 || !panelDescription || panelDescription.length > 3500 || !welcomeMessage || welcomeMessage.length > 1800) {
      throw Error('Revisa el título, descripción y mensaje de bienvenida');
    }
    if (!Array.isArray(value.categories) || value.categories.length < 1 || value.categories.length > 25) throw Error('Configura entre 1 y 25 categorías');
    const keys = new Set();
    const categories = value.categories.map(category => {
      if (!category || typeof category !== 'object' || !KEY.test(category.key) || keys.has(category.key)) throw Error('Hay una categoría con identificador inválido o repetido');
      keys.add(category.key);
      const name = String(category.name || '').trim(), description = String(category.description || '').trim(), emoji = String(category.emoji || '').trim();
      const requiredRoleId = category.requiredRoleId || '';
      if (!name || name.length > 80 || !description || description.length > 100 || emoji.length > 32 || requiredRoleId && !SNOWFLAKE.test(requiredRoleId)
        || typeof category.enabled !== 'boolean') throw Error(`Revisa la categoría ${category.key}`);
      return { key: category.key, name, description, emoji, requiredRoleId, enabled: category.enabled };
    });
    const config = {
      enabled: value.enabled, panelChannelId: id('panelChannelId'), panelMessageId: id('panelMessageId'),
      ticketCategoryId: id('ticketCategoryId'), archiveCategoryId: id('archiveCategoryId'),
      supportRoleId: id('supportRoleId'), logChannelId: id('logChannelId'),
      maxOpenPerUser: value.maxOpenPerUser, panelStyle: value.panelStyle, panelDisplay: value.panelDisplay, panelImageName: typeof value.panelImageName === 'string' && /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(value.panelImageName) ? value.panelImageName : '',
      panelTitle, panelDescription, welcomeMessage, categories,
    };
    if (config.enabled && (!config.panelChannelId || !config.ticketCategoryId || !config.supportRoleId || !categories.some(item => item.enabled))) {
      throw Error('Para activar los tickets selecciona el canal del panel, la categoría de tickets y el rol de soporte');
    }
    return config;
  }

  async validateDiscordTargets(config) {
    const guild = await this.guild();
    const fetchChannel = async (id, category, label) => {
      if (!id) return null;
      const channel = await guild.channels.fetch(id).catch(() => null);
      if (!channel || (category ? channel.type !== ChannelType.GuildCategory : !channel.isTextBased())) throw Error(`El canal seleccionado para ${label} no es válido`);
      return channel;
    };
    if (config.supportRoleId && !await guild.roles.fetch(config.supportRoleId).catch(() => null)) throw Error('El rol de soporte no existe en este servidor');
    for (const roleId of config.categories.map(item => item.requiredRoleId).filter(Boolean)) {
      if (!await guild.roles.fetch(roleId).catch(() => null)) throw Error('Una categoría usa un rol que ya no existe');
    }
    await fetchChannel(config.panelChannelId, false, 'panel');
    await fetchChannel(config.ticketCategoryId, true, 'tickets');
    await fetchChannel(config.archiveCategoryId, true, 'archivo');
    await fetchChannel(config.logChannelId, false, 'registros');
    return guild;
  }

  async updateConfig(input) {
    const next = this.normalizeConfig({ ...this.config, ...(input || {}), panelMessageId: this.config.panelMessageId });
    await this.validateDiscordTargets(next);
    if (next.panelChannelId !== this.config.panelChannelId) next.panelMessageId = '';
    this.config = next;
    await this.storage.set('config', this.config);
    let panelUpdated = null;
    if (this.config.panelChannelId && this.config.panelMessageId) {
      try { panelUpdated = await this.syncPanelMessage(); }
      catch (error) { this.context.log(`No se pudo actualizar el panel publicado: ${error.code || error.name}`); panelUpdated = false; }
    }
    return { ...await this.dashboardState(), panelUpdated };
  }

  async allTickets() {
    if (typeof this.storage.entries !== 'function') return [];
    const entries = await this.storage.entries();
    return entries.filter(([key, value]) => String(key).startsWith('ticket:') && value && typeof value === 'object' && SNOWFLAKE.test(value.channelId))
      .map(([, value]) => value);
  }

  async ticket(channelId) {
    if (!SNOWFLAKE.test(String(channelId))) return null;
    return this.storage.get(`ticket:${channelId}`, null);
  }

  async saveTicket(ticket) {
    ticket.updatedAt = new Date().toISOString();
    await this.storage.set(`ticket:${ticket.channelId}`, ticket);
    return ticket;
  }

  async withUserLock(userId, task) {
    const previous = this.userLocks.get(userId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.userLocks.set(userId, current);
    await previous.catch(() => {});
    try { return await task(); }
    finally { release(); if (this.userLocks.get(userId) === current) this.userLocks.delete(userId); }
  }

  async panelEmbed() {
    return (await this.context.services.get('embeds').create({ timestamp: false }))
      .setColor(0x8f1d3d).setTitle(this.config.panelTitle).setDescription(this.config.panelDescription);
  }

  async panelPayload() {
    const categories = this.panelComponents();
    const filename = this.config.panelImageName ? `millenniafenix-ticket-panel.${this.config.panelImageName.split('.').pop()}` : '';
    const image = filename ? await this.storage.getBlob(`panel-image:${this.config.panelImageName}`) : null;
    if (filename && !image) throw Error('La imagen seleccionada ya no existe; súbela de nuevo');
    const files = image ? [{ attachment: image.data, name: filename }] : [];
    if (this.config.panelDisplay === 'components_v2') {
      const card = new ContainerBuilder().setAccentColor(0x8f1d3d);
      if (image) {
        const section = new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${this.config.panelTitle}\n${this.config.panelDescription}`))
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(`attachment://${filename}`));
        card.addSectionComponents(section);
      } else card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${this.config.panelTitle}\n${this.config.panelDescription}`));
      card.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
      for (const row of categories) card.addActionRowComponents(row);
      return { flags: MessageFlags.IsComponentsV2, components: [card], allowedMentions: { parse: [] }, ...(files.length ? { files } : {}) };
    }
    let embed = await this.panelEmbed();
    if (image) embed = embed.setThumbnail(`attachment://${filename}`);
    return { embeds: [embed], components: categories, allowedMentions: { parse: [] }, ...(files.length ? { files } : {}) };
  }

  panelComponents() {
    const categories = this.config.categories.filter(item => item.enabled);
    if (!categories.length) throw Error('Activa al menos una categoría antes de publicar el panel');
    if (this.config.panelStyle === 'buttons') {
      const rows = [];
      for (let index = 0; index < categories.length; index += 5) {
        const buttons = categories.slice(index, index + 5).map(category => {
          const button = new ButtonBuilder().setCustomId(`tickets:create:${category.key}`).setLabel(category.name).setStyle(ButtonStyle.Secondary).setDisabled(!this.config.enabled);
          if (category.emoji) button.setEmoji(category.emoji);
          return button;
        });
        rows.push(new ActionRowBuilder().addComponents(buttons));
      }
      return rows;
    }
    const options = categories.map(item => ({ label: item.name, value: item.key, description: item.description, ...(item.emoji ? { emoji: item.emoji } : {}) }));
    const menu = new StringSelectMenuBuilder().setCustomId('tickets:create').setPlaceholder('Selecciona el motivo de tu ticket…')
      .setMinValues(1).setMaxValues(1).setDisabled(!this.config.enabled).addOptions(options);
    return [new ActionRowBuilder().addComponents(menu)];
  }

  async publishPanel() {
    if (!this.config.enabled) {
      const enabled = this.normalizeConfig({ ...this.config, enabled: true });
      await this.validateDiscordTargets(enabled);
      this.config = enabled;
      await this.storage.set('config', this.config);
    }
    const guild = await this.validateDiscordTargets(this.config);
    if (!this.config.supportRoleId || !this.config.ticketCategoryId || !this.config.panelChannelId) throw Error('Guarda el canal del panel, la categoría y el rol de soporte antes de publicarlo');
    const channel = await guild.channels.fetch(this.config.panelChannelId);
    let message = null;
    if (this.config.panelMessageId) message = await channel.messages.fetch(this.config.panelMessageId).catch(() => null);
    if (message && this.publishedPanelDisplay && this.publishedPanelDisplay !== this.config.panelDisplay) { await message.delete(); message = null; this.config.panelMessageId = ''; }
    const payload = await this.panelPayload();
    if (message) await message.edit({ ...payload, attachments: [] }); else message = await channel.send(payload);
    this.config.panelMessageId = message.id;
    this.publishedPanelDisplay = this.config.panelDisplay;
    await this.storage.set('panelDisplayPublished', this.publishedPanelDisplay);
    await this.storage.set('config', this.config);
    return { panelChannelId: channel.id, panelMessageId: message.id, url: `https://discord.com/channels/${guild.id}/${channel.id}/${message.id}` };
  }

  async syncPanelMessage() {
    if (!this.config.panelChannelId || !this.config.panelMessageId) return null;
    const guild = await this.validateDiscordTargets(this.config);
    const channel = await guild.channels.fetch(this.config.panelChannelId).catch(() => null);
    if (!channel?.messages) return false;
    const message = await channel.messages.fetch(this.config.panelMessageId).catch(() => null);
    if (!message) return false;
    if (this.publishedPanelDisplay && this.publishedPanelDisplay !== this.config.panelDisplay) {
      await message.delete(); this.config.panelMessageId = ''; await this.storage.set('config', this.config);
      await this.publishPanel(); return true;
    }
    await message.edit({ ...await this.panelPayload(), attachments: [] });
    this.publishedPanelDisplay = this.config.panelDisplay;
    await this.storage.set('panelDisplayPublished', this.publishedPanelDisplay);
    return true;
  }

  async openTicket(interaction, categoryKey) {
    return this.withUserLock(interaction.user.id, async () => {
      if (!this.config.enabled) throw Error('El sistema de tickets está desactivado');
      const category = this.config.categories.find(item => item.key === categoryKey && item.enabled);
      if (!category) throw Error('Esta categoría de ticket no está disponible');
      const guild = await this.guild();
      const member = await guild.members.fetch(interaction.user.id);
      if (category.requiredRoleId && !this.hasRole(member, category.requiredRoleId)) throw Error(`Necesitas el rol «${guild.roles.cache.get(category.requiredRoleId)?.name || 'requerido'}» para abrir este ticket`);
      const active = (await this.allTickets()).filter(item => item.ownerId === member.id && item.status === 'open');
      if (active.length >= this.config.maxOpenPerUser) throw Error(`Ya tienes ${active.length} ticket(s) abierto(s). Cierra uno antes de crear otro.`);
      const support = await guild.roles.fetch(this.config.supportRoleId).catch(() => null);
      const parent = await guild.channels.fetch(this.config.ticketCategoryId).catch(() => null);
      if (!support || !parent || parent.type !== ChannelType.GuildCategory) throw Error('El rol o la categoría de tickets ya no están disponibles');
      const botMember = guild.members.me || await guild.members.fetchMe();
      const viewPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
      const writePermissions = [...viewPermissions, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks];
      const name = `ticket-${safeSlug(category.key)}-${safeSlug(member.user.username)}`.slice(0, 95);
      const channel = await guild.channels.create({
        name, type: ChannelType.GuildText, parent: parent.id,
        topic: `Propietario: <@${member.id}> | Categoría: ${category.key} | Ticket ArkMillennia Fenix`,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: member.id, allow: writePermissions },
          { id: support.id, allow: writePermissions },
          { id: botMember.id, allow: [...writePermissions, PermissionFlagsBits.ManageChannels] },
        ],
        reason: `Ticket de ${member.user.tag || member.user.username}`,
      });
      const now = new Date().toISOString();
      const ticket = { channelId: channel.id, guildId: guild.id, ownerId: member.id, ownerName: member.displayName || member.user.username,
        categoryKey: category.key, categoryName: category.name, status: 'open', claimedById: '', claimedByName: '',
        createdAt: now, updatedAt: now, lastActivityAt: now, closedAt: null, transcriptAvailable: false };
      try { await this.storage.set(`ticket:${channel.id}`, ticket); }
      catch (error) { await channel.delete('No se pudo guardar el registro del ticket').catch(() => {}); throw error; }
      const welcome = this.config.welcomeMessage.replaceAll('{user}', `<@${member.id}>`).replaceAll('{support}', `<@&${support.id}>`);
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tickets:claim').setLabel('Atender').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tickets:close').setLabel('Cerrar ticket').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tickets:archive').setLabel('Archivar').setStyle(ButtonStyle.Danger),
      );
      const embed = await this.context.services.get('embeds').create({ timestamp: false });
      embed.setColor(0x8f1d3d).setTitle(`Ticket · ${category.name}`).setDescription(welcome)
        .addFields({ name: 'Categoría', value: category.name, inline: true }, { name: 'Estado', value: 'Abierto', inline: true });
      await channel.send({ content: `<@${member.id}> <@&${support.id}>`, embeds: [embed], components: [buttons],
        allowedMentions: { users: [member.id], roles: [support.id], parse: [] } });
      await this.logTicket(ticket, 'Ticket creado', member.user);
      return { ticket, channel };
    });
  }

  async logTicket(ticket, title, actor) {
    if (!this.config.logChannelId) return;
    const guild = await this.guild();
    const channel = await guild.channels.fetch(this.config.logChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    const embed = (await this.context.services.get('embeds').create({ timestamp: false })).setColor(0x8f1d3d).setTitle(title).addFields(
      { name: 'Canal', value: `<#${ticket.channelId}>`, inline: true },
      { name: 'Propietario', value: `<@${ticket.ownerId}>`, inline: true },
      { name: 'Categoría', value: ticket.categoryName, inline: true },
      { name: 'Acción por', value: actor?.id ? `<@${actor.id}>` : 'Sistema', inline: true },
    );
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(error => this.context.log(`No se pudo registrar un evento de tickets: ${error.name}`));
  }

  async claimTicket(channelId, member) {
    if (!this.canManageTickets(member)) throw Error('Solo soporte puede atender tickets');
    const ticket = await this.ticket(channelId);
    if (!ticket || ticket.status !== 'open') throw Error('El ticket ya no está abierto');
    if (ticket.claimedById && ticket.claimedById !== member.id) throw Error(`Este ticket ya lo atiende ${ticket.claimedByName || 'otro miembro de soporte'}`);
    const releasing = ticket.claimedById === member.id;
    ticket.claimedById = releasing ? '' : member.id;
    ticket.claimedByName = releasing ? '' : member.displayName || member.user?.username || member.id;
    await this.saveTicket(ticket);
    const guild = await this.guild(), channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased?.()) await channel.send({ content: releasing ? 'El ticket quedó disponible para soporte.' : `🛡️ ${member} está atendiendo este ticket.`, allowedMentions: { users: releasing ? [] : [member.id], parse: [] } });
    await this.logTicket(ticket, releasing ? 'Ticket liberado' : 'Ticket atendido', member.user || member);
    return ticket;
  }

  async setTicketUser(channelId, actor, userId, add) {
    if (!this.canManageTickets(actor)) throw Error('Solo soporte puede cambiar el acceso al ticket');
    const ticket = await this.ticket(channelId);
    if (!ticket || ticket.status !== 'open') throw Error('El ticket ya no está abierto');
    if (String(userId) === ticket.ownerId) throw Error('El propietario ya tiene acceso al ticket');
    const guild = await this.guild(), channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw Error('No se encontró el canal del ticket');
    const member = await guild.members.fetch(String(userId)).catch(() => null);
    if (!member || member.user.bot) throw Error('Selecciona a una persona del servidor');
    if (add) await channel.permissionOverwrites.edit(member.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true, AttachFiles: true, EmbedLinks: true });
    else {
      const overwrite = channel.permissionOverwrites.cache.get(member.id);
      if (!overwrite) throw Error('Esa persona no tiene acceso individual al ticket');
      await channel.permissionOverwrites.delete(member.id, 'Acceso al ticket retirado por soporte');
    }
    await channel.send({ content: add ? `${member} fue añadido al ticket por ${actor}.` : `Se retiró el acceso de ${member} por ${actor}.`,
      allowedMentions: { users: [member.id], parse: [] } });
    await this.logTicket(ticket, add ? 'Persona añadida al ticket' : 'Persona retirada del ticket', actor.user || actor);
    return { ticket, member };
  }

  async unclaimTicket(channelId, member) {
    if (!this.canManageTickets(member)) throw Error('Solo soporte puede liberar tickets');
    const ticket = await this.ticket(channelId);
    if (!ticket || ticket.status !== 'open') throw Error('El ticket ya no está abierto');
    if (ticket.claimedById && ticket.claimedById !== member.id && !this.canManage(member)) throw Error('Solo quien atiende el ticket o un administrador puede liberarlo');
    ticket.claimedById = ''; ticket.claimedByName = '';
    await this.saveTicket(ticket);
    const guild = await this.guild(), channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased?.()) await channel.send('El ticket quedó disponible para soporte.');
    await this.logTicket(ticket, 'Ticket liberado', member.user || member);
    return ticket;
  }

  async copyTicketAttachments(channel, ticket) {
    const saved = new Map((ticket.archivedAttachments || []).map(item => [item.sourceAttachmentId, item]));
    let archiveGuild = null, archiveChannel = null, before;
    const fetchAttachment = async attachment => {
      if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_ARCHIVE_FILE_BYTES) {
        throw Error(`El archivo «${attachment.name || 'adjunto'}» supera el tamaño que este proceso puede copiar con seguridad. El canal no se eliminará.`);
      }
      let source;
      try { source = new URL(attachment.url); } catch { throw Error('Discord devolvió una URL de adjunto inválida; el canal no se eliminará.'); }
      if (source.protocol !== 'https:' || !/(^|\.)discord(?:app)?\.(?:com|net)$/.test(source.hostname)) throw Error('El adjunto no viene del CDN de Discord; el canal no se eliminará.');
      const response = await fetch(source.href);
      if (!response.ok || !response.body) throw Error(`No se pudo descargar «${attachment.name || 'adjunto'}» desde Discord (HTTP ${response.status}); el canal no se eliminará.`);
      const finalUrl = new URL(response.url || source.href);
      if (finalUrl.protocol !== 'https:' || !/(^|\.)discord(?:app)?\.(?:com|net)$/.test(finalUrl.hostname)) throw Error('La descarga del adjunto salió del CDN de Discord; el canal no se eliminará.');
      let received = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > MAX_ARCHIVE_FILE_BYTES) done(Error('El adjunto supera el límite de transferencia; el canal no se eliminará.'));
        else done(null, chunk);
      } });
      return Readable.fromWeb(response.body).pipe(limit);
    };
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!batch.size) break;
      const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const message of ordered) {
        const pending = [...message.attachments.values()].filter(file => !saved.has(file.id));
        if (!pending.length) continue;
        if (!archiveChannel) {
          archiveGuild = await this.client.guilds.fetch(TICKET_ARCHIVE_GUILD_ID).catch(() => null);
          if (!archiveGuild) throw Error('El bot no tiene acceso al servidor de archivo configurado; no se eliminará el canal del ticket.');
          archiveChannel = await archiveGuild.channels.fetch(TICKET_ARCHIVE_CHANNEL_ID).catch(() => null);
          if (!archiveChannel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(archiveChannel.type) || archiveChannel.guildId !== archiveGuild.id || !archiveChannel.send) {
            throw Error('No está disponible el canal de archivo de adjuntos; no se eliminará el canal del ticket.');
          }
          const botMember = archiveGuild.members.me || await archiveGuild.members.fetchMe().catch(() => null);
          const permissions = botMember && archiveChannel.permissionsFor(botMember);
          if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles])) {
            throw Error('El bot necesita ver el canal de archivo y tener permisos para enviar mensajes y adjuntos; no se eliminará el canal del ticket.');
          }
        }
        for (const file of pending) {
          const stream = await fetchAttachment(file);
          const originalName = String(file.name || 'archivo').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-120) || 'archivo';
          const uploadName = `${message.id}-${file.id}-${originalName}`.slice(0, 240);
          const author = message.member?.displayName || message.author?.globalName || message.author?.username || 'Usuario';
          const messageUrl = `https://discord.com/channels/${channel.guildId}/${channel.id}/${message.id}`;
          const content = [
            '📎 **Adjunto recuperado de un ticket ArkMillennia Fenix**',
            `**Ticket:** ${ticket.channelId} · ${ticket.categoryName}`,
            `**Servidor de origen:** ${channel.guild.name} (${channel.guildId})`,
            `**Canal original:** #${channel.name} (${channel.id})`,
            `**Mensaje original:** ${message.id}`,
            `**Autor:** ${author} (${message.author.id}) · ${new Date(message.createdTimestamp).toISOString()}`,
            `**Texto del mensaje:** ${(message.content || '_(sin texto)_').slice(0, 700)}`,
            `**Archivo:** ${originalName}`,
          ].join('\n');
          let archived;
          try {
            archived = await archiveChannel.send({ content, files: [{ attachment: stream, name: uploadName }], allowedMentions: { parse: [] } });
          } catch (error) {
            throw Error(`Discord no pudo copiar «${originalName}» al canal de archivo (${error.code || error.name}); el canal del ticket no se eliminará.`);
          }
          const copy = archived.attachments.find(item => item.name === uploadName) || archived.attachments.first();
          if (!copy?.url) throw Error(`Discord no confirmó la copia de «${originalName}»; el canal del ticket no se eliminará.`);
          const record = { sourceAttachmentId: file.id, sourceMessageId: message.id, sourceChannelId: channel.id,
            sourceMessageUrl: messageUrl, originalName, contentType: file.contentType || '', size: file.size,
            archiveChannelId: archiveChannel.id, archiveMessageId: archived.id, archiveAttachmentId: copy.id, archiveMessageUrl: archived.url, url: copy.url };
          ticket.archivedAttachments ||= [];
          ticket.archivedAttachments.push(record);
          saved.set(file.id, record);
          await this.saveTicket(ticket);
        }
      }
      before = ordered[0].id;
      if (batch.size < 100) break;
    }
    return ticket.archivedAttachments || [];
  }

  async transcriptHtml(channel, ticket) {
    const messages = [];
    let before;
    while (messages.length < MAX_TRANSCRIPT_MESSAGES) {
      const batch = await channel.messages.fetch({ limit: Math.min(100, MAX_TRANSCRIPT_MESSAGES - messages.length), ...(before ? { before } : {}) });
      if (!batch.size) break;
      const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      messages.unshift(...ordered);
      before = ordered[0].id;
      if (batch.size < 100) break;
    }
    const guild = channel.guild;
    const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? escapeHtml(url.href) : ''; } catch { return ''; } };
    const markdown = (value, message) => {
      let text = String(value || '');
      const protectedHtml = [];
      const protect = html => { const key = `\u0000${protectedHtml.length}\u0000`; protectedHtml.push(html); return key; };
      text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => protect(`<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`))
        .replace(/`([^`\n]+)`/g, (_m, code) => protect(`<code>${escapeHtml(code)}</code>`));
      text = escapeHtml(text);
      text = text.replace(/&lt;@!?(\d{17,20})&gt;/g, (_m, id) => protect(`<span class="mention">@${escapeHtml(guild.members.cache.get(id)?.displayName || guild.members.cache.get(id)?.user?.username || message.mentions.users.get(id)?.username || 'usuario')}</span>`))
        .replace(/&lt;@&(\d{17,20})&gt;/g, (_m, id) => protect(`<span class="mention">@${escapeHtml(guild.roles.cache.get(id)?.name || 'rol')}</span>`))
        .replace(/&lt;#(\d{17,20})&gt;/g, (_m, id) => protect(`<span class="mention">#${escapeHtml(guild.channels.cache.get(id)?.name || 'canal')}</span>`))
        .replace(/&lt;(a?):([a-zA-Z0-9_]{2,32}):(\d{17,20})&gt;/g, (_m, animated, name, id) => protect(`<img class="emoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=40" alt=":${escapeHtml(name)}:" loading="lazy">`))
        .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_m, url) => { const href = safeUrl(url.replace(/&amp;/g, '&')); return href ? protect(`<a href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`) : url; });
      text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => { const href = safeUrl(url.replace(/&amp;/g, '&')); return href ? protect(`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`) : label; })
        .replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, (_m, prefix, url) => { const clean = url.replace(/[.,!?;:)]+$/, ''), suffix = url.slice(clean.length), href = safeUrl(clean.replace(/&amp;/g, '&')); return href ? `${prefix}${protect(`<a href="${href}" target="_blank" rel="noopener noreferrer">${clean}</a>`)}${suffix}` : `${prefix}${url}`; })
        .replace(/\|\|([\s\S]+?)\|\|/g, (_m, body) => protect(`<span class="spoiler" tabindex="0" title="Revelar spoiler">${body}</span>`))
        .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/__\*\*\*([^*\n]+)\*\*\*__/g, '<u><strong><em>$1</em></strong></u>')
        .replace(/__\*([^*\n]+)\*__/g, '<u><em>$1</em></u>').replace(/__\*\*([^*\n]+)\*\*__/g, '<u><strong>$1</strong></u>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        .replace(/__([^_\n]+)__/g, '<u>$1</u>').replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
        .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
      let quoteAll = false;
      text = text.split('\n').map(line => {
        if (line.startsWith('>>> ')) { quoteAll = true; return `<blockquote>${line.slice(4)}</blockquote>`; }
        if (quoteAll) return `<blockquote>${line}</blockquote>`;
        const heading = line.match(/^(#{1,3}) (.*)$/);
        if (heading) return `<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`;
        if (line.startsWith('-# ')) return `<small class="subtext">${line.slice(3)}</small>`;
        const quote = line.match(/^&gt; ?(.*)$/);
        if (quote) return `<blockquote>${quote[1]}</blockquote>`;
        const list = line.match(/^(\s*)([-*]|\d+[.)])\s+(.+)$/);
        if (list) return `<div class="md-list" style="--depth:${Math.min(6, Math.floor(list[1].length / 2))}"><span>${/^\d/.test(list[2]) ? escapeHtml(list[2]) : '•'}</span>${list[3]}</div>`;
        return line || '<br>';
      }).join('');
      return text.replace(/\u0000(\d+)\u0000/g, (_m, index) => protectedHtml[Number(index)] || '');
    };
    const archivedById = new Map((ticket.archivedAttachments || []).map(item => [item.sourceAttachmentId, item]));
    const mediaType = (type, name) => type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' }[String(name || '').split('.').pop().toLowerCase()] || '');
    const media = message => [...message.attachments.values()].map(file => {
      const archived = archivedById.get(file.id), url = archived ? `/extensions/tickets/api/tickets/${ticket.channelId}/attachments/${file.id}` : safeUrl(file.url), mime = mediaType(archived?.contentType || file.contentType, archived?.originalName || file.name);
      if (!url) return '';
      if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(file.url)) return `<a class="media" href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="${escapeHtml(file.name || 'Imagen adjunta')}" loading="lazy"></a>`;
      if (mime.startsWith('video/')) return `<video controls preload="metadata" src="${url}"></video>`;
      if (mime.startsWith('audio/')) return `<audio controls preload="metadata" src="${url}"></audio>`;
      return `<a class="file" href="${url}" target="_blank" rel="noopener noreferrer"><span>▤</span><span>${escapeHtml(file.name || 'Archivo adjunto')}<small>${file.size ? `${(file.size / 1024).toFixed(0)} KB` : 'Descargar archivo'}</small></span></a>`;
    }).join('');
    const embedsHtml = message => message.embeds.map(embed => {
      const data = embed.toJSON(), color = Number.isInteger(data.color) ? `#${data.color.toString(16).padStart(6, '0')}` : '#8f1d3d';
      const link = safeUrl(data.url), title = data.title ? (link ? `<a href="${link}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.title)}</a>` : escapeHtml(data.title)) : '';
      const fields = (data.fields || []).map(field => `<div class="embed-field"><b>${escapeHtml(field.name)}</b><div>${markdown(field.value, message)}</div></div>`).join('');
      const image = data.image?.url && safeUrl(data.image.url) ? `<img class="embed-image" src="${safeUrl(data.image.url)}" loading="lazy" alt="">` : '';
      const thumb = data.thumbnail?.url && safeUrl(data.thumbnail.url) ? `<img class="embed-thumb" src="${safeUrl(data.thumbnail.url)}" loading="lazy" alt="">` : '';
      return `<aside class="embed" style="--embed-color:${color}">${data.author?.name ? `<small>${escapeHtml(data.author.name)}</small>` : ''}${thumb}${title ? `<h3>${title}</h3>` : ''}${data.description ? `<div>${markdown(data.description, message)}</div>` : ''}${fields}${image}${data.footer?.text ? `<small>${escapeHtml(data.footer.text)}</small>` : ''}</aside>`;
    }).join('');
    const body = messages.map(message => {
      const author = message.member?.displayName || message.author?.globalName || message.author?.username || 'Usuario';
      const avatar = safeUrl(message.author?.displayAvatarURL?.({ size: 64 }) || '');
      const timestamp = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short' }).format(message.createdAt);
      const content = markdown(message.content, message);
      const sticker = [...(message.stickers?.values?.() || [])].map(item => `<span class="sticker">Sticker: ${escapeHtml(item.name)}</span>`).join('');
      return `<article class="message">${avatar ? `<img class="avatar" src="${avatar}" alt="">` : '<span class="avatar fallback">✦</span>'}<div class="message-body"><header><strong>${escapeHtml(author)}</strong>${message.author?.bot ? '<span class="bot-tag">BOT</span>' : ''}<time>${escapeHtml(timestamp)}${message.editedTimestamp ? ' · editado' : ''}</time></header>${content ? `<div class="content">${content}</div>` : ''}${media(message)}${embedsHtml(message)}${sticker}</div></article>`;
    }).join('\n');
    const visibleAttachmentIds = new Set(messages.flatMap(message => [...message.attachments.keys()]));
    const olderAttachments = (ticket.archivedAttachments || []).filter(item => !visibleAttachmentIds.has(item.sourceAttachmentId));
    const archivedExtras = olderAttachments.length ? `<section class="archive-media"><h2>Adjuntos anteriores del ticket</h2><p>Estos archivos pertenecen a mensajes anteriores incluidos en el archivo de ArkMillennia Fenix.</p>${olderAttachments.map(item => {
      const url = `/extensions/tickets/api/tickets/${ticket.channelId}/attachments/${item.sourceAttachmentId}`, mime = mediaType(item.contentType, item.originalName), label = escapeHtml(item.originalName || 'Archivo adjunto');
      if (!url) return '';
      const preview = mime.startsWith('image/') ? `<a href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" loading="lazy" alt="${label}"></a>`
        : mime.startsWith('video/') ? `<video controls preload="metadata" src="${url}"></video>`
          : mime.startsWith('audio/') ? `<audio controls preload="metadata" src="${url}"></audio>`
            : `<a class="file" href="${url}" target="_blank" rel="noopener noreferrer">${label} · Descargar</a>`;
      const archiveLink = safeUrl(item.archiveMessageUrl);
      return `<article class="archive-item"><div><strong>${label}</strong><small>Mensaje original ${escapeHtml(item.sourceMessageId)}</small></div>${preview}${archiveLink ? `<a href="${archiveLink}" target="_blank" rel="noopener noreferrer">Ver referencia en Discord</a>` : ''}</article>`;
    }).join('')}</section>` : '';
    const truncated = messages.length >= MAX_TRANSCRIPT_MESSAGES ? '<p class="notice">Se muestran los 500 mensajes más recientes.</p>' : '';
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Transcripción · ${escapeHtml(ticket.categoryName)}</title><style>
      *{box-sizing:border-box}body{margin:0;background:#313338;color:#dbdee1;font:15px/1.45 "gg sans","Noto Sans",system-ui,sans-serif}.shell{max-width:1100px;min-height:100vh;margin:auto;background:#313338}.top{position:sticky;top:0;z-index:2;padding:15px 24px;background:#2b2d31;border-bottom:1px solid #1e1f22;box-shadow:0 2px 8px #0002}.channel{font-weight:700;color:#f2f3f5}.channel:before{content:"#";color:#949ba4;margin-right:9px;font-size:22px}.meta{margin-top:6px;color:#aeb3bb;font-size:12px}.chat{padding:24px 24px 40px}.notice{margin:0 0 14px;padding:10px 13px;border-radius:6px;background:#3f4147;color:#f0d68e}.message{display:flex;gap:15px;padding:8px 0;overflow-wrap:anywhere}.message:hover{background:#2e3035}.avatar{flex:none;width:40px;height:40px;border-radius:50%;object-fit:cover;background:#1e1f22}.avatar.fallback{display:grid;place-items:center;color:#8f1d3d}.message-body{min-width:0;flex:1}.message header{display:flex;align-items:baseline;gap:7px;margin:0 0 2px}.message strong{color:#f2f3f5;font-weight:600}.message time{color:#949ba4;font-size:11px}.bot-tag{padding:1px 4px;border-radius:3px;background:#8f1d3d;color:#fff;font-size:9px;font-weight:700}.content{white-space:normal}.content a,.embed a,.file,.archive-item>a{color:#00a8fc}.content a:hover,.embed a:hover{text-decoration:underline}.content strong{font-weight:700}.content del{text-decoration:line-through}.content h1,.content h2,.content h3{margin:5px 0;color:#f2f3f5}.content h1{font-size:1.4em}.content h2{font-size:1.2em}.content h3{font-size:1.05em}.content pre{overflow:auto;padding:10px;border-radius:5px;background:#2b2d31;font:13px/1.5 ui-monospace,monospace}.content code{padding:2px 4px;border-radius:3px;background:#2b2d31;font:13px ui-monospace,monospace}.content pre code{padding:0;background:none}.content blockquote{margin:3px 0;padding:2px 0 2px 10px;border-left:3px solid #4e5058;color:#b5bac1}.content .subtext{color:#949ba4;font-size:.85em}.content .md-list{padding-left:calc(18px + var(--depth)*18px)}.content .md-list span{display:inline-block;min-width:20px;color:#b5bac1}.content .spoiler{border-radius:3px;background:#202225;color:transparent;cursor:pointer}.content .spoiler:hover,.content .spoiler:focus{background:#4e5058;color:#dbdee1}.mention{padding:0 2px;border-radius:3px;background:#414675;color:#c9cdfb;font-weight:500}.quote{border-left:3px solid #4e5058;padding-left:9px;color:#b5bac1}.emoji{width:1.35em;height:1.35em;vertical-align:-.3em;object-fit:contain}.media{display:block;margin-top:8px;max-width:min(550px,100%)}.media img,.embed-image{display:block;max-width:100%;max-height:480px;border-radius:4px;object-fit:contain}.message video,.archive-item video{display:block;max-width:min(550px,100%);max-height:420px;margin-top:8px;border-radius:4px}.message audio,.archive-item audio{display:block;max-width:100%;margin-top:8px}.file{display:flex;align-items:center;gap:10px;width:max-content;max-width:100%;margin-top:8px;padding:10px 13px;border:1px solid #1e1f22;border-radius:5px;background:#2b2d31;text-decoration:none}.file small{display:block;color:#949ba4;font-size:11px}.embed{position:relative;max-width:520px;margin-top:8px;padding:12px 14px;border-left:4px solid var(--embed-color);border-radius:4px;background:#2b2d31}.embed h3{margin:2px 0 6px;font-size:15px}.embed small{color:#b5bac1;font-size:11px}.embed-field{margin-top:8px}.embed-thumb{float:right;max-width:80px;max-height:80px;object-fit:contain}.embed-image{margin-top:8px}.sticker{display:block;margin-top:5px;color:#b5bac1;font-size:12px}.archive-media{margin:25px 0 0;padding-top:18px;border-top:1px solid #1e1f22}.archive-media h2{font-size:17px}.archive-media>p,.archive-item small{color:#949ba4;font-size:12px}.archive-item{display:grid;gap:7px;padding:13px 0;border-bottom:1px solid #3f4147}.archive-item img{max-width:min(550px,100%);max-height:480px;object-fit:contain;border-radius:4px}.empty{padding:38px 0;text-align:center;color:#949ba4}@media(max-width:600px){.top{padding:12px 15px}.chat{padding:16px 12px}.message{gap:10px}.avatar{width:34px;height:34px}}
      </style></head><body><div class="shell"><header class="top"><div class="channel">${escapeHtml(channel.name)}</div><div class="meta">Transcripción del ticket · ${escapeHtml(ticket.categoryName)} · Propietario: @${escapeHtml(ticket.ownerName)} · Creado ${escapeHtml(new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ticket.createdAt)))}</div></header><main class="chat">${truncated}${body || '<p class="empty">El canal no tenía mensajes.</p>'}${archivedExtras}</main></div></body></html>`;
  }

  async closeTicket(channelId, actor) {
    const ticket = await this.ticket(channelId);
    if (!ticket || ticket.status !== 'open') throw Error('El ticket ya no está abierto');
    if (!this.canManageTickets(actor) && actor?.id !== ticket.ownerId) throw Error('Solo el propietario o soporte puede cerrar este ticket');
    const guild = await this.guild(), channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw Error('No se encontró el canal del ticket');
    await this.copyTicketAttachments(channel, ticket);
    const html = await this.transcriptHtml(channel, ticket);
    await this.storage.setBlob(`transcript:${channelId}.html`, Buffer.from(html, 'utf8'), 'text/html; charset=utf-8');
    ticket.transcriptAvailable = true; ticket.status = 'deleted'; ticket.closedAt = new Date().toISOString();
    await this.saveTicket(ticket);
    try {
      await channel.delete('Ticket cerrado; transcripción guardada en ArkMillennia Fenix Dashboard');
    } catch (error) {
      ticket.status = 'open'; ticket.closedAt = null; await this.saveTicket(ticket);
      this.context.log(`No se pudo borrar el canal tras guardar la transcripción: ${error.name}`);
      throw Error('La transcripción quedó guardada, pero Discord no permitió borrar el canal. El ticket sigue abierto para que soporte pueda reintentar.');
    }
    await this.logTicket(ticket, 'Ticket cerrado y canal eliminado', actor.user || actor);
    return ticket;
  }

  async archiveTicket(channelId, actor) {
    const ticket = await this.ticket(channelId);
    if (!ticket || ticket.status !== 'open') throw Error('El ticket ya no está abierto');
    if (!this.canManageTickets(actor) && actor?.id !== ticket.ownerId) throw Error('Solo el propietario o soporte puede archivar este ticket');
    const guild = await this.guild(), channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw Error('No se encontró el canal del ticket');
    const transcript = await this.transcriptHtml(channel, ticket).catch(error => {
      this.context.log(`No se pudo generar la transcripción: ${error.name}`); return null;
    });
    if (transcript) {
      try {
        await this.storage.setBlob(`transcript:${channelId}.html`, Buffer.from(transcript, 'utf8'), 'text/html; charset=utf-8');
        ticket.transcriptAvailable = true;
      } catch (error) { ticket.transcriptAvailable = false; this.context.log(`No se pudo guardar la transcripción: ${error.name}`); }
    }
    const owner = await guild.members.fetch(ticket.ownerId).catch(() => null);
    if (owner) await channel.permissionOverwrites.edit(owner.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: false, AttachFiles: false });
    const archiveParent = this.config.archiveCategoryId ? await guild.channels.fetch(this.config.archiveCategoryId).catch(() => null) : null;
    if (archiveParent?.type === ChannelType.GuildCategory) await channel.setParent(archiveParent.id, { lockPermissions: false });
    await channel.setName(`closed-${safeSlug(ticket.categoryKey)}-${safeSlug(ticket.ownerName)}`.slice(0, 95));
    ticket.status = 'archived'; ticket.closedAt = new Date().toISOString();
    await this.saveTicket(ticket);
    const reopen = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tickets:reopen').setLabel('Reabrir ticket').setStyle(ButtonStyle.Secondary));
    const embed = (await this.context.services.get('embeds').create({ timestamp: false })).setColor(0x69736a).setTitle('Ticket archivado')
      .setDescription(`Archivado por ${actor}. El propietario puede reabrirlo desde este canal.`);
    await channel.send({ embeds: [embed], components: [reopen], allowedMentions: { users: [ticket.ownerId], parse: [] } });
    await this.logTicket(ticket, 'Ticket archivado', actor.user || actor);
    return ticket;
  }

  async reopenTicket(channelId, actor) {
    const ticket = await this.ticket(channelId);
    if (!ticket || ticket.status !== 'archived') throw Error('El ticket no está archivado');
    if (actor.id !== ticket.ownerId && !this.canManageTickets(actor)) throw Error('Solo el propietario o soporte puede reabrir este ticket');
    const guild = await this.guild(), channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw Error('No se encontró el canal del ticket');
    const owner = await guild.members.fetch(ticket.ownerId).catch(() => null);
    if (!owner) throw Error('El propietario ya no está en el servidor');
    if (this.config.ticketCategoryId) await channel.setParent(this.config.ticketCategoryId, { lockPermissions: false });
    await channel.permissionOverwrites.edit(owner.id, { ViewChannel: true, ReadMessageHistory: true, SendMessages: true, AttachFiles: true });
    await channel.setName(`ticket-${safeSlug(ticket.categoryKey)}-${safeSlug(ticket.ownerName)}`.slice(0, 95));
    ticket.status = 'open'; ticket.closedAt = null;
    await this.saveTicket(ticket);
    const components = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tickets:claim').setLabel('Atender').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('tickets:close').setLabel('Cerrar ticket').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tickets:archive').setLabel('Archivar').setStyle(ButtonStyle.Danger),
    );
    await channel.send({ content: `Ticket reabierto por ${actor}.`, components: [components], allowedMentions: { users: [ticket.ownerId], parse: [] } });
    await this.logTicket(ticket, 'Ticket reabierto', actor.user || actor);
    return ticket;
  }

  async dashboardState() {
    const guild = await this.guild();
    await Promise.all([guild.roles.fetch().catch(() => null), guild.channels.fetch().catch(() => null)]);
    const tickets = (await this.allTickets()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 100);
    return {
      config: clone(this.config), guild: { id: guild.id, name: guild.name },
      roles: [...guild.roles.cache.values()].filter(role => role.id !== guild.id).sort((a, b) => b.position - a.position).map(role => ({ id: role.id, name: role.name })),
      channels: [...guild.channels.cache.values()].filter(channel => channel.type === ChannelType.GuildCategory || channel.isTextBased?.())
        .map(channel => ({ id: channel.id, name: channel.name, type: channel.type === ChannelType.GuildCategory ? 'category' : 'text' }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
      tickets: tickets.map(ticket => ({ ...ticket, url: `https://discord.com/channels/${guild.id}/${ticket.channelId}` })),
      counts: { open: tickets.filter(ticket => ticket.status === 'open').length, archived: tickets.filter(ticket => ticket.status === 'archived').length },
    };
  }

  async listTickets(member) {
    if (!this.canManageTickets(member)) throw Error('No tienes permiso para administrar tickets');
    return this.dashboardState();
  }

  async manageTicket(channelId, action, member) {
    if (!this.canManageTickets(member)) throw Error('No tienes permiso para administrar tickets');
    if (action === 'claim') return this.claimTicket(channelId, member);
    if (action === 'archive') return this.archiveTicket(channelId, member);
    if (action === 'close') return this.closeTicket(channelId, member);
    if (action === 'reopen') return this.reopenTicket(channelId, member);
    throw Error('Acción de ticket no válida');
  }

  async transcript(channelId, member) {
    if (!this.canManageTickets(member)) throw Error('No tienes permiso para ver transcripciones');
    const ticket = await this.ticket(channelId);
    if (!ticket?.transcriptAvailable) return null;
    return this.storage.getBlob(`transcript:${channelId}.html`);
  }

  async archivedAttachmentUrl(channelId, attachmentId, member) {
    if (!this.canManageTickets(member)) throw Error('No tienes permiso para ver los adjuntos archivados');
    const ticket = await this.ticket(channelId);
    const record = ticket?.archivedAttachments?.find(item => item.sourceAttachmentId === attachmentId);
    if (!record) return null;
    const guild = await this.guild(), channel = await guild.channels.fetch(record.archiveChannelId).catch(() => null);
    const message = await channel?.messages?.fetch(record.archiveMessageId).catch(() => null);
    const attachment = message?.attachments?.get(record.archiveAttachmentId);
    if (!attachment?.url) return null;
    try {
      const url = new URL(attachment.url);
      return url.protocol === 'https:' && /(^|\.)discord(?:app)?\.(?:com|net)$/.test(url.hostname) ? url.href : null;
    } catch { return null; }
  }

  async onMessage(message) {
    if (this.closed || message.author?.bot || message.guildId !== this.guildId) return;
    const ticket = await this.ticket(message.channelId);
    if (!ticket || ticket.status !== 'open') return;
    ticket.lastActivityAt = new Date().toISOString();
    await this.saveTicket(ticket);
  }

  async onChannelDelete(channel) {
    const ticket = await this.ticket(channel.id);
    if (!ticket || ticket.status !== 'open') return;
    ticket.status = 'deleted'; ticket.closedAt = new Date().toISOString();
    await this.saveTicket(ticket);
  }

  async deferInteraction(interaction) {
    if (interaction.deferred || interaction.replied) {
      const age = Number.isFinite(interaction.createdTimestamp) ? `${Date.now() - interaction.createdTimestamp}ms` : 'edad desconocida';
      this.context.log(`Interacción de ticket ya confirmada antes del handler (${interaction.customId || 'sin id'}, ${age})`);
      return false;
    }
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return true;
    } catch (error) {
      if (error?.code === 10062 || error?.code === 40060) {
        const age = Number.isFinite(interaction.createdTimestamp) ? `${Date.now() - interaction.createdTimestamp}ms` : 'edad desconocida';
        this.context.log(`Interacción de ticket no disponible al responder (${error.code}, ${interaction.customId || 'sin id'}, ${age})`);
        return false;
      }
      throw error;
    }
  }

  async handleInteraction(interaction) {
    if (interaction.guildId !== this.guildId) return;
    const customId = interaction.customId || '';
    const selectCategory = interaction.isStringSelectMenu?.() && customId === 'tickets:create';
    const buttonCategory = interaction.isButton?.() && customId.startsWith('tickets:create:');
    if (!selectCategory && !buttonCategory && !interaction.isButton?.()) return;
    if (customId === 'tickets:cancel-close') return interaction.update({ content: 'El ticket sigue abierto.', components: [] });
    if (!customId.startsWith('tickets:')) return;
    if (!await this.deferInteraction(interaction)) return;
    if (selectCategory || buttonCategory) {
      if (interaction.message?.id !== this.config.panelMessageId) return interaction.editReply({ content: 'Este panel ya no está activo.' });
      const categoryKey = selectCategory ? interaction.values[0] : customId.slice('tickets:create:'.length);
      try {
        const result = await this.openTicket(interaction, categoryKey);
        await interaction.editReply({ content: `Tu ticket está listo: <#${result.channel.id}>` });
      } catch (error) { await interaction.editReply({ content: String(error.message || 'No se pudo crear el ticket').slice(0, 1800) }); }
      return;
    }
    const channelId = interaction.channelId;
    if (customId === 'tickets:close') {
      const ticket = await this.ticket(channelId);
      if (!ticket || ticket.status !== 'open') return interaction.editReply({ content: 'Este ticket ya no está abierto.' });
      if (interaction.user.id !== ticket.ownerId && !this.isSupport(interaction.member)) return interaction.editReply({ content: 'Solo el propietario o soporte puede cerrar este ticket.' });
      const confirm = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tickets:confirm-close').setLabel('Sí, cerrar').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tickets:cancel-close').setLabel('Seguir en el ticket').setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({ content: '¿Cerrar definitivamente? Se copiarán los adjuntos al canal 1569784973790281758 del servidor 1347720640882413659, se guardará la transcripción y después se eliminará este canal.', components: [confirm] });
    }
    if (customId === 'tickets:confirm-close') {
      try { await this.closeTicket(channelId, interaction.member); await interaction.editReply({ content: 'Ticket cerrado. La transcripción quedó disponible en el panel web.' }); }
      catch (error) { await interaction.editReply({ content: String(error.message || 'No se pudo cerrar').slice(0, 1800) }); }
      return;
    }
    if (customId === 'tickets:claim') {
      try { const ticket = await this.claimTicket(channelId, interaction.member); await interaction.editReply({ content: ticket.claimedById ? `Ticket asignado a ${ticket.claimedByName}.` : 'Ticket liberado para soporte.' }); }
      catch (error) { await interaction.editReply({ content: String(error.message || 'No se pudo actualizar el ticket').slice(0, 1800) }); }
      return;
    }
    if (customId === 'tickets:archive') {
      try { await this.archiveTicket(channelId, interaction.member); await interaction.editReply({ content: 'Ticket archivado.' }); }
      catch (error) { await interaction.editReply({ content: String(error.message || 'No se pudo archivar').slice(0, 1800) }); }
      return;
    }
    if (customId === 'tickets:reopen') {
      try { await this.reopenTicket(channelId, interaction.member); await interaction.editReply({ content: 'Ticket reabierto.' }); }
      catch (error) { await interaction.editReply({ content: String(error.message || 'No se pudo reabrir').slice(0, 1800) }); }
    }
  }

  async close() { this.closed = true; this.userLocks.clear(); }
}

module.exports = { TicketService, DEFAULT_CONFIG };
