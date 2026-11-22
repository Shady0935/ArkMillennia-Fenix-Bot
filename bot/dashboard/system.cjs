const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { PermissionFlagsBits } = require('discord.js');
const { readEnvironment } = require('../runtime/environment.cjs');
const { DatabaseSessionStore } = require('../runtime/database.cjs');
const DASHBOARD_ICONS = new Set(['extension', 'campaign', 'dashboard', 'group', 'dns', 'settings', 'monitoring', 'shield',
  'workspace_premium', 'military_tech', 'sync_alt', 'history']);

function configuration(env) {
  const port = Number(env.DASHBOARD_PORT || 24431), proxy = Number(env.DASHBOARD_TRUST_PROXY_HOPS || 0);
  const sessionDays = Number(env.DASHBOARD_SESSION_DAYS || 7);
  const url = new URL(env.DASHBOARD_PUBLIC_URL || `http://127.0.0.1:${port}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(proxy) || proxy < 0 || proxy > 5
    || !Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 90) throw Error('Configuración de dashboard inválida');
  const roles = (env.DASHBOARD_ADMIN_ROLE_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (roles.some(id => !/^[0-9]{17,20}$/.test(id))) throw Error('Rol de dashboard inválido');
  const requiredRoleId = String(env.DASHBOARD_REQUIRED_ROLE_ID || '').trim();
  if (!/^[0-9]{17,20}$/.test(requiredRoleId)) throw Error('Configura DASHBOARD_REQUIRED_ROLE_ID con el rol autorizado');
  return { enabled: env.DASHBOARD_ENABLED === 'true', host: env.DASHBOARD_HOST || '127.0.0.1', port, proxy, sessionDays,
    publicUrl: url.origin, secure: url.protocol === 'https:', roles, requiredRoleId,
    clientId: env.DISCORD_OAUTH_CLIENT_ID || '', secret: env.DISCORD_OAUTH_CLIENT_SECRET || '' };
}

class DashboardSystem {
  constructor(options) {
    Object.assign(this, options); this.server = null; this.sockets = new Set(); this.loginAttempts = new Map(); this.consumedStates = new Map();
    this.environment = options.environment ?? (() => readEnvironment(this.root));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.database = options.database;
    this.store = new DatabaseSessionStore(this.database);
    this.config = configuration(this.environment());
  }
  async initialize() {
    this.sessionSecret = await this.database.get('dashboard', 'session-secret', null);
    if (typeof this.sessionSecret !== 'string' || this.sessionSecret.length < 48) {
      this.sessionSecret = crypto.randomBytes(48).toString('hex');
      await this.database.setIfAbsent('dashboard', 'session-secret', this.sessionSecret);
      this.sessionSecret = await this.database.get('dashboard', 'session-secret', this.sessionSecret);
    }
    if (this.sessionSecret.length < 48) throw Error('Secreto de sesión demasiado corto');
    return this;
  }
  descriptors() { return this.services.list().filter(e => /^dashboard:[a-z][a-z0-9_-]{0,63}$/.test(e.name)); }
  async access(id) {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw Error('Discord aún no está disponible');
    let member;
    try { member = await guild.members.fetch({ user: id, force: true }); }
    catch (error) { if (error.code === 10007) return null; throw error; }
    if (!member.roles.cache.has(this.config.requiredRoleId)) return null;
    const administrator = id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)
      || member.roles.cache.has(this.config.requiredRoleId)
      || [...this.adminRoleIds, ...this.config.roles].some(role => member.roles.cache.has(role));
    const extensions = [];
    for (const { name } of this.descriptors()) {
      const provider = this.services.get(name);
      // Each feature retains control of its own permission, including for dashboard administrators.
      if (!provider || typeof provider.canAccess !== 'function' || typeof provider.http !== 'function' || !await provider.canAccess(member)) continue;
      const title = typeof provider.title === 'string' ? provider.title.trim().slice(0, 60) : '';
      if (!title) continue;
      const description = typeof provider.description === 'string' ? provider.description.trim().slice(0, 180) : '';
      const icon = DASHBOARD_ICONS.has(provider.icon) ? provider.icon : 'extension';
      const order = Number.isInteger(provider.order) && provider.order >= 0 && provider.order <= 1000 ? provider.order : 100;
      const id = name.slice(10);
      const clientFile = typeof provider.client === 'string' && /^[a-z][a-z0-9_-]{0,63}\.js$/.test(provider.client) ? provider.client : '';
      const cssFiles = Array.isArray(provider.styles) ? provider.styles : typeof provider.styles === 'string' ? [provider.styles] : [];
      const styles = cssFiles.filter(file => typeof file === 'string' && /^[a-z][a-z0-9_-]{0,63}\.css$/.test(file)).slice(0, 4).map(file => `/extensions/${id}/${file}`);
      extensions.push({ id, title, description, icon, order, ...(clientFile ? { client: `/extensions/${id}/${clientFile}` } : {}), ...(styles.length ? { styles } : {}) });
    }
    extensions.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return administrator || extensions.length ? { member, administrator, extensions } : null;
  }
  info() { return { id: 'dashboard', version: '1.0.0', listening: !!this.server?.listening, url: this.config?.publicUrl || '', oauthConfigured: !!(this.config?.secret && (this.config.clientId || this.client.user?.id)), port: this.server?.address()?.port ?? this.config?.port }; }
  app() {
    const app = express(), cfg = this.config;
    app.disable('x-powered-by'); if (cfg.proxy) app.set('trust proxy', cfg.proxy);
    app.use((req, res, next) => {
      res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'" }); next();
    });
    const sessionMaxAge = cfg.sessionDays * 24 * 3600000;
    app.use(session({ name: 'millenniafenix.sid', secret: this.sessionSecret, store: this.store, resave: false, saveUninitialized: false, rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: cfg.secure, maxAge: sessionMaxAge } }));
    app.use((req, res, next) => {
      if (req.session?.cookie) req.session.cookie.maxAge = sessionMaxAge;
      next();
    });
    app.get('/', async (req, res) => {
      if (!req.session.user) return res.redirect('/login');
      try {
        if (!await this.access(req.session.user.id)) return res.redirect('/login?error=no_permission');
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
      } catch { res.status(503).send('No se puede verificar Discord. Inténtalo de nuevo.'); }
    });
    app.get('/login', async (req, res) => {
      if (!req.session.user) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
      try {
        if (await this.access(req.session.user.id)) return res.redirect('/');
        res.sendFile(path.join(__dirname, 'public', 'login.html'));
      } catch { res.status(503).send('No se puede verificar Discord. Inténtalo de nuevo.'); }
    });
    app.get(['/index.html', '/login.html'], (req, res) => res.redirect(req.session.user ? '/' : '/login'));
    app.get('/auth/discord', (req, res) => {
      if (!this.info().oauthConfigured) return res.status(503).send('Configura DISCORD_OAUTH_CLIENT_SECRET en el archivo .env del bot.');
      for (const [key, value] of this.loginAttempts) if (value.until < Date.now()) this.loginAttempts.delete(key);
      const key = req.ip, previous = this.loginAttempts.get(key) ?? { count: 0, until: Date.now() + 60000 };
      if (++previous.count > 20 || this.loginAttempts.size >= 1000 && !this.loginAttempts.has(key)) return res.sendStatus(429);
      this.loginAttempts.set(key, previous);
      const state = crypto.randomBytes(32).toString('hex'); req.session.oauth = { state, expires: Date.now() + 300000 };
      req.session.save(error => {
        if (error) return res.sendStatus(500);
        res.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: cfg.clientId || this.client.user.id,
          redirect_uri: cfg.publicUrl + '/auth/discord/callback', response_type: 'code', scope: 'identify', state }));
      });
    });
    app.get('/auth/discord/callback', async (req, res) => {
      const oauth = req.session.oauth; delete req.session.oauth;
      for (const [state, expiry] of this.consumedStates) if (expiry < Date.now()) this.consumedStates.delete(state);
      const valid = typeof req.query.state === 'string' && /^[a-f0-9]{64}$/.test(req.query.state) && oauth && oauth.expires > Date.now()
        && !this.consumedStates.has(req.query.state) && this.consumedStates.size < 1000
        && req.query.state.length === oauth.state.length && crypto.timingSafeEqual(Buffer.from(req.query.state), Buffer.from(oauth.state));
      if (valid) this.consumedStates.set(req.query.state, oauth.expires);
      // Persist consumption before network requests, preventing reuse of the same authorization callback.
      await new Promise(resolve => req.session.save(() => resolve()));
      if (!valid || typeof req.query.code !== 'string' || req.query.code.length > 2048) return res.redirect('/login?error=oauth_state');
      const launcherTicket = req.session.launcherTicket;
      try {
        const tokenResponse = await this.fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(15000),
          body: new URLSearchParams({ client_id: cfg.clientId || this.client.user.id, client_secret: cfg.secret, grant_type: 'authorization_code',
            code: req.query.code, redirect_uri: cfg.publicUrl + '/auth/discord/callback' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!tokenResponse.ok) throw Error('OAuth rechazado');
        const token = await tokenResponse.json();
        const userResponse = await this.fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15000) });
        if (!userResponse.ok) throw Error('Identidad no disponible');
        const user = await userResponse.json();
        if (!/^[0-9]{17,20}$/.test(user.id)) throw Error('Identidad inválida');
        if (req.session.launcherTicket) {
          const ticket = req.session.launcherTicket; delete req.session.launcherTicket;
          await new Promise(resolve => req.session.save(() => resolve()));
          const launcher = this.services.get('launcher');
          if (!launcher) throw Error('Módulo launcher no disponible');
          await launcher.complete(ticket, user);
          return res.type('html').send('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="theme-color" content="#10090b"><title>Millennia Fenix Bot</title><body style="background:#10090b;color:#f2ebea;font:18px system-ui;padding:48px"><h1>Discord vinculado</h1><p>Puedes volver al launcher y cerrar esta pestaña.</p></body></html>');
        }
        if (!await this.access(user.id)) return res.redirect('/login?error=no_permission');
        await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
        req.session.user = { id: user.id, username: String(user.username).slice(0, 100), globalName: String(user.global_name || '').slice(0, 100), avatar: typeof user.avatar === 'string' ? user.avatar : null };
        req.session.csrf = crypto.randomBytes(32).toString('hex');
        await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve())); res.redirect('/');
      } catch {
        if (req.session.launcherTicket) delete req.session.launcherTicket;
        if (launcherTicket) res.status(400).send('No se pudo completar la vinculación. Vuelve al launcher e inténtalo de nuevo.');
        else res.redirect('/login?error=oauth_failed');
      }
    });
    // Native launcher endpoints have their own credentials and never pass through
    // dashboard administrator/session authorization.
    app.use('/launcher', async (req, res, next) => {
      const launcher = this.services.get('launcher');
      if (!launcher || !this.info().oauthConfigured) return res.sendStatus(503);
      try { await launcher.http(req, res, next); }
      catch (error) { this.log(`Launcher: ${error.name}`); if (!res.headersSent) res.sendStatus(503); }
    });
    app.get('/api/me', async (req, res) => {
      if (!req.session.user) return res.json({ loggedIn: false, oauthConfigured: this.info().oauthConfigured });
      try {
        const access = await this.access(req.session.user.id);
        if (!access) return res.status(403).json({ error: 'No tienes permiso' });
        const avatarUrl = req.session.user.avatar
          ? `https://cdn.discordapp.com/avatars/${req.session.user.id}/${req.session.user.avatar}.${req.session.user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=64`
          : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(req.session.user.id) >> 22n) % 6n)}.png`;
        res.json({ loggedIn: true, ...req.session.user, avatarUrl, displayName: req.session.user.globalName || req.session.user.username,
          csrf: req.session.csrf, administrator: access.administrator, modules: access.extensions });
      } catch { res.status(503).json({ error: 'No se puede verificar Discord' }); }
    });
    app.use(['/api', '/extensions'], async (req, res, next) => {
      if (!req.session.user) return res.status(401).json({ error: 'Inicia sesión con Discord' });
      try {
        req.access = await this.access(req.session.user.id);
        if (!req.access) return res.status(403).json({ error: 'No tienes permiso' });
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
          if (req.get('Origin') !== cfg.publicUrl || !req.session.csrf || req.get('X-CSRF-Token') !== req.session.csrf) return res.status(403).json({ error: 'Solicitud no válida; vuelve a iniciar sesión' });
        }
        next();
      } catch { res.status(503).json({ error: 'No se puede verificar Discord' }); }
    });
    app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('millenniafenix.sid'); res.json({ ok: true }); }));
    app.get('/api/modules', (req, res) => res.json(req.access.extensions));
    app.get('/api/status', async (req, res) => {
      if (!req.access.administrator) return res.sendStatus(403);
      if (this.botStatus) return res.json(this.botStatus());
      res.json(this.botStatus ? this.botStatus() : { discord: this.client.isReady() });
    });
    app.use('/extensions/:id', async (req, res, next) => {
      const id = req.params.id;
      if (!req.access.extensions.some(e => e.id === id)) return res.status(403).json({ error: 'Módulo no autorizado' });
      const provider = this.services.get(`dashboard:${id}`);
      if (!provider) return res.status(404).json({ error: 'Módulo descargado' });
      try { await provider.http(req, res, next); } catch { if (!res.headersSent) res.status(500).json({ error: 'El módulo no pudo completar la solicitud' }); }
    });
    app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', dotfiles: 'deny' }));
    app.use((error, req, res, next) => { this.log(`Dashboard: ${error.name}`); if (!res.headersSent) res.status(error.status === 413 ? 413 : 400).json({ error: 'Solicitud no válida' }); });
    return app;
  }
  async start(force = false) {
    if (this.server) return this.info();
    this.config = configuration(this.environment());
    if (!this.config.enabled && !force) return this.info();
    const server = this.app().listen(this.config.port, this.config.host);
    this.server = server;
    server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    server.requestTimeout = 30000; server.headersTimeout = 15000;
    try { await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); }); }
    catch (error) { this.server = null; server.close(); throw error; }
    this.log(`Dashboard disponible en ${this.config.publicUrl}`); return this.info();
  }
  async stop() {
    const server = this.server; this.server = null;
    if (!server) return this.info();
    const stopped = new Promise(resolve => server.close(resolve));
    for (const socket of this.sockets) socket.destroy();
    await stopped; return this.info();
  }
  async reload() { configuration(this.environment()); await this.stop(); return this.start(true); }
}
module.exports = { DashboardSystem, DatabaseSessionStore, configuration };
