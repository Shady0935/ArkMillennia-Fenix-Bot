const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

const SNOWFLAKE = /^[0-9]{17,20}$/;
const BRAND_COLOR = 0x8f1d3d;
const VERIFY_PREFIX = 'millenniafenix:verify:';

const DEFAULT_CONFIG = Object.freeze({
  welcomeEnabled: false,
  welcomeChannelId: '',
  welcomeMessage: '¡Bienvenido/a {user} a **{server}**! Ya somos {count} miembros.',
  goodbyeEnabled: false,
  goodbyeChannelId: '',
  goodbyeMessage: '**{username}** dejó {server}. Ahora somos {count} miembros.',
  welcomeDmEnabled: false,
  welcomeDmMessage: '¡Hola {username}! Te damos la bienvenida a {server}.',
  autoRoleIds: [],
  verificationEnabled: false,
  verificationChannelId: '',
  verificationRoleId: '',
  verificationMessage: 'Pulsa el botón para confirmar que has leído las normas y obtener acceso.',
  verificationButtonText: 'Verificarme',
  verificationMessageId: '',
});

function text(value, name, max) {
  if (typeof value !== 'string' || value.length > max) throw Error(`${name} no puede superar ${max} caracteres`);
  return value.trim();
}

class WelcomeService {
  constructor(context) {
    this.context = context;
    this.client = context.client;
    this.storage = context.storage;
    this.guildId = context.guildId;
    this.config = { ...DEFAULT_CONFIG };
  }

  async initialize() {
    const saved = await this.storage.get('config', null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      this.config = { ...DEFAULT_CONFIG, ...saved };
      this.config.autoRoleIds = Array.isArray(saved.autoRoleIds) ? saved.autoRoleIds : [];
    }
    try { this.config = this.validate(this.config); }
    catch (error) {
      this.config = { ...DEFAULT_CONFIG };
      this.context.log(`La configuración de comunidad no era válida; se cargaron valores seguros (${error.message})`);
    }
    return this;
  }

  guild() {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw Error('El servidor principal no está disponible');
    return guild;
  }

  validate(input) {
    const config = {
      welcomeEnabled: input.welcomeEnabled === true,
      welcomeChannelId: String(input.welcomeChannelId || '').trim(),
      welcomeMessage: text(input.welcomeMessage ?? DEFAULT_CONFIG.welcomeMessage, 'El mensaje de bienvenida', 3000),
      goodbyeEnabled: input.goodbyeEnabled === true,
      goodbyeChannelId: String(input.goodbyeChannelId || '').trim(),
      goodbyeMessage: text(input.goodbyeMessage ?? DEFAULT_CONFIG.goodbyeMessage, 'El mensaje de despedida', 3000),
      welcomeDmEnabled: input.welcomeDmEnabled === true,
      welcomeDmMessage: text(input.welcomeDmMessage ?? DEFAULT_CONFIG.welcomeDmMessage, 'El mensaje privado', 1800),
      autoRoleIds: Array.isArray(input.autoRoleIds) ? [...new Set(input.autoRoleIds.map(value => String(value).trim()))] : [],
      verificationEnabled: input.verificationEnabled === true,
      verificationChannelId: String(input.verificationChannelId || '').trim(),
      verificationRoleId: String(input.verificationRoleId || '').trim(),
      verificationMessage: text(input.verificationMessage ?? DEFAULT_CONFIG.verificationMessage, 'El texto de verificación', 1800),
      verificationButtonText: text(input.verificationButtonText ?? DEFAULT_CONFIG.verificationButtonText, 'El botón de verificación', 80),
      verificationMessageId: String(input.verificationMessageId || '').trim(),
    };
    for (const [enabled, field, label] of [
      [config.welcomeEnabled, config.welcomeChannelId, 'Selecciona un canal de bienvenida'],
      [config.goodbyeEnabled, config.goodbyeChannelId, 'Selecciona un canal de despedida'],
    ]) if (enabled && !SNOWFLAKE.test(field)) throw Error(label);
    if (config.welcomeEnabled && !config.welcomeMessage) throw Error('Escribe el mensaje de bienvenida');
    if (config.goodbyeEnabled && !config.goodbyeMessage) throw Error('Escribe el mensaje de despedida');
    if (config.welcomeDmEnabled && !config.welcomeDmMessage) throw Error('Escribe el mensaje privado de bienvenida');
    if (config.autoRoleIds.length > 10 || config.autoRoleIds.some(id => !SNOWFLAKE.test(id))) throw Error('Selecciona hasta 10 roles automáticos válidos');
    if (config.verificationEnabled && (!SNOWFLAKE.test(config.verificationChannelId) || !SNOWFLAKE.test(config.verificationRoleId))) {
      throw Error('Selecciona el canal y el rol de verificación');
    }
    if (config.verificationMessageId && !SNOWFLAKE.test(config.verificationMessageId)) config.verificationMessageId = '';
    return config;
  }

