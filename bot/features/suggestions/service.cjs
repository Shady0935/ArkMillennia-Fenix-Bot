const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ContainerBuilder, PermissionFlagsBits,
  MessageFlags, ModalBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize,
  TextDisplayBuilder, TextInputBuilder, TextInputStyle, ThumbnailBuilder,
} = require('discord.js');

const SNOWFLAKE = /^[0-9]{17,20}$/;
const KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const VOTE_EMOJIS = Object.freeze({
  down: { id: '1572910826778656819', name: 'tickets_downvote' },
  up: { id: '1572910675951358032', name: 'tickets_upvote' },
  red: { id: '1572919531586855022', name: 'tickets_red' },
  separator: { id: '1572919369388794017', name: 'tickets_separator' },
  green: { id: '1572919465161658418', name: 'tickets_green' },
});
const BAR_SEGMENTS = 20;
const BAR_NEUTRAL_VOTES = 5;
const emojiTag = emoji => `<:${emoji.name}:${emoji.id}>`;
function voteBalanceBar(upvotes, downvotes) {
  const up = Math.max(0, Number(upvotes) || 0), down = Math.max(0, Number(downvotes) || 0);
  const total = up + down;
  const greenSegments = total === 0 ? BAR_SEGMENTS / 2
    : Math.round(((up + BAR_NEUTRAL_VOTES) / (total + BAR_NEUTRAL_VOTES * 2)) * BAR_SEGMENTS);
  const redSegments = BAR_SEGMENTS - greenSegments;
  return `${emojiTag(VOTE_EMOJIS.red).repeat(redSegments)}${emojiTag(VOTE_EMOJIS.separator)}${emojiTag(VOTE_EMOJIS.green).repeat(greenSegments)}`;
}
function votePercentages(upvotes, downvotes) {
  const up = Math.max(0, Number(upvotes) || 0), down = Math.max(0, Number(downvotes) || 0);
  const total = up + down;
  const upPercent = total === 0 ? 50 : Math.round(up / total * 100);
  return { up: upPercent, down: 100 - upPercent };
}
const DEFAULT_CONFIG = Object.freeze({
  enabled: false, channelId: '', panelChannelId: '', panelMessageId: '', panelDisplay: 'embed', suggestionDisplay: 'embed',
  showVoteBar: false,
  panelTitle: 'Buzón de sugerencias',
  panelDescription: 'Comparte tus ideas para mejorar ArkMillennia Fenix. El equipo revisará cada propuesta y la comunidad podrá votarla.',
  suggestionTitle: 'Nueva sugerencia', submitLabel: 'Enviar sugerencia', upLabel: 'A favor', downLabel: 'En contra',
  maxLength: 1000, pendingColor: '#8f1d3d', acceptedColor: '#57a773', deniedColor: '#d66b65',
  moderatorRoleIds: [],
});
const colors = value => /^#[0-9a-f]{6}$/i.test(String(value || ''));
const clone = value => structuredClone(value);
const safeText = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

class SuggestionsService {
  constructor(context) {
    this.context = context;
    this.client = context.client;
    this.storage = context.storage;
    this.guildId = String(context.guildId || '');
    this.adminRoleIds = new Set((context.adminRoleIds || []).map(String));
    if (context.dashboardRoleId) this.adminRoleIds.add(String(context.dashboardRoleId));
    this.config = clone(DEFAULT_CONFIG);
    this.publishedPanelDisplay = '';
    this.voteDisplayMigrationRequired = false;
    this.locks = new Map();
    this.closed = false;
  }

  async initialize() {
    const saved = await this.storage.get('config', null);
    if (saved) {
      this.publishedPanelDisplay = saved.publishedPanelDisplay || (saved.panelMessageId ? 'embed' : '');
      this.voteDisplayMigrationRequired = saved.voteDisplayVersion !== 2;
      this.config = this.normalizeConfig({ ...clone(DEFAULT_CONFIG), ...saved });
    } else await this.persistConfig();
    return this;
  }

