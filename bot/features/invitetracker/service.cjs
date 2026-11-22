const {
  ChannelType, GatewayIntentBits, PermissionFlagsBits,
} = require('discord.js');

const SNOWFLAKE = /^[0-9]{17,20}$/;
const TEMPLATE_LIMIT = 1000;
const DEFAULT_CONFIG = Object.freeze({
  enabled: false, channelId: '', notifyJoins: true, notifyLeaves: true,
  joinMessage: '👋 {member} se unió al servidor. Invitó: {inviter}.',
  leaveMessage: '🚪 {member} salió del servidor. Lo había invitado: {inviter}.',
});
const clone = value => structuredClone(value);
const clean = (value, limit = TEMPLATE_LIMIT) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit);
const keyFor = (guildId, memberId) => `member:${guildId}:${memberId}`;

class InviteTrackerService {
  constructor(context) {
    this.context = context;
    this.client = context.client;
    this.storage = context.storage;
    this.adminRoleIds = new Set((context.adminRoleIds || []).map(String));
    if (context.dashboardRoleId) this.adminRoleIds.add(String(context.dashboardRoleId));
    this.configs = {};
    this.snapshots = new Map();
    this.statuses = new Map();
    this.queues = new Map();
    this.closed = false;
  }

  async initialize() {
    const saved = await this.storage.get('settings', {});
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [guildId, value] of Object.entries(saved)) {
        if (SNOWFLAKE.test(guildId) && value && typeof value === 'object' && !Array.isArray(value)) {
          try { this.configs[guildId] = this.normalizeConfig(value); } catch {}
        }
      }
    }
    return this;
  }

  normalizeConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Configuración de invitaciones inválida');
    if (typeof value.enabled !== 'boolean' || typeof value.notifyJoins !== 'boolean' || typeof value.notifyLeaves !== 'boolean') throw Error('Activa o desactiva las opciones de notificación');
    const channelId = String(value.channelId || '');
    if (channelId && !SNOWFLAKE.test(channelId)) throw Error('El canal seleccionado no es válido');
    const joinMessage = clean(value.joinMessage, TEMPLATE_LIMIT), leaveMessage = clean(value.leaveMessage, TEMPLATE_LIMIT);
    if (!joinMessage || !leaveMessage) throw Error('Completa los mensajes de entrada y salida');
    if (value.enabled && !channelId) throw Error('Selecciona el canal para los avisos antes de activar el seguimiento');
    return { enabled: value.enabled, channelId, notifyJoins: value.notifyJoins, notifyLeaves: value.notifyLeaves, joinMessage, leaveMessage };
  }

  config(guildId) { return clone(this.configs[guildId] || DEFAULT_CONFIG); }

  canManage(member) {
    if (!member) return false;
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    return [...this.adminRoleIds].some(id => member.roles?.cache?.has(id));
  }

  canFetchInvites(guild) {
    const permissions = guild.members.me?.permissions;
    return !!permissions && (permissions.has(PermissionFlagsBits.ManageGuild) || permissions.has(PermissionFlagsBits.ViewAuditLog));
  }

  hasIntent(intent) { return !!this.client.options?.intents?.has?.(intent); }

  capability(guild) {
    const me = guild.members.me;
    const channels = [...guild.channels.cache.values()].filter(Boolean);
    const inviteManageChannels = channels.filter(channel => {
      try { return !!me && channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels); } catch { return false; }
    }).length;
    return {
      canFetchInvites: this.canFetchInvites(guild),
      hasGuildMembersIntent: this.hasIntent(GatewayIntentBits.GuildMembers),
      hasGuildInvitesIntent: this.hasIntent(GatewayIntentBits.GuildInvites),
      inviteManageChannels,
      status: this.statuses.get(guild.id) || 'pending',
    };
  }

  async listGuilds() {
    return [...this.client.guilds.cache.values()].sort((a, b) => a.name.localeCompare(b.name)).map(guild => ({
      id: guild.id, name: guild.name, iconUrl: guild.iconURL({ extension: 'png', size: 96 }),
      config: this.config(guild.id), capability: this.capability(guild),
    }));
  }

  async guildState(guildId) {
    if (!SNOWFLAKE.test(String(guildId))) throw Error('Servidor no válido');
    const guild = this.client.guilds.cache.get(String(guildId));
    if (!guild) throw Error('El bot ya no está en ese servidor');
    await guild.channels.fetch().catch(() => null);
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const channels = [...guild.channels.cache.values()].filter(channel => channel
      && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
      && typeof channel.send === 'function'
      && (!me || channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel))
      && (!me || channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)))
      .sort((a, b) => (a.parent?.name || '').localeCompare(b.parent?.name || '') || a.name.localeCompare(b.name))
      .map(channel => ({ id: channel.id, name: channel.name, category: channel.parent?.name || '' }));
    return { guild: { id: guild.id, name: guild.name }, config: this.config(guild.id), channels, capability: this.capability(guild) };
  }

  async updateConfig(guildId, input) {
    if (!SNOWFLAKE.test(String(guildId))) throw Error('Servidor no válido');
    const guild = this.client.guilds.cache.get(String(guildId));
    if (!guild) throw Error('El bot ya no está en ese servidor');
    const next = this.normalizeConfig({ ...this.config(guildId), ...(input || {}) });
    if (next.channelId) {
      const channel = await guild.channels.fetch(next.channelId).catch(() => null);
      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      if (!channel || channel.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) || !channel.send) throw Error('El canal seleccionado no es un canal de texto disponible');
      const permissions = me && channel.permissionsFor(me);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages)) throw Error('El bot necesita ver el canal y poder enviar mensajes allí');
    }
    if (next.enabled) {
      if (!this.hasIntent(GatewayIntentBits.GuildMembers) || !this.hasIntent(GatewayIntentBits.GuildInvites)) throw Error('Faltan los intents Guild Members o Guild Invites en el bot');
      if (!this.canFetchInvites(guild)) throw Error('Para consultar invitaciones, el bot necesita «Administrar servidor» o «Ver registro de auditoría»');
      try { this.snapshots.set(guild.id, await this.fetchSnapshot(guild)); this.statuses.set(guild.id, 'ready'); }
      catch (error) { throw Error(`No se pudieron consultar las invitaciones (${error.code || error.name}). Revisa los permisos del bot.`); }
    }
    this.configs[guild.id] = next;
    await this.storage.set('settings', this.configs);
    return this.guildState(guild.id);
  }

  async fetchSnapshot(guild) {
    const invites = await guild.invites.fetch();
    const byCode = new Map();
    for (const invite of invites.values()) {
      if (!invite?.code || !Number.isFinite(invite.uses)) continue;
      byCode.set(invite.code, { uses: invite.uses, inviterId: invite.inviter?.id || '', inviterName: invite.inviter?.globalName || invite.inviter?.username || '' });
    }
    let vanityUses = null;
    if (guild.vanityURLCode && guild.members.me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
      try { vanityUses = (await guild.fetchVanityData()).uses ?? null; } catch {}
    }
    return { invites: byCode, vanityUses, fetchedAt: Date.now() };
  }

  async primeEnabledGuilds() {
    for (const [guildId, config] of Object.entries(this.configs)) {
      if (!config.enabled) continue;
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) { this.statuses.set(guildId, 'unavailable'); continue; }
      try {
        this.snapshots.set(guildId, await this.fetchSnapshot(guild));
        this.statuses.set(guildId, 'ready');
      } catch (error) {
        this.snapshots.delete(guildId); this.statuses.set(guildId, 'permission-error');
        this.context.log(`No se pudo preparar el seguimiento en ${guildId} (${error.code || error.name})`);
      }
    }
  }

  enqueue(guildId, task) {
    const previous = this.queues.get(guildId) || Promise.resolve();
    const current = previous.then(task, task);
    this.queues.set(guildId, current);
    return current.finally(() => { if (this.queues.get(guildId) === current) this.queues.delete(guildId); });
  }

  async onInviteCreate(invite) {
    const guildId = invite.guild?.id || invite.guildId;
    if (!guildId || !this.configs[guildId]?.enabled || !invite.code) return;
    const snapshot = this.snapshots.get(guildId);
    if (snapshot) snapshot.invites.set(invite.code, { uses: Number(invite.uses) || 0, inviterId: invite.inviter?.id || '', inviterName: invite.inviter?.globalName || invite.inviter?.username || '' });
  }

  async onInviteDelete(invite) {
    const guildId = invite.guild?.id || invite.guildId;
    this.snapshots.get(guildId)?.invites.delete(invite.code);
  }

  async identifyInvite(guild, member) {
    const previous = this.snapshots.get(guild.id);
    try {
      const current = await this.fetchSnapshot(guild);
      this.snapshots.set(guild.id, current); this.statuses.set(guild.id, 'ready');
      if (!previous) return { source: 'unknown', inviterId: '', inviterName: '', code: '', confidence: 'unattributed', reason: 'baseline' };
      const increased = [];
      for (const [code, invite] of current.invites) {
        const old = previous.invites.get(code);
        if (old && invite.uses > old.uses) increased.push({ code, delta: invite.uses - old.uses, ...invite });
        else if (!old && invite.uses > 0) increased.push({ code, delta: invite.uses, ...invite });
      }
      const vanityDelta = Number.isFinite(current.vanityUses) && Number.isFinite(previous.vanityUses)
        ? current.vanityUses - previous.vanityUses : 0;
      if (increased.length === 1 && increased[0].delta === 1 && vanityDelta <= 0) {
        const invite = increased[0];
        if (invite.inviterId && invite.inviterId !== member.id) return { source: 'invite', inviterId: invite.inviterId, inviterName: invite.inviterName, code: invite.code, confidence: 'confirmed', reason: '' };
        return { source: 'unknown', inviterId: '', inviterName: '', code: invite.code, confidence: 'unattributed', reason: 'missing-inviter' };
      }
      if (increased.length === 0 && vanityDelta === 1) return { source: 'vanity', inviterId: '', inviterName: '', code: guild.vanityURLCode || '', confidence: 'unattributed', reason: 'vanity' };
      const reason = increased.length || vanityDelta > 0 ? 'concurrent-uses' : 'no-use-change';
      return { source: 'unknown', inviterId: '', inviterName: '', code: '', confidence: 'unattributed', reason };
    } catch (error) {
      this.snapshots.delete(guild.id); this.statuses.set(guild.id, 'permission-error');
      this.context.log(`No se pudieron comprobar invitaciones para ${guild.id} (${error.code || error.name})`);
      return { source: 'unknown', inviterId: '', inviterName: '', code: '', confidence: 'unattributed', reason: 'fetch-error' };
    }
  }

  async onMemberAdd(member) {
    const guildId = member.guild.id;
    return this.enqueue(guildId, async () => {
      const config = this.config(guildId), key = keyFor(guildId, member.id);
      let record = await this.storage.get(key, null);
      const now = new Date().toISOString();
      if (record) {
        record.active = true; record.leftAt = null; record.lastJoinedAt = now; record.rejoins = (record.rejoins || 0) + 1;
        await this.storage.set(key, record);
      } else {
        if (!config.enabled) return;
        const attribution = await this.identifyInvite(member.guild, member);
        record = {
          guildId, memberId: member.id, displayName: clean(member.displayName || member.user.username, 100),
          username: clean(member.user.username, 100), isBot: member.user.bot === true,
          inviterId: attribution.inviterId, inviterName: attribution.inviterName, inviteCode: attribution.code,
          source: attribution.source, confidence: attribution.confidence, reason: attribution.reason,
          joinedAt: now, lastJoinedAt: now, leftAt: null, active: true, rejoins: 0,
        };
        await this.storage.set(key, record);
      }
      if (config.enabled && config.notifyJoins) await this.notify(member.guild, config, 'join', record);
    });
  }

  async onMemberRemove(member) {
    const guildId = member.guild.id;
    return this.enqueue(guildId, async () => {
      const config = this.config(guildId), key = keyFor(guildId, member.id), now = new Date().toISOString();
      let record = await this.storage.get(key, null);
      if (record) { record.active = false; record.leftAt = now; }
      else {
        if (!config.enabled) return;
        record = { guildId, memberId: member.id, displayName: clean(member.displayName || member.user.username, 100),
          username: clean(member.user.username, 100), isBot: member.user.bot === true, inviterId: '', inviterName: '', inviteCode: '',
          source: 'preexisting', confidence: 'unattributed', reason: 'tracking-started-after-join', joinedAt: member.joinedAt?.toISOString?.() || '',
          lastJoinedAt: member.joinedAt?.toISOString?.() || '', leftAt: now, active: false, rejoins: 0 };
      }
      await this.storage.set(key, record);
      if (config.enabled && config.notifyLeaves) await this.notify(member.guild, config, 'leave', record);
    });
  }

  async notify(guild, config, type, record) {
    if (!config.channelId) return;
    const template = type === 'join' ? config.joinMessage : config.leaveMessage;
    const inviter = record.inviterId ? `<@${record.inviterId}>` : record.source === 'vanity' ? 'enlace personalizado del servidor' : 'no identificado';
    const content = template.replace(/\{(member|inviter|code)\}/g, (_match, field) => ({ member: `<@${record.memberId}>`, inviter, code: record.inviteCode || '—' })[field]);
    try {
      const channel = await guild.channels.fetch(config.channelId).catch(() => null);
      if (!channel?.isTextBased?.() || channel.guildId !== guild.id || !channel.send) throw Error('canal no disponible');
      await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) { this.context.log(`No se pudo enviar el aviso de ${type} en ${guild.id} (${error.code || error.name})`); }
  }

  async listInvites(guildId, inviterId) {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw Error('El bot no está en ese servidor');
    const entries = await this.storage.entries();
    const records = entries.filter(([key, value]) => String(key).startsWith(`member:${guildId}:`) && value?.memberId)
      .map(([, value]) => value);
    const target = records.find(record => record.memberId === inviterId) || null;
    const invited = records.filter(record => record.inviterId === inviterId && !record.isBot)
      .sort((a, b) => String(b.joinedAt).localeCompare(String(a.joinedAt)));
    const targetMember = guild.members.cache.get(inviterId);
    return {
      guildName: guild.name, inviterId, inviterName: targetMember?.displayName || target?.displayName || '',
      inviterSource: target?.source || '', inviterById: target?.inviterId || '', inviterByName: target?.inviterName || '',
      total: invited.length, active: invited.filter(record => record.active).length,
      invitees: invited.slice(0, 10).map(record => ({ memberId: record.memberId, displayName: record.displayName, joinedAt: record.joinedAt, active: record.active })),
    };
  }

  async close() { this.closed = true; this.snapshots.clear(); this.statuses.clear(); this.queues.clear(); }
}

module.exports = { InviteTrackerService, DEFAULT_CONFIG };
