const express = require('express');
const { PermissionFlagsBits } = require('discord.js');

const SNOWFLAKE = /^[0-9]{17,20}$/;
const MAX_QUERY = 100;

class RoleManagerService {
  constructor(context) {
    this.client = context.client;
    this.guildId = String(context.guildId || '').trim();
    if (!SNOWFLAKE.test(this.guildId)) throw Error('Configura DISCORD_GUILD_ID para el Discord del bot');
  }

  allowedGuild(id) {
    const guildId = String(id || '').trim();
    if (guildId && guildId !== this.guildId) throw Error('Este módulo solo opera en el Discord configurado');
    return this.guildId;
  }

  async guild(id) {
    const guildId = this.allowedGuild(id);
    return this.client.guilds.cache.get(guildId) ?? await this.client.guilds.fetch(guildId);
  }

  async botMember(guild) {
    return guild.members.me ?? await guild.members.fetchMe();
  }

  canManageRole(role, guild, bot) {
    return !!role && role.guild.id === guild.id && role.id !== guild.id && !role.managed
      && bot.permissions.has(PermissionFlagsBits.ManageRoles)
      && role.position < (bot.roles.highest?.position ?? -1);
  }

  color(role) {
    const raw = Number(role.colors?.primaryColor ?? role.color ?? 0);
    if (!Number.isSafeInteger(raw) || raw <= 0) return null;
    return `#${raw.toString(16).padStart(6, '0').slice(-6)}`;
  }

  async guilds() {
    const guild = await this.guild(this.guildId);
    return [{ id: guild.id, name: guild.name, kind: 'current', label: 'Discord conectado' }];
  }

  memberSummary(member) {
    return {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName || member.user.globalName || member.user.username,
      avatarUrl: member.displayAvatarURL({ size: 64 }),
      roleCount: member.roles.cache.filter(role => role.id !== member.guild.id).size,
    };
  }

  async searchMembers(guildId, rawQuery) {
    const guild = await this.guild(guildId);
    const query = String(rawQuery || '').trim().slice(0, MAX_QUERY);
    if (query.length < 2) throw Error('Escribe al menos dos caracteres para buscar');
    let members;
    if (SNOWFLAKE.test(query)) {
      const member = await guild.members.fetch({ user: query, force: true }).catch(error => error.code === 10007 ? null : Promise.reject(error));
      members = member ? [member] : [];
    } else {
      const found = await guild.members.search({ query, limit: 25 });
      members = [...found.values()];
    }
    return members.filter(member => !member.user.bot).slice(0, 25).map(member => this.memberSummary(member));
  }

  async getMember(guildId, userId) {
    const guild = await this.guild(guildId);
    if (!SNOWFLAKE.test(String(userId || ''))) throw Error('Selecciona un usuario válido');
    const [member, bot] = await Promise.all([
      guild.members.fetch({ user: String(userId), force: true }).catch(error => error.code === 10007 ? null : Promise.reject(error)),
      this.botMember(guild),
    ]);
    if (!member) throw Error('Ese usuario no pertenece a este servidor');
    await guild.roles.fetch();
    const canManage = bot.permissions.has(PermissionFlagsBits.ManageRoles);
    const roles = [...guild.roles.cache.values()]
      .filter(role => this.canManageRole(role, guild, bot))
      .sort((a, b) => b.position - a.position)
      .map(role => {
        return {
          id: role.id, name: role.name, color: this.color(role), position: role.position,
          assigned: member.roles.cache.has(role.id), editable: true,
        };
      });
    return {
      guildId: guild.id, guildName: guild.name, canManageRoles: canManage,
      member: this.memberSummary(member), roles,
    };
  }

  async setRole(guildId, userId, roleId, assigned, actorId) {
    const guild = await this.guild(guildId);
    if (!SNOWFLAKE.test(String(userId || '')) || !SNOWFLAKE.test(String(roleId || '')) || typeof assigned !== 'boolean') {
      throw Error('La solicitud de rango no es válida');
    }
    const bot = await this.botMember(guild);
    if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) throw Error('El bot necesita el permiso Administrar rangos en este servidor');
    const [member, role] = await Promise.all([
      guild.members.fetch({ user: String(userId), force: true }).catch(error => error.code === 10007 ? null : Promise.reject(error)),
      guild.roles.fetch(String(roleId)),
    ]);
    if (!member) throw Error('Ese usuario no pertenece a este servidor');
    if (!role || role.id === guild.id || role.managed) throw Error('Ese rango no se puede administrar');
    if (role.position >= (bot.roles.highest?.position ?? -1)) throw Error('El bot no puede administrar un rango que está a su mismo nivel o por encima');
    const hasRole = member.roles.cache.has(role.id);
    if (hasRole !== assigned) {
      const reason = `Millennia Fenix Bot dashboard · administrador ${SNOWFLAKE.test(String(actorId || '')) ? actorId : 'autorizado'}`;
      if (assigned) await member.roles.add(role, reason);
      else await member.roles.remove(role, reason);
    }
    return this.getMember(guild.id, member.id);
  }

  router() {
    const router = express.Router();
    router.use(express.json({ limit: '8kb' }));
    router.get('/api/guilds', async (req, res, next) => { try { res.json(await this.guilds()); } catch (error) { next(error); } });
    router.get('/api/members', async (req, res, next) => {
      try { res.json(await this.searchMembers(req.query.guildId, req.query.q)); } catch (error) { next(error); }
    });
    router.get('/api/member', async (req, res, next) => {
      try { res.json(await this.getMember(req.query.guildId, req.query.userId)); } catch (error) { next(error); }
    });
    router.put('/api/member-role', async (req, res, next) => {
      try {
        res.json(await this.setRole(req.body?.guildId, req.body?.userId, req.body?.roleId, req.body?.assigned, req.session.user?.id));
      } catch (error) { next(error); }
    });
    router.get('/dashboard.js', (req, res) => res.sendFile(require('node:path').join(__dirname, 'public', 'dashboard.js')));
    router.get('/dashboard.css', (req, res) => res.sendFile(require('node:path').join(__dirname, 'public', 'dashboard.css')));
    router.use((error, req, res, next) => {
      if (res.headersSent) return next(error);
      const status = error.code === 10007 || error.code === 10004 ? 404 : error.code === 50013 ? 403 : 400;
      res.status(status).json({ error: String(error.message || 'No se pudo completar la solicitud').slice(0, 220) });
    });
    return router;
  }
}

module.exports = { RoleManagerService };