  async persistConfig() {
    await this.storage.set('config', { ...this.config, publishedPanelDisplay: this.publishedPanelDisplay, voteDisplayVersion: 2 });
  }

  normalizeConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Configuración de sugerencias inválida');
    const id = key => { const item = String(value[key] || ''); if (item && !SNOWFLAKE.test(item)) throw Error(`ID de Discord inválido en ${key}`); return item; };
    if (typeof value.enabled !== 'boolean' || !['embed', 'components_v2'].includes(value.panelDisplay)
      || !['embed', 'components_v2'].includes(value.suggestionDisplay)) throw Error('Selecciona un formato válido para panel y sugerencias');
    if (value.showVoteBar !== undefined && typeof value.showVoteBar !== 'boolean') throw Error('La opción de barra de votos no es válida');
    const panelTitle = safeText(value.panelTitle, 100), panelDescription = safeText(value.panelDescription, 3500);
    const suggestionTitle = safeText(value.suggestionTitle, 100), submitLabel = safeText(value.submitLabel, 80);
    const upLabel = safeText(value.upLabel, 60), downLabel = safeText(value.downLabel, 60);
    if (!panelTitle || !panelDescription || !suggestionTitle || !submitLabel || !upLabel || !downLabel) throw Error('Completa los títulos, textos y etiquetas del módulo');
    if (!Number.isInteger(value.maxLength) || value.maxLength < 50 || value.maxLength > 3500) throw Error('El largo de sugerencia debe estar entre 50 y 3500 caracteres');
    if (![value.pendingColor, value.acceptedColor, value.deniedColor].every(colors)) throw Error('Usa colores hexadecimales válidos');
    if (!Array.isArray(value.moderatorRoleIds) || value.moderatorRoleIds.some(roleId => !SNOWFLAKE.test(String(roleId)))) throw Error('Selecciona roles de moderación válidos');
    const config = {
      enabled: value.enabled, channelId: id('channelId'), panelChannelId: id('panelChannelId'), panelMessageId: id('panelMessageId'),
      panelDisplay: value.panelDisplay, suggestionDisplay: value.suggestionDisplay, panelTitle, panelDescription,
      showVoteBar: value.showVoteBar === true,
      suggestionTitle, submitLabel, upLabel, downLabel, maxLength: value.maxLength,
      pendingColor: value.pendingColor.toLowerCase(), acceptedColor: value.acceptedColor.toLowerCase(), deniedColor: value.deniedColor.toLowerCase(),
      moderatorRoleIds: [...new Set(value.moderatorRoleIds.map(String))],
    };
    if (config.enabled && !config.channelId) throw Error('Selecciona el canal donde se publicarán las sugerencias');
    return config;
  }

  async guild() { return this.client.guilds.cache.get(this.guildId) || await this.client.guilds.fetch(this.guildId); }
  hasRole(member, id) { return !!id && !!member?.roles?.cache?.has(id); }
  canManage(member) {
    if (!member) return false;
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return [...this.adminRoleIds, ...this.config.moderatorRoleIds].some(id => this.hasRole(member, id));
  }
  canAccess(member) { return this.canManage(member); }

  async validateChannel(id, label, guild) {
    if (!id) return null;
    const channel = await guild.channels.fetch(id).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || typeof channel.send !== 'function') {
      throw Error(`El canal para ${label} no es un canal de texto válido`);
    }
    return channel;
  }

  async updateConfig(input) {
    const oldPanelChannelId = this.config.panelChannelId;
    const oldShowVoteBar = this.config.showVoteBar;
    const next = this.normalizeConfig({ ...this.config, ...(input || {}), panelMessageId: this.config.panelMessageId });
    const guild = await this.guild();
    await this.validateChannel(next.channelId, 'publicar sugerencias', guild);
    await this.validateChannel(next.panelChannelId, 'el panel', guild);
    for (const roleId of next.moderatorRoleIds) if (!await guild.roles.fetch(roleId).catch(() => null)) throw Error('Uno de los roles de moderación ya no existe');
    if (next.panelChannelId !== oldPanelChannelId) {
      if (oldPanelChannelId && this.config.panelMessageId) {
        const oldChannel = await guild.channels.fetch(oldPanelChannelId).catch(() => null);
        const oldMessage = await oldChannel?.messages?.fetch(this.config.panelMessageId).catch(() => null);
        if (oldMessage) await oldMessage.delete().catch(error => this.context.log(`No se pudo retirar el panel anterior (${error.code || error.name})`));
      }
      next.panelMessageId = '';
    }
    this.config = next;
    await this.persistConfig();
    if (next.showVoteBar !== oldShowVoteBar) {
      this.refreshSuggestionMessages().catch(error => this.context.log(`No se pudieron actualizar las barras de sugerencias: ${error.code || error.name}`));
    }
    let panelUpdated = null;
    if (next.panelChannelId && next.panelMessageId) {
      try { panelUpdated = await this.syncPanel(); }
      catch (error) { this.context.log(`No se pudo sincronizar el panel de sugerencias: ${error.code || error.name}`); panelUpdated = false; }
    }
    return { ...await this.dashboardState(), panelUpdated };
  }

  async allRecords() {
    const entries = await this.storage.entries();
    return entries.filter(([key, value]) => String(key).startsWith('suggestion:') && value?.id)
      .map(([, value]) => value);
  }

  async refreshSuggestionMessages() {
    if (!this.client.isReady()) return { updated: 0, failed: 0 };
    const records = await this.allRecords();
    let updated = 0, failed = 0;
    for (const record of records) {
      try {
        const counts = await this.counts(record.id);
        await this.updateSuggestionMessage({ ...record, ...counts });
        updated++;
      } catch (error) {
        failed++;
        this.context.log(`No se pudo actualizar la sugerencia ${record.id} (${error.code || error.name})`);
      }
    }
    await this.persistConfig();
    this.voteDisplayMigrationRequired = false;
    return { updated, failed };
  }

  async allVotes(suggestionId) {
    const prefix = `vote:${suggestionId}:`;
    return (await this.storage.entries()).filter(([key, value]) => String(key).startsWith(prefix) && value?.type)
      .map(([, value]) => value);
  }

  async counts(suggestionId) {
    const votes = await this.allVotes(suggestionId);
    return { upvotes: votes.filter(vote => vote.type === 'up').length, downvotes: votes.filter(vote => vote.type === 'down').length };
  }

  async panelPayload() {
    const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('suggestions:open')
      .setLabel(this.config.submitLabel).setStyle(ButtonStyle.Primary).setEmoji('💡'));
    if (this.config.panelDisplay === 'embed') {
      const embed = await this.context.services.get('embeds').create({ title: this.config.panelTitle, description: this.config.panelDescription, color: Number.parseInt(this.config.pendingColor.slice(1), 16), timestamp: false });
      return { embeds: [embed], components: [buttons], allowedMentions: { parse: [] } };
    }
    const card = new ContainerBuilder().setAccentColor(Number.parseInt(this.config.pendingColor.slice(1), 16))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${this.config.panelTitle}\n${this.config.panelDescription}`))
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addActionRowComponents(buttons);
    return { flags: MessageFlags.IsComponentsV2, components: [card], allowedMentions: { parse: [] } };
  }

  async publishPanel() {
    if (!this.config.panelChannelId) throw Error('Selecciona un canal para el panel antes de publicarlo');
    const guild = await this.guild(), channel = await this.validateChannel(this.config.panelChannelId, 'el panel', guild);
    let message = null;
    if (this.config.panelMessageId) message = await channel.messages.fetch(this.config.panelMessageId).catch(() => null);
    if (message && this.publishedPanelDisplay && this.publishedPanelDisplay !== this.config.panelDisplay) {
      await message.delete().catch(() => {}); message = null;
    }
    const payload = await this.panelPayload();
    if (message) await message.edit({ ...payload, attachments: [] });
    else message = await channel.send(payload);
    this.config.panelMessageId = message.id;
    this.publishedPanelDisplay = this.config.panelDisplay;
    await this.persistConfig();
    return { panelMessageId: message.id, url: message.url };
  }

  async syncPanel() {
    const guild = await this.guild(), channel = await this.validateChannel(this.config.panelChannelId, 'el panel', guild);
    if (!channel || !this.config.panelMessageId) return null;
    const message = await channel.messages.fetch(this.config.panelMessageId).catch(() => null);
    if (!message) { this.config.panelMessageId = ''; await this.persistConfig(); return false; }
    if (this.publishedPanelDisplay && this.publishedPanelDisplay !== this.config.panelDisplay) {
      await message.delete(); this.config.panelMessageId = ''; await this.persistConfig();
      return this.publishPanel().then(() => true);
    }
    await message.edit({ ...await this.panelPayload(), attachments: [] });
    this.publishedPanelDisplay = this.config.panelDisplay;
    await this.persistConfig();
    return true;
  }

  suggestionButtons(suggestion) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`suggestions:vote:up:${suggestion.id}`).setLabel(`${this.config.upLabel} · ${suggestion.upvotes || 0}`).setEmoji(VOTE_EMOJIS.up).setStyle(ButtonStyle.Success).setDisabled(suggestion.status !== 'pending'),
      new ButtonBuilder().setCustomId(`suggestions:vote:down:${suggestion.id}`).setLabel(`${this.config.downLabel} · ${suggestion.downvotes || 0}`).setEmoji(VOTE_EMOJIS.down).setStyle(ButtonStyle.Danger).setDisabled(suggestion.status !== 'pending'),
    );
  }

  async suggestionPayload(suggestion) {
    const colorsByStatus = { pending: this.config.pendingColor, accepted: this.config.acceptedColor, denied: this.config.deniedColor };
    const color = Number.parseInt((colorsByStatus[suggestion.status] || this.config.pendingColor).slice(1), 16);
    const statusLabel = suggestion.status === 'accepted' ? 'Aceptada' : suggestion.status === 'denied' ? 'Denegada' : 'Pendiente';
    const row = this.suggestionButtons(suggestion);
    const percentages = votePercentages(suggestion.upvotes, suggestion.downvotes);
    if (suggestion.displayStyle === 'components_v2') {
      const card = new ContainerBuilder().setAccentColor(color)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${this.config.suggestionTitle}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(suggestion.content))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${statusLabel} · ID ${suggestion.id} · <@${suggestion.authorId}>`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${this.config.upLabel}:** ${suggestion.upvotes || 0} · **${this.config.downLabel}:** ${suggestion.downvotes || 0}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Porcentaje:** ${percentages.up}% a favor · ${percentages.down}% en contra`));
      if (this.config.showVoteBar) card.addTextDisplayComponents(new TextDisplayBuilder().setContent(voteBalanceBar(suggestion.upvotes, suggestion.downvotes)));
      card
        .addActionRowComponents(row);
      if (suggestion.status !== 'pending') card.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Estado: ${statusLabel}**${suggestion.reason ? `\n**Motivo:** ${suggestion.reason}` : ''}`));
      return { flags: MessageFlags.IsComponentsV2, components: [card], allowedMentions: { parse: [] } };
    }
    const embed = await this.context.services.get('embeds').create({ title: this.config.suggestionTitle, description: suggestion.content, color, timestamp: true });
    embed.addFields(
      { name: this.config.upLabel, value: `**${suggestion.upvotes || 0}**`, inline: true },
      { name: this.config.downLabel, value: `**${suggestion.downvotes || 0}**`, inline: true },
      { name: 'Estado', value: statusLabel, inline: true },
      { name: 'Porcentaje de votos', value: `**${percentages.up}%** a favor · **${percentages.down}%** en contra`, inline: false },
    );
    if (this.config.showVoteBar) embed.addFields({ name: 'Balance de votos · en contra ← a favor', value: voteBalanceBar(suggestion.upvotes, suggestion.downvotes), inline: false });
    embed.setFooter({ text: `ID ${suggestion.id} · Por ${suggestion.authorName}${suggestion.reason ? ` · ${suggestion.reason}` : ''}` });
    return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
  }

  async postSuggestion(interaction, rawContent) {
    if (!this.config.enabled) throw Error('El módulo de sugerencias está desactivado');
    const content = safeText(rawContent, this.config.maxLength);
    if (content.length < 5) throw Error('La sugerencia debe tener al menos 5 caracteres');
    const blocked = await this.storage.get(`blacklist:${interaction.user.id}`, null);
    if (blocked) throw Error(`No puedes publicar sugerencias. Motivo: ${blocked.reason || 'sin especificar'}`);
    const guild = await this.guild(), channel = await this.validateChannel(this.config.channelId, 'publicar sugerencias', guild);
    const suggestion = {
      id: require('node:crypto').randomUUID().replaceAll('-', '').slice(0, 20), guildId: guild.id, channelId: channel.id,
      authorId: interaction.user.id, authorName: interaction.user.globalName || interaction.user.username,
      content, status: 'pending', reason: '', upvotes: 0, downvotes: 0,
      displayStyle: this.config.suggestionDisplay, createdAt: new Date().toISOString(), messageId: '',
    };
    await this.storage.set(`suggestion:${suggestion.id}`, suggestion);
    try {
      const message = await channel.send({ ...await this.suggestionPayload(suggestion), allowedMentions: { parse: [] } });
      suggestion.messageId = message.id;
      await this.storage.set(`suggestion:${suggestion.id}`, suggestion);
      return suggestion;
    } catch (error) {
      await this.storage.delete(`suggestion:${suggestion.id}`).catch(() => {});
      throw Error(`No se pudo publicar la sugerencia (${error.code || error.name})`);
    }
  }

  async withLock(key, task) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release; const current = new Promise(resolve => { release = resolve; });
    this.locks.set(key, current); await previous.catch(() => {});
    try { return await task(); }
    finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }

  async handleVote(interaction, suggestionId, type) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await this.withLock(`vote:${suggestionId}`, async () => {
        const suggestion = await this.storage.get(`suggestion:${suggestionId}`, null);
        if (!suggestion || suggestion.guildId !== interaction.guildId) throw Error('La sugerencia ya no existe');
        if (suggestion.status !== 'pending') throw Error('La votación de esta sugerencia ya terminó');
        const voteKey = `vote:${suggestionId}:${interaction.user.id}`;
        const previous = await this.storage.get(voteKey, null);
        if (previous?.type === type) return { duplicate: true };
        await this.storage.set(voteKey, { type, createdAt: new Date().toISOString() });
        const counts = await this.counts(suggestionId);
        Object.assign(suggestion, counts);
        await this.storage.set(`suggestion:${suggestionId}`, suggestion);
        return { suggestion, changed: !!previous };
      });
      if (result.duplicate) return interaction.editReply({ content: 'Ya registraste ese voto. Puedes cambiarlo usando el otro botón.' });
      await this.updateSuggestionMessage(result.suggestion);
      await interaction.editReply({ content: result.changed ? 'Tu voto cambió.' : 'Tu voto quedó registrado.' });
    } catch (error) { await interaction.editReply({ content: String(error.message || 'No se pudo registrar tu voto').slice(0, 1500) }); }
  }

  async updateSuggestionMessage(suggestion) {
    const guild = await this.guild(), channel = await guild.channels.fetch(suggestion.channelId).catch(() => null);
    const message = await channel?.messages?.fetch(suggestion.messageId).catch(() => null);
    if (!message) throw Error('La sugerencia está guardada, pero el mensaje ya no existe en Discord');
    await message.edit({ ...await this.suggestionPayload(suggestion), allowedMentions: { parse: [] } });
  }

  async moderate(id, status, actor, reason = '') {
    if (!this.canManage(actor)) throw Error('No tienes permiso para moderar sugerencias');
    if (!['accepted', 'denied'].includes(status)) throw Error('El estado elegido no es válido');
    const suggestion = await this.storage.get(`suggestion:${id}`, null);
    if (!suggestion) throw Error('No se encontró esa sugerencia');
    suggestion.status = status; suggestion.reason = status === 'denied' ? safeText(reason, 300) : '';
    suggestion.moderatedBy = actor.id; suggestion.moderatedAt = new Date().toISOString();
    const counts = await this.counts(id); Object.assign(suggestion, counts);
    const previous = await this.storage.get(`suggestion:${id}`, null);
    try { await this.updateSuggestionMessage(suggestion); }
    catch (error) { await this.storage.set(`suggestion:${id}`, previous); throw error; }
    await this.storage.set(`suggestion:${id}`, suggestion);
    return suggestion;
  }

  async deleteSuggestion(id, actor) {
    if (!this.canManage(actor)) throw Error('No tienes permiso para eliminar sugerencias');
    if (!/^[a-f0-9]{20}$/.test(String(id))) throw Error('El ID de la sugerencia no es válido');
    return this.withLock(`vote:${id}`, async () => {
      const suggestion = await this.storage.get(`suggestion:${id}`, null);
      if (!suggestion || suggestion.guildId !== this.guildId) throw Error('No se encontró esa sugerencia');
      let messageDeleted = false;
      if (suggestion.channelId && suggestion.messageId) {
        let channel;
        try { channel = await this.client.channels.fetch(suggestion.channelId); }
        catch (error) {
          if (Number(error?.code) !== 10003) throw Error(`No se pudo comprobar el mensaje en Discord (${error.code || error.name}); el registro se conservó.`);
        }
        if (channel && channel.guildId !== suggestion.guildId) throw Error('El mensaje pertenece a otro servidor; el registro se conservó.');
        if (channel) {
          let message;
          try { message = await channel.messages.fetch(suggestion.messageId); }
          catch (error) {
            if (Number(error?.code) !== 10008) throw Error(`No se pudo comprobar el mensaje en Discord (${error.code || error.name}); el registro se conservó.`);
          }
          if (message) {
            try { await message.delete(); messageDeleted = true; }
            catch (error) {
              if (Number(error?.code) !== 10008) throw Error(`No se pudo borrar el mensaje de Discord (${error.code || error.name}); el registro se conservó.`);
            }
          }
        }
      }
      const keys = (await this.storage.entries())
        .map(([key]) => String(key))
        .filter(key => key === `suggestion:${id}` || key.startsWith(`vote:${id}:`));
      for (const key of keys) await this.storage.delete(key);
      return { ok: true, messageDeleted, votesDeleted: keys.length - 1 };
    });
  }

  async blacklistAdd(userId, reason, actor) {
    if (!this.canManage(actor)) throw Error('No tienes permiso para administrar la lista de bloqueo');
    if (!SNOWFLAKE.test(String(userId))) throw Error('Selecciona un usuario válido');
    const guild = await this.guild();
    const user = await this.client.users.fetch(String(userId)).catch(() => null);
    if (!user) throw Error('No se encontró ese usuario');
    const record = { userId: String(userId), username: user.globalName || user.username, reason: safeText(reason, 300), addedBy: actor.id, addedAt: new Date().toISOString() };
    await this.storage.set(`blacklist:${userId}`, record);
    return record;
  }

  async blacklistRemove(userId, actor) {
    if (!this.canManage(actor)) throw Error('No tienes permiso para administrar la lista de bloqueo');
    if (!SNOWFLAKE.test(String(userId))) throw Error('Selecciona un usuario válido');
    return this.storage.delete(`blacklist:${userId}`);
  }

  async dashboardState() {
    const guild = await this.guild();
    await Promise.all([guild.roles.fetch().catch(() => null), guild.channels.fetch().catch(() => null)]);
    const entries = await this.storage.entries();
    const votes = new Map();
    for (const [key, vote] of entries) {
      const match = String(key).match(/^vote:([^:]+):/);
      if (!match || !vote?.type) continue;
      const tally = votes.get(match[1]) || { upvotes: 0, downvotes: 0 };
      if (vote.type === 'up') tally.upvotes++; else if (vote.type === 'down') tally.downvotes++;
      votes.set(match[1], tally);
    }
    const suggestions = entries.filter(([key, value]) => String(key).startsWith('suggestion:') && value?.id)
      .map(([, value]) => ({ ...value, ...(votes.get(value.id) || { upvotes: 0, downvotes: 0 }) }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 200);
    const blacklist = entries.filter(([key, value]) => String(key).startsWith('blacklist:') && value?.userId).map(([, value]) => value);
    return {
      config: clone(this.config), guild: { id: guild.id, name: guild.name },
      channels: [...guild.channels.cache.values()].filter(channel => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)).map(channel => ({ id: channel.id, name: channel.name })),
      roles: [...guild.roles.cache.values()].filter(role => role.id !== guild.id).sort((a, b) => b.position - a.position).map(role => ({ id: role.id, name: role.name })),
      suggestions, blacklist, counts: { pending: suggestions.filter(item => item.status === 'pending').length, accepted: suggestions.filter(item => item.status === 'accepted').length, denied: suggestions.filter(item => item.status === 'denied').length },
    };
  }

  async manageApi(member, id, status, reason) { return this.moderate(id, status, member, reason); }

  async handleInteraction(interaction) {
    if (interaction.guildId !== this.guildId) return;
    if (interaction.isChatInputCommand?.() && interaction.commandName === 'sugerir') {
      if (!this.config.enabled) return interaction.reply({ content: 'El sistema de sugerencias está desactivado.', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId('suggestions:submit').setTitle('Enviar sugerencia');
      const field = new TextInputBuilder().setCustomId('content').setLabel('¿Qué te gustaría proponer?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(5).setMaxLength(this.config.maxLength);
      modal.addComponents(new ActionRowBuilder().addComponents(field));
      return interaction.showModal(modal);
    }
    if (interaction.isButton?.() && interaction.customId === 'suggestions:open') {
      if (!this.config.enabled) return interaction.reply({ content: 'El sistema de sugerencias está desactivado.', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId('suggestions:submit').setTitle('Enviar sugerencia');
      const field = new TextInputBuilder().setCustomId('content').setLabel('¿Qué te gustaría proponer?').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(5).setMaxLength(this.config.maxLength);
      modal.addComponents(new ActionRowBuilder().addComponents(field));
      return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit?.() && interaction.customId === 'suggestions:submit') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try { const suggestion = await this.postSuggestion(interaction, interaction.fields.getTextInputValue('content')); await interaction.editReply({ content: `Sugerencia publicada. ID: ${suggestion.id}` }); }
      catch (error) { await interaction.editReply({ content: String(error.message || 'No se pudo publicar').slice(0, 1500) }); }
      return;
    }
    if (interaction.isButton?.()) {
      const vote = interaction.customId.match(/^suggestions:vote:(up|down):([a-f0-9]{20})$/);
      if (vote) return this.handleVote(interaction, vote[2], vote[1]);
    }
  }

  async close() { this.closed = true; this.locks.clear(); }
}

module.exports = { SuggestionsService, DEFAULT_CONFIG };