  async resources() {
    const guild = this.guild();
    await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
    const me = guild.members.me ?? await guild.members.fetchMe();
    const channels = [...guild.channels.cache.values()]
      .filter(channel => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
      .map(channel => ({ id: channel.id, name: channel.name, category: channel.parent?.name || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const roles = [...guild.roles.cache.values()]
      .filter(role => role.id !== guild.id && !role.managed && role.position < me.roles.highest.position)
      .map(role => ({ id: role.id, name: role.name, color: role.hexColor, position: role.position }))
      .sort((a, b) => b.position - a.position);
    return { guildName: guild.name, channels, roles };
  }

  async save(input) {
    const config = this.validate(input);
    const guild = this.guild();
    const channelIds = [config.welcomeEnabled && config.welcomeChannelId, config.goodbyeEnabled && config.goodbyeChannelId,
      config.verificationEnabled && config.verificationChannelId].filter(Boolean);
    for (const id of channelIds) {
      const channel = await guild.channels.fetch(id);
      if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw Error('Selecciona un canal de texto del servidor principal');
    }
    const roleIds = [...config.autoRoleIds, ...(config.verificationEnabled ? [config.verificationRoleId] : [])];
    const me = guild.members.me ?? await guild.members.fetchMe();
    for (const id of roleIds) {
      const role = await guild.roles.fetch(id);
      if (!role || role.managed || role.position >= me.roles.highest.position) throw Error('El bot no puede administrar uno de los roles seleccionados');
    }
    this.config = { ...config, verificationMessageId: this.config.verificationMessageId };
    await this.storage.set('config', this.config);
    return structuredClone(this.config);
  }

  render(template, member) {
    return template
      .replaceAll('{user}', `<@${member.id}>`)
      .replaceAll('{username}', member.user.username)
      .replaceAll('{server}', member.guild.name)
      .replaceAll('{count}', String(member.guild.memberCount));
  }

  embed(description) {
    return new EmbedBuilder().setColor(BRAND_COLOR).setDescription(description.slice(0, 4000));
  }

  async sendToChannel(channelId, template, member) {
    const channel = await member.guild.channels.fetch(channelId);
    if (!channel?.isTextBased() || typeof channel.send !== 'function') throw Error('El canal configurado no está disponible');
    await channel.send({ embeds: [this.embed(this.render(template, member))], allowedMentions: { parse: [], users: [member.id] } });
  }

  async onMemberAdd(member) {
    if (member.guild.id !== this.guildId || member.user.bot) return;
    for (const roleId of this.config.autoRoleIds) {
      try { await member.roles.add(roleId, 'Rol automático de bienvenida'); }
      catch (error) { this.context.log(`No se pudo asignar un rol automático (${error.code || error.name})`); }
    }
    if (this.config.welcomeEnabled) {
      try { await this.sendToChannel(this.config.welcomeChannelId, this.config.welcomeMessage, member); }
      catch (error) { this.context.log(`No se pudo enviar la bienvenida (${error.code || error.name})`); }
    }
    if (this.config.welcomeDmEnabled && this.config.welcomeDmMessage) {
      try {
        await member.send({ embeds: [this.embed(this.render(this.config.welcomeDmMessage, member))], allowedMentions: { parse: [] } });
      } catch (error) { this.context.log(`No se pudo enviar el mensaje privado de bienvenida (${error.code || error.name})`); }
    }
  }

  async onMemberRemove(member) {
    if (member.guild.id !== this.guildId || !this.config.goodbyeEnabled) return;
    try { await this.sendToChannel(this.config.goodbyeChannelId, this.config.goodbyeMessage, member); }
    catch (error) { this.context.log(`No se pudo enviar la despedida (${error.code || error.name})`); }
  }

  async test(kind, userId) {
    if (!['welcome', 'goodbye'].includes(kind)) throw Error('Tipo de prueba no válido');
    const enabled = kind === 'welcome' ? this.config.welcomeEnabled : this.config.goodbyeEnabled;
    const channelId = kind === 'welcome' ? this.config.welcomeChannelId : this.config.goodbyeChannelId;
    const template = kind === 'welcome' ? this.config.welcomeMessage : this.config.goodbyeMessage;
    if (!enabled || !channelId) throw Error('Activa y guarda ese mensaje antes de probarlo');
    const member = await this.guild().members.fetch(userId);
    await this.sendToChannel(channelId, template, member);
    return { ok: true };
  }

  async setupVerification() {
    if (!this.config.verificationEnabled) throw Error('Activa y guarda la verificación antes de publicarla');
    const channel = await this.guild().channels.fetch(this.config.verificationChannelId);
    if (!channel?.isTextBased() || typeof channel.send !== 'function') throw Error('El canal de verificación no está disponible');
    const content = this.config.verificationMessage || DEFAULT_CONFIG.verificationMessage;
    const payload = {
      embeds: [this.embed(content)],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(VERIFY_PREFIX + this.guildId)
        .setLabel(this.config.verificationButtonText || DEFAULT_CONFIG.verificationButtonText)
        .setStyle(ButtonStyle.Primary))],
      allowedMentions: { parse: [] },
    };
    if (this.config.verificationMessageId) {
      try {
        const previous = await channel.messages.fetch(this.config.verificationMessageId);
        if (previous) {
          await previous.edit(payload);
          return { ok: true, updated: true };
        }
      } catch { /* The saved message may have been removed; create a fresh one below. */ }
    }
    const message = await channel.send(payload);
    this.config.verificationMessageId = message.id;
    await this.storage.set('config', this.config);
    return { ok: true, updated: false };
  }

  async onInteraction(interaction) {
    if (!interaction.isButton?.() || interaction.customId !== VERIFY_PREFIX + this.guildId || interaction.guildId !== this.guildId) return;
    if (!this.config.verificationEnabled || !this.config.verificationRoleId) {
      await interaction.reply({ content: 'La verificación no está disponible ahora.', flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const member = await this.guild().members.fetch(interaction.user.id);
      if (member.roles.cache.has(this.config.verificationRoleId)) {
        await interaction.reply({ content: 'Ya tienes acceso al servidor.', flags: MessageFlags.Ephemeral });
        return;
      }
      await member.roles.add(this.config.verificationRoleId, 'Verificación por botón');
      await interaction.reply({ content: 'Listo, ya tienes acceso al servidor.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.context.log(`No se pudo completar una verificación (${error.code || error.name})`);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'No se pudo completar la verificación. Avísale a un administrador.', flags: MessageFlags.Ephemeral });
      }
    }
  }
}

module.exports = { WelcomeService, DEFAULT_CONFIG, VERIFY_PREFIX };
