const crypto = require('node:crypto');
const express = require('express');
const { PermissionFlagsBits } = require('discord.js');
const { readEnvironment } = require('../../runtime/environment.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('hex');
const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

class LauncherService {
  constructor(context, options = {}) {
    this.context = context; this.pending = new Map(); this.attempts = new Map();
    this.now = options.now ?? Date.now;
    this.storage = context.storage; this.sessions = {};
    const env = options.environment ?? readEnvironment();
    this.guildId = String(context.guildId || '').trim();
    if (!/^[0-9]{17,20}$/.test(this.guildId)) throw Error('Configura DISCORD_GUILD_ID para el Discord del bot');
    this.roles = (env.LAUNCHER_STAFF_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (this.roles.some(id => !/^[0-9]{17,20}$/.test(id))) throw Error('LAUNCHER_STAFF_ROLE_IDS contiene un ID inválido');
    // Explicit roles replace the fallback. No dashboard permission is granted here.
    if (!this.roles.length) this.roles = [...context.adminRoleIds];
    const router = this.router();
    // Express exposes a route method named "bind". Keep a plain function at the
    // module boundary so the service proxy can bind it without registering a route.
    this.http = (req, res, next) => router(req, res, next);
  }
  async initialize() {
    this.sessions = await this.storage.get('sessions', {});
    if (!this.sessions || Array.isArray(this.sessions) || typeof this.sessions !== 'object') throw Error('Sesiones del launcher inválidas');
    await this.cleanup();
    return this;
  }
  async cleanup() {
    for (const [id, item] of this.pending) if (item.expires <= this.now()) this.pending.delete(id);
    for (const [id, item] of this.attempts) if (item.until <= this.now()) this.attempts.delete(id);
    let changed = false;
    for (const [id, item] of Object.entries(this.sessions)) if (item.expires <= this.now()) { delete this.sessions[id]; changed = true; }
    if (changed) await this.storage.set('sessions', this.sessions);
  }
  async profile(id, username) {
    if (!this.context.client.isReady()) throw Error('Discord no está disponible');
    const guild = this.context.client.guilds.cache.get(this.guildId) ?? await this.context.client.guilds.fetch(this.guildId);
    if (!guild) throw Error('Servidor Discord no disponible');
    let member;
    try { member = await guild.members.fetch({ user: id, force: true }); }
    catch (error) { if (error.code === 10007) return { username, staff: false }; throw error; }
    const staff = this.roles.length ? this.roles.some(role => member.roles.cache.has(role))
      : id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
    return { username: String(username).slice(0, 100), staff };
  }
  beginBrowser(id) { const item = this.pending.get(id); return !!item && !item.result && item.expires > this.now(); }
  async complete(id, user) {
    if (!this.beginBrowser(id) || !/^[0-9]{17,20}$/.test(user.id)) throw Error('Vinculación caducada');
    const profile = await this.profile(user.id, user.username);
    // Recheck after the Discord request: concurrent callbacks must never issue two sessions.
    if (!this.beginBrowser(id)) throw Error('Vinculación caducada');
    if (Object.keys(this.sessions).length >= 1000) throw Error('Demasiadas sesiones');
    const token = random(), expires = this.now() + 30 * 86400000;
    this.sessions[hash(token)] = { id: user.id, username: profile.username, expires };
    try { await this.storage.set('sessions', this.sessions); }
    catch (error) { delete this.sessions[hash(token)]; throw error; }
    this.pending.get(id).result = { token, expires, ...profile };
  }
  router() {
    const router = express.Router();
    router.use(express.json({ limit: '2kb' }));
    router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.get('/health', (req, res) => res.status(this.context.client.isReady() ? 200 : 503).json({ ready: this.context.client.isReady() }));
    router.post('/link', async (req, res) => {
      await this.cleanup();
      if (!this.context.client.isReady()) return res.sendStatus(503);
      const key = req.ip, rate = this.attempts.get(key) ?? { count: 0, until: this.now() + 60000 };
      if (++rate.count > 10 || this.attempts.size >= 1000 && !this.attempts.has(key) || this.pending.size >= 1000) return res.sendStatus(429);
      this.attempts.set(key, rate);
      if (!valid(req.body?.challenge)) return res.sendStatus(400);
      const id = random(); this.pending.set(id, { challenge: req.body.challenge, expires: this.now() + 300000 });
      res.json({ id, expiresIn: 300, authorizationPath: '/launcher/authorize?id=' + id });
    });
    router.get('/authorize', (req, res) => {
      if (!valid(req.query.id) || !this.beginBrowser(req.query.id)) return res.status(410).send('La vinculación ha caducado. Vuelve al launcher.');
      req.session.launcherTicket = req.query.id;
      req.session.save(error => error ? res.sendStatus(500) : res.redirect('/auth/discord'));
    });
    router.post('/poll', async (req, res) => {
      await this.cleanup(); const item = this.pending.get(req.body?.id), secret = req.get('Authorization')?.replace(/^Bearer /, '');
      if (!valid(secret) || !item || item.challenge !== hash(secret)) return res.sendStatus(410);
      if (!item.result) return res.status(202).json({ pending: true });
      this.pending.delete(req.body.id); res.json(item.result);
    });
    router.use((req, res, next) => {
      const token = req.get('Authorization')?.replace(/^Bearer /, '');
      const item = valid(token) ? this.sessions[hash(token)] : null;
      if (!item || item.expires <= this.now()) return res.sendStatus(401);
      req.launcherSession = item; req.launcherTokenHash = hash(token); next();
    });
    router.get('/session', async (req, res) => {
      try { res.json({ ...await this.profile(req.launcherSession.id, req.launcherSession.username), expires: req.launcherSession.expires }); }
      catch { res.status(503).json({ error: 'Discord no respondió' }); }
    });
    router.delete('/session', async (req, res) => {
      const previous = this.sessions[req.launcherTokenHash]; delete this.sessions[req.launcherTokenHash];
      try { await this.storage.set('sessions', this.sessions); res.json({ ok: true }); }
      catch { this.sessions[req.launcherTokenHash] = previous; res.sendStatus(503); }
    });
    return router;
  }
}
module.exports = { LauncherService };
