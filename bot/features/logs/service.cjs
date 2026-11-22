const {
  AuditLogEvent, ChannelType, ContainerBuilder, MessageFlags, PermissionFlagsBits,
  SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder, escapeMarkdown,
} = require('discord.js');

const CATEGORIES = Object.freeze({
  messages: { label: 'Mensajes', description: 'Mensajes editados, eliminados y limpiezas masivas.', color: 0x8f1d3d },
  members: { label: 'Miembros', description: 'Entradas, salidas, apodos y cambios de rangos.', color: 0x57a773 },
  moderation: { label: 'Moderación', description: 'Baneos, expulsiones, podas y acciones de moderación.', color: 0xed8b42 },
  voice: { label: 'Canales de voz', description: 'Entradas, salidas, movimientos y cambios de estado.', color: 0x8b78d1 },
  channels: { label: 'Canales e hilos', description: 'Creación, eliminación y cambios de canales e hilos.', color: 0x4c9bd6 },
  roles: { label: 'Rangos', description: 'Creación, eliminación y cambios de rangos.', color: 0x87513b },
  community: { label: 'Servidor y comunidad', description: 'Invitaciones, emojis, stickers, webhooks y datos del servidor.', color: 0x45a99a },
  reactions: { label: 'Reacciones', description: 'Reacciones añadidas, retiradas y limpiezas.', color: 0xb178c7 },
  automod: { label: 'AutoMod', description: 'Reglas y acciones automáticas de moderación.', color: 0xe35d6a },
});

const SNOWFLAKE = /^[0-9]{17,20}$/;
const EMPTY_CONFIG = () => ({ enabled: false, categories: Object.fromEntries(Object.keys(CATEGORIES).map(id => [id, { enabled: false, channelId: '' }])) });
const clean = value => escapeMarkdown(String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 1800));
const labelValue = (label, value) => ({ label, value: String(value ?? '').trim() || '—' });
const userMention = user => user?.id ? `<@${user.id}> · \`${user.id}\`` : 'Usuario no disponible';
const avatarUrl = user => user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null;
const when = value => value ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '—';
const channelMention = channel => channel?.id ? `<#${channel.id}>` : 'Sin canal';

class DiscordLogsService {
  constructor(context) {
    this.context = context;
    this.client = context.client;
    this.storage = context.storage;
    this.settings = {};
    this.queues = new Map();
  }

  async initialize() {
    const saved = await this.storage.get('settings', {});
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return this;
    for (const [guildId, value] of Object.entries(saved)) {
      if (!SNOWFLAKE.test(guildId) || !value || typeof value !== 'object') continue;
      const config = EMPTY_CONFIG();
      config.enabled = value.enabled === true;
      for (const id of Object.keys(CATEGORIES)) {
        const item = value.categories?.[id];
        if (!item || typeof item !== 'object') continue;
        config.categories[id] = { enabled: item.enabled === true, channelId: SNOWFLAKE.test(String(item.channelId || '')) ? String(item.channelId) : '' };
      }
      this.settings[guildId] = config;
    }
    return this;
  }

  getConfig(guildId) {
    return structuredClone(this.settings[guildId] || EMPTY_CONFIG());
  }

