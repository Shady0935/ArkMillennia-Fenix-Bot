const { Events } = require('discord.js');
const { DiscordLogsService } = require('../features/logs/service.cjs');
const { createRouter } = require('../features/logs/http.cjs');

module.exports = {
  version: '1.0.0',
  async setup(context) {
    const service = await new DiscordLogsService(context).initialize();
    const router = createRouter(service);
    context.provide('logs', service);
    context.provide('dashboard:logs', {
      title: 'Registros de Discord',
      description: 'Configura registros de actividad para cada servidor conectado al bot',
      icon: 'history', order: 40, client: 'dashboard.js', styles: ['dashboard.css'],
      canAccess: member => context.dashboardRoleIds.some(roleId => member?.roles?.cache?.has(roleId)),
      http: (req, res, next) => router(req, res, next),
    });

    context.on(Events.MessageDelete, message => service.onMessageDelete(message));
    context.on(Events.MessageUpdate, (before, after) => service.onMessageUpdate(before, after));
    context.on(Events.MessageBulkDelete, (messages, channel) => service.onMessageBulkDelete(messages, channel));

    context.on(Events.GuildMemberAdd, member => service.onMemberAdd(member));
    context.on(Events.GuildMemberRemove, member => service.onMemberRemove(member));
    context.on(Events.GuildMemberUpdate, (before, after) => service.onMemberUpdate(before, after));
    context.on(Events.GuildBanAdd, ban => service.onBan(ban, true));
    context.on(Events.GuildBanRemove, ban => service.onBan(ban, false));
    context.on(Events.GuildAuditLogEntryCreate, (entry, guild) => service.onAuditEntry(entry, guild));

    context.on(Events.VoiceStateUpdate, (before, after) => service.onVoiceUpdate(before, after));
    context.on(Events.ChannelCreate, channel => service.onChannelCreate(channel));
    context.on(Events.ChannelDelete, channel => service.onChannelDelete(channel));
    context.on(Events.ChannelUpdate, (before, after) => service.onChannelUpdate(before, after));
    context.on(Events.ThreadCreate, thread => service.onChannelCreate(thread));
    context.on(Events.ThreadDelete, thread => service.onChannelDelete(thread));
    context.on(Events.ThreadUpdate, (before, after) => service.onChannelUpdate(before, after));

    context.on(Events.GuildRoleCreate, role => service.onRoleCreate(role));
    context.on(Events.GuildRoleDelete, role => service.onRoleDelete(role));
    context.on(Events.GuildRoleUpdate, (before, after) => service.onRoleUpdate(before, after));

    context.on(Events.InviteCreate, invite => service.onInviteCreate(invite));
    context.on(Events.InviteDelete, invite => service.onInviteDelete(invite));
    context.on(Events.GuildEmojiCreate, emoji => service.onEmojiCreate(emoji));
    context.on(Events.GuildEmojiDelete, emoji => service.onEmojiDelete(emoji));
    context.on(Events.GuildEmojiUpdate, (before, after) => service.onEmojiUpdate(before, after));
    context.on(Events.GuildStickerCreate, sticker => service.onStickerCreate(sticker));
    context.on(Events.GuildStickerDelete, sticker => service.onStickerDelete(sticker));
    context.on(Events.GuildStickerUpdate, (before, after) => service.onStickerUpdate(before, after));
    context.on(Events.WebhooksUpdate, channel => service.onWebhookUpdate(channel));
    context.on(Events.GuildIntegrationsUpdate, guild => service.record('community', guild, 'Integraciones actualizadas', [
      { label: 'Servidor', value: guild.name },
    ]));
    context.on(Events.GuildUpdate, (before, after) => service.onGuildUpdate(before, after));
    context.on(Events.GuildScheduledEventCreate, event => service.record('community', event.guild, 'Evento programado creado', [
      { label: 'Evento', value: event.name }, { label: 'Inicio', value: event.scheduledStartAt?.toISOString() || 'Sin fecha' },
      { label: 'Canal', value: event.channelId ? `<#${event.channelId}>` : 'Sin canal' },
    ]));
    context.on(Events.GuildScheduledEventDelete, event => service.record('community', event.guild, 'Evento programado eliminado', [
      { label: 'Evento', value: event.name }, { label: 'ID', value: event.id },
    ]));
    context.on(Events.GuildScheduledEventUpdate, (before, after) => service.record('community', after.guild, 'Evento programado actualizado', [
      { label: 'Evento', value: `${before.name} → ${after.name}` },
      { label: 'Inicio', value: `${before.scheduledStartAt?.toISOString() || 'Sin fecha'} → ${after.scheduledStartAt?.toISOString() || 'Sin fecha'}` },
    ]));
    context.on(Events.GuildScheduledEventUserAdd, (event, userId) => service.record('community', event.guild, 'Miembro se registró en un evento', [
      { label: 'Evento', value: event.name }, { label: 'Miembro', value: `<@${userId}> · ${userId}` },
    ]));
    context.on(Events.GuildScheduledEventUserRemove, (event, userId) => service.record('community', event.guild, 'Miembro se retiró de un evento', [
      { label: 'Evento', value: event.name }, { label: 'Miembro', value: `<@${userId}> · ${userId}` },
    ]));

    context.on(Events.GuildSoundboardSoundCreate, sound => service.record('community', sound.guild, 'Sonido de tablero añadido', [
      { label: 'Sonido', value: sound.name }, { label: 'ID', value: sound.soundId },
    ]));
    context.on(Events.GuildSoundboardSoundDelete, sound => service.record('community', sound.guild, 'Sonido de tablero eliminado', [
      { label: 'Sonido', value: sound.name }, { label: 'ID', value: sound.soundId },
    ]));
    context.on(Events.GuildSoundboardSoundUpdate, (_before, after) => service.record('community', after.guild, 'Sonido de tablero actualizado', [
      { label: 'Sonido', value: after.name }, { label: 'ID', value: after.soundId },
    ]));

    context.on(Events.MessageReactionAdd, (reaction, user) => service.onReaction(reaction, user, true));
    context.on(Events.MessageReactionRemove, (reaction, user) => service.onReaction(reaction, user, false));
    context.on(Events.MessageReactionRemoveAll, message => service.onReactionClear(message));
    context.on(Events.MessageReactionRemoveEmoji, reaction => service.onReactionClear(reaction.message, reaction.emoji));

    context.on(Events.AutoModerationActionExecution, execution => service.onAutomod(execution));
    context.on(Events.AutoModerationRuleCreate, rule => service.onAutomodRule(rule, 'creada'));
    context.on(Events.AutoModerationRuleDelete, rule => service.onAutomodRule(rule, 'eliminada'));
    context.on(Events.AutoModerationRuleUpdate, (_before, after) => service.onAutomodRule(after, 'actualizada'));
    context.onClose(() => service.close());
  },
};