  async writableChannels(guild) {
    let channels = guild.channels.cache;
    try { channels = await guild.channels.fetch(); } catch {}
    let me = guild.members.me;
    if (!me) { try { me = await guild.members.fetchMe(); } catch {} }
    return [...(channels?.values?.() || [])]
      .filter(channel => channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) && typeof channel.send === 'function')
      .filter(channel => {
        if (!me) return false;
        const permissions = channel.permissionsFor(me);
        return permissions?.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.SendMessages);
      })
      .sort((a, b) => (a.parent?.name || '').localeCompare(b.parent?.name || '') || a.name.localeCompare(b.name))
      .map(channel => ({ id: channel.id, name: channel.name, category: channel.parent?.name || '' }));
  }

  async listGuilds() {
    const guilds = [...this.client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name));
    return Promise.all(guilds.map(async guild => ({
      id: guild.id,
      name: guild.name,
      iconUrl: guild.iconURL({ extension: 'png', size: 128 }),
      channels: await this.writableChannels(guild),
      canViewAuditLog: !!guild.members.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog),
    })));
  }

  async updateConfig(guildId, input) {
    if (!SNOWFLAKE.test(guildId) || !this.client.guilds.cache.has(guildId)) throw Error('Servidor no disponible para este bot');
    if (!input || typeof input !== 'object' || typeof input.enabled !== 'boolean' || !input.categories || typeof input.categories !== 'object') throw Error('Configuración inválida');
    const allowedKeys = Object.keys(CATEGORIES);
    if (Object.keys(input.categories).some(key => !allowedKeys.includes(key))) throw Error('Categoría de registros inválida');
    const guild = this.client.guilds.cache.get(guildId), channels = new Set((await this.writableChannels(guild)).map(channel => channel.id));
    const config = EMPTY_CONFIG(); config.enabled = input.enabled;
    for (const id of allowedKeys) {
      const item = input.categories[id];
      if (!item || typeof item.enabled !== 'boolean' || typeof item.channelId !== 'string') throw Error(`Configuración inválida para ${CATEGORIES[id].label}`);
      const channelId = item.channelId.trim();
      if (channelId && !channels.has(channelId)) throw Error(`El canal seleccionado para ${CATEGORIES[id].label} no está disponible o el bot no puede escribir allí`);
      if (config.enabled && item.enabled && !channelId) throw Error(`Selecciona un canal para ${CATEGORIES[id].label}`);
      config.categories[id] = { enabled: item.enabled, channelId };
    }
    this.settings[guildId] = config;
    await this.storage.set('settings', this.settings);
    return this.getConfig(guildId);
  }

  async record(category, guild, title, details = [], user = null) {
    if (!guild?.id || !CATEGORIES[category]) return;
    const config = this.settings[guild.id];
    const selected = config?.categories?.[category];
    if (!config?.enabled || !selected?.enabled || !selected.channelId) return;
    let channel = guild.channels.cache.get(selected.channelId);
    if (!channel) { try { channel = await guild.channels.fetch(selected.channelId); } catch {} }
    if (!channel || channel.guildId !== guild.id) return;
    const safeTitle = clean(title).slice(0, 180);
    const section = new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## ${safeTitle}\n**${clean(guild.name)}** · <t:${Math.floor(Date.now() / 1000)}:F>`,
    ));
    const thumbnail = avatarUrl(user);
    if (thumbnail) section.setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail));
    const body = details.map(item => `**${clean(item.label)}**\n${clean(item.value)}`).join('\n\n').slice(0, 3500) || 'Sin detalles adicionales.';
    const container = new ContainerBuilder().setAccentColor(CATEGORIES[category].color)
      .addSectionComponents(section)
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    const payload = { flags: MessageFlags.IsComponentsV2, components: [container], allowedMentions: { parse: [] } };
    const queue = this.queues.get(channel.id) || { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= 100) { this.context.log(`[logs] Cola llena en servidor ${guild.id}; registro omitido`); return; }
    queue.pending++;
    this.queues.set(channel.id, queue);
    const operation = queue.tail.then(() => channel.send(payload));
    queue.tail = operation.catch(error => { this.context.log(`[logs] Discord rechazó un registro (${error.code || error.name})`); });
    try { await operation; }
    finally { queue.pending--; if (!queue.pending) this.queues.delete(channel.id); }
  }

  async onMessageDelete(message) {
    if (message.partial) { try { await message.fetch(); } catch {} }
    const user = message.author;
    if (user?.bot) return;
    const attachments = [...(message.attachments?.values?.() || [])].map(file => file.url).filter(url => /^https:\/\//.test(url));
    const details = [labelValue('Autor', userMention(user)), labelValue('Canal', channelMention(message.channel)),
      labelValue('Mensaje', message.content || 'El contenido no estaba disponible en caché'),
      labelValue('Enlace', message.url || `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`)];
    if (attachments.length) details.push(labelValue('Adjuntos', attachments.join('\n')));
    return this.record('messages', message.guild, 'Mensaje eliminado', details, user);
  }

  async onMessageUpdate(before, after) {
    if (before.partial) { try { await before.fetch(); } catch {} }
    if (after.partial) { try { await after.fetch(); } catch {} }
    if (after.author?.bot) return;
    const oldContent = before.content || '';
    const newContent = after.content || '';
    if (oldContent === newContent) return;
    const details = [labelValue('Autor', userMention(after.author)), labelValue('Canal', channelMention(after.channel)),
      labelValue('Antes', oldContent || 'Sin contenido disponible'), labelValue('Después', newContent || 'Sin contenido disponible'),
      labelValue('Enlace', after.url)];
    return this.record('messages', after.guild, 'Mensaje editado', details, after.author);
  }

  onMessageBulkDelete(messages, channel) {
    const first = messages.first?.();
    return this.record('messages', channel?.guild || first?.guild, 'Mensajes eliminados en bloque', [
      labelValue('Cantidad', String(messages.size || messages.length || 0)), labelValue('Canal', channelMention(channel || first?.channel)),
    ]);
  }

  onMemberAdd(member) {
    return this.record('members', member.guild, 'Miembro se unió', [labelValue('Miembro', userMention(member.user)),
      labelValue('Cuenta creada', when(member.user.createdAt)), labelValue('Miembros en el servidor', String(member.guild.memberCount))], member.user);
  }

  onMemberRemove(member) {
    return this.record('members', member.guild, 'Miembro salió', [labelValue('Miembro', userMention(member.user)),
      labelValue('Rangos que tenía', [...(member.roles?.cache?.values?.() || [])].filter(role => role.id !== member.guild.id).map(role => role.name).join(', '))], member.user);
  }

  onMemberUpdate(before, after) {
    const changes = [];
    let timeoutChange = null;
    if (before.nickname !== after.nickname) changes.push(labelValue('Apodo', `${before.nickname || before.user.username} → ${after.nickname || after.user.username}`));
    if (before.user.username !== after.user.username || before.user.globalName !== after.user.globalName) {
      changes.push(labelValue('Nombre de usuario', `${before.user.globalName || before.user.username} → ${after.user.globalName || after.user.username}`));
    }
    const oldRoles = new Set([...before.roles.cache.keys()].filter(id => id !== before.guild.id));
    const newRoles = new Set([...after.roles.cache.keys()].filter(id => id !== after.guild.id));
    const added = [...newRoles].filter(id => !oldRoles.has(id)).map(id => after.guild.roles.cache.get(id)?.name || id);
    const removed = [...oldRoles].filter(id => !newRoles.has(id)).map(id => before.guild.roles.cache.get(id)?.name || id);
    if (added.length || removed.length) changes.push(labelValue('Rangos', `${added.length ? `Añadidos: ${added.join(', ')}` : ''}${added.length && removed.length ? ' · ' : ''}${removed.length ? `Retirados: ${removed.join(', ')}` : ''}`));
    if (before.communicationDisabledUntilTimestamp !== after.communicationDisabledUntilTimestamp) {
      timeoutChange = labelValue('Tiempo de espera', after.communicationDisabledUntilTimestamp ? `Hasta ${when(after.communicationDisabledUntilTimestamp)}` : 'Finalizado o retirado');
    }
    const member = labelValue('Miembro', userMention(after.user));
    const operations = [];
    if (changes.length) operations.push(this.record('members', after.guild, 'Perfil de miembro actualizado', [member, ...changes], after.user));
    if (timeoutChange) operations.push(this.record('moderation', after.guild, 'Tiempo de espera actualizado', [member, timeoutChange], after.user));
    return Promise.all(operations);
  }

  onBan(ban, added) {
    return this.record('moderation', ban.guild, added ? 'Miembro baneado' : 'Baneo retirado', [
      labelValue('Miembro', userMention(ban.user)), labelValue('Razón', ban.reason || 'No indicada'),
    ], ban.user);
  }

  onAuditEntry(entry, guild) {
    const action = entry.action;
    if (![AuditLogEvent.MemberKick, AuditLogEvent.MemberPrune].includes(action)) return;
    const target = entry.target;
    return this.record('moderation', guild, action === AuditLogEvent.MemberKick ? 'Miembro expulsado' : 'Limpieza de miembros', [
      labelValue('Objetivo', userMention(target)), labelValue('Responsable', userMention(entry.executor)),
      labelValue('Razón', entry.reason || 'No indicada'), labelValue('Fecha', when(entry.createdAt)),
    ], entry.executor);
  }

  onVoiceUpdate(before, after) {
    const guild = after.guild || before.guild;
    const member = after.member || before.member;
    if (member?.user?.bot) return;
    const oldId = before.channelId, newId = after.channelId;
    let title;
    if (!oldId && newId) title = 'Entró al canal de voz';
    else if (oldId && !newId) title = 'Salió del canal de voz';
    else if (oldId !== newId) title = 'Cambió de canal de voz';
    else title = 'Estado de voz actualizado';
    const changes = [labelValue('Miembro', userMention(member?.user)),
      ...(oldId !== newId ? [labelValue('Canal anterior', oldId ? `<#${oldId}>` : 'Ninguno'), labelValue('Canal nuevo', newId ? `<#${newId}>` : 'Ninguno')] : []),
      ...(before.serverMute !== after.serverMute ? [labelValue('Silencio del servidor', after.serverMute ? 'Activado' : 'Desactivado')] : []),
      ...(before.serverDeaf !== after.serverDeaf ? [labelValue('Sordera del servidor', after.serverDeaf ? 'Activada' : 'Desactivada')] : []),
      ...(before.selfMute !== after.selfMute ? [labelValue('Silencio propio', after.selfMute ? 'Activado' : 'Desactivado')] : []),
      ...(before.selfDeaf !== after.selfDeaf ? [labelValue('Sordera propia', after.selfDeaf ? 'Activada' : 'Desactivada')] : []),
      ...(before.streaming !== after.streaming ? [labelValue('Transmisión', after.streaming ? 'Iniciada' : 'Finalizada')] : []),
      ...(before.selfVideo !== after.selfVideo ? [labelValue('Cámara', after.selfVideo ? 'Activada' : 'Desactivada')] : []),
    ];
    return this.record('voice', guild, title, changes, member?.user);
  }

  onChannelCreate(channel) { return this.record('channels', channel.guild, 'Canal creado', [labelValue('Canal', channelMention(channel)), labelValue('Nombre', channel.name), labelValue('Tipo', channel.type)]); }
  onChannelDelete(channel) { return this.record('channels', channel.guild, 'Canal eliminado', [labelValue('Nombre', channel.name), labelValue('ID', channel.id), labelValue('Tipo', channel.type)]); }
  onChannelUpdate(before, after) {
    const changes = [];
    if (before.name !== after.name) changes.push(labelValue('Nombre', `${before.name} → ${after.name}`));
    if (before.parentId !== after.parentId) changes.push(labelValue('Categoría', `${before.parent?.name || 'Sin categoría'} → ${after.parent?.name || 'Sin categoría'}`));
    if (before.topic !== after.topic) changes.push(labelValue('Tema', `${before.topic || 'Vacío'} → ${after.topic || 'Vacío'}`));
    if (before.nsfw !== after.nsfw) changes.push(labelValue('Contenido restringido', after.nsfw ? 'Activado' : 'Desactivado'));
    if (before.rateLimitPerUser !== after.rateLimitPerUser) changes.push(labelValue('Modo lento', `${before.rateLimitPerUser || 0}s → ${after.rateLimitPerUser || 0}s`));
    if (before.archived !== after.archived) changes.push(labelValue('Archivado', after.archived ? 'Sí' : 'No'));
    if (before.locked !== after.locked) changes.push(labelValue('Bloqueado', after.locked ? 'Sí' : 'No'));
    const oldOverwrites = [...(before.permissionOverwrites?.cache?.values?.() || [])]
      .map(item => `${item.id}:${item.type}:${item.allow.bitfield}:${item.deny.bitfield}`).sort().join('|');
    const newOverwrites = [...(after.permissionOverwrites?.cache?.values?.() || [])]
      .map(item => `${item.id}:${item.type}:${item.allow.bitfield}:${item.deny.bitfield}`).sort().join('|');
    if (oldOverwrites !== newOverwrites) changes.push(labelValue('Permisos', 'Se actualizaron los permisos del canal'));
    if (!changes.length) return;
    return this.record('channels', after.guild, 'Canal actualizado', [labelValue('Canal', channelMention(after)), ...changes]);
  }

  onRoleCreate(role) { return this.record('roles', role.guild, 'Rango creado', [labelValue('Rango', role.name), labelValue('Color', role.hexColor), labelValue('ID', role.id)]); }
  onRoleDelete(role) { return this.record('roles', role.guild, 'Rango eliminado', [labelValue('Rango', role.name), labelValue('ID', role.id)]); }
  onRoleUpdate(before, after) {
    const changes = [];
    if (before.name !== after.name) changes.push(labelValue('Nombre', `${before.name} → ${after.name}`));
    if (before.hexColor !== after.hexColor) changes.push(labelValue('Color', `${before.hexColor} → ${after.hexColor}`));
    if (before.hoist !== after.hoist) changes.push(labelValue('Separado en la lista', after.hoist ? 'Sí' : 'No'));
    if (before.mentionable !== after.mentionable) changes.push(labelValue('Mencionable', after.mentionable ? 'Sí' : 'No'));
    if (before.permissions.bitfield !== after.permissions.bitfield) changes.push(labelValue('Permisos', 'Se actualizaron los permisos del rango'));
    if (!changes.length) return;
    return this.record('roles', after.guild, 'Rango actualizado', [labelValue('Rango', after.name), ...changes]);
  }

  onInviteCreate(invite) { return this.record('community', invite.guild, 'Invitación creada', [labelValue('Código', invite.code), labelValue('Canal', channelMention(invite.channel)), labelValue('Creador', userMention(invite.inviter)), labelValue('Usos máximos', invite.maxUses || 'Sin límite'), labelValue('Caduca', when(invite.expiresAt))], invite.inviter); }
  onInviteDelete(invite) { return this.record('community', invite.guild, 'Invitación eliminada', [labelValue('Código', invite.code), labelValue('Canal', channelMention(invite.channel))]); }
  onEmojiCreate(emoji) { return this.record('community', emoji.guild, 'Emoji añadido', [labelValue('Emoji', `${emoji} · ${emoji.name}`), labelValue('ID', emoji.id)]); }
  onEmojiDelete(emoji) { return this.record('community', emoji.guild, 'Emoji eliminado', [labelValue('Emoji', emoji.name), labelValue('ID', emoji.id)]); }
  onEmojiUpdate(before, after) { return this.record('community', after.guild, 'Emoji actualizado', [labelValue('Nombre', `${before.name} → ${after.name}`), labelValue('ID', after.id)]); }
  onStickerCreate(sticker) { return this.record('community', sticker.guild, 'Sticker añadido', [labelValue('Sticker', sticker.name), labelValue('ID', sticker.id)]); }
  onStickerDelete(sticker) { return this.record('community', sticker.guild, 'Sticker eliminado', [labelValue('Sticker', sticker.name), labelValue('ID', sticker.id)]); }
  onStickerUpdate(before, after) { return this.record('community', after.guild, 'Sticker actualizado', [labelValue('Nombre', `${before.name} → ${after.name}`), labelValue('ID', after.id)]); }
  onWebhookUpdate(channel) { return this.record('community', channel.guild, 'Webhooks actualizados', [labelValue('Canal', channelMention(channel)), labelValue('Nombre', channel.name)]); }
  onGuildUpdate(before, after) {
    const changes = [];
    if (before.name !== after.name) changes.push(labelValue('Nombre', `${before.name} → ${after.name}`));
    if (before.vanityURLCode !== after.vanityURLCode) changes.push(labelValue('Enlace personalizado', `${before.vanityURLCode || 'Ninguno'} → ${after.vanityURLCode || 'Ninguno'}`));
    if (before.description !== after.description) changes.push(labelValue('Descripción', `${before.description || 'Vacía'} → ${after.description || 'Vacía'}`));
    if (before.verificationLevel !== after.verificationLevel) changes.push(labelValue('Verificación', `${before.verificationLevel} → ${after.verificationLevel}`));
    if (!changes.length && before.icon !== after.icon) changes.push(labelValue('Icono', 'Se actualizó el icono del servidor'));
    if (!changes.length) return;
    return this.record('community', after, 'Servidor actualizado', changes);
  }

  onReaction(reaction, user, added) {
    if (user.bot) return;
    if (reaction.message.partial) { /* The reaction metadata remains useful even when the message is not cached. */ }
    return this.record('reactions', reaction.message.guild, added ? 'Reacción añadida' : 'Reacción retirada', [
      labelValue('Miembro', userMention(user)), labelValue('Canal', channelMention(reaction.message.channel)),
      labelValue('Emoji', reaction.emoji.toString()), labelValue('Mensaje', `https://discord.com/channels/${reaction.message.guildId}/${reaction.message.channelId}/${reaction.message.id}`),
    ], user);
  }

  onReactionClear(message, emoji = null) {
    return this.record('reactions', message.guild, emoji ? 'Reacciones de emoji retiradas' : 'Todas las reacciones retiradas', [
      labelValue('Canal', channelMention(message.channel)), labelValue('Emoji', emoji?.toString() || 'Todos'),
      labelValue('Mensaje', `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`),
    ]);
  }

  onAutomod(execution) {
    const user = execution.user;
    return this.record('automod', execution.guild, 'AutoMod ejecutó una acción', [
      labelValue('Miembro', userMention(user)), labelValue('Regla', execution.ruleName || execution.ruleId),
      labelValue('Acción', execution.action?.type ?? 'Acción automática'), labelValue('Canal', channelMention(execution.channel)),
      labelValue('Contenido coincidente', execution.content || 'No disponible'),
    ], user);
  }

  onAutomodRule(rule, action) {
    return this.record('automod', rule.guild, `Regla de AutoMod ${action}`, [labelValue('Regla', rule.name), labelValue('ID', rule.id)]);
  }

  async close() { this.queues.clear(); }
}

module.exports = { DiscordLogsService, CATEGORIES };
