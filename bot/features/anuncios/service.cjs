const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { PermissionFlagsBits } = require('discord.js');
const { createPayloads } = require('./payload.cjs');
const { readEnvironment } = require('../../runtime/environment.cjs');
const SNOWFLAKE = /^[0-9]{17,20}$/;
const SAFE_UPLOAD = /^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/;
const UPLOAD_GRACE_MS = 10 * 60 * 1000;

const DEFAULT_CONFIG = {
  admin_role_id: '', canal_consentimiento_id: '', mensaje_consentimiento_id: '', emoji_consentimiento: '✅',
  delayMs: 2000, batchSize: 30, batchPauseMs: 10000, cooldownMs: 300000, maximumFailures: 5,
};

class AnnouncementService {
  constructor(context, options = {}) {
    this.context = context; this.client = context.client; this.storage = context.storage;
    this.delay = options.delay ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.config = { ...DEFAULT_CONFIG }; this.consents = new Set(); this.failures = {};
    this.state = { active: null, history: [], lastStartedAt: 0 };
    this.changes = new Map(); this.revision = 0; this.lastReportedConsentCount = null; this.syncTask = null; this.persistTail = Promise.resolve(); this.consentTail = Promise.resolve();
    this.closed = false; this.controller = null; this.task = null; this.inUse = new Map(); this.syncing = false; this.synced = false;
    this.previews = new Map(); this.starting = false; this.testing = false; this.testCooldowns = new Map(); this.uploading = false;
    const env = options.environment ?? readEnvironment();
    this.env = env;
  }
  async initialize() {
    const storedConfig = await this.storage.get('config', null);
    const hasStoredConfig = !!storedConfig && typeof storedConfig === 'object' && !Array.isArray(storedConfig);
    this.config = { ...DEFAULT_CONFIG, ...(hasStoredConfig ? storedConfig : {}) };
    for (const [source, target] of Object.entries({ ANNOUNCEMENTS_CHANNEL_ID: 'canal_consentimiento_id', ANNOUNCEMENTS_MESSAGE_ID: 'mensaje_consentimiento_id', ANNOUNCEMENTS_EMOJI: 'emoji_consentimiento', ANNOUNCEMENTS_ADMIN_ROLE_ID: 'admin_role_id' })) {
      if ((!hasStoredConfig || !Object.hasOwn(storedConfig, target)) && this.env[source] !== undefined) this.config[target] = this.env[source].trim();
    }
    this.validateConfig();
    if (!hasStoredConfig) await this.persist('config', this.config);
    const consent = await this.storage.get('consents', []);
    if (!Array.isArray(consent) || consent.length > 100000 || consent.some(id => !SNOWFLAKE.test(id))) throw Error('Lista de consentimientos inválida');
    this.consents = new Set(consent);
    this.failures = await this.storage.get('failures', {});
    if (!this.failures || Array.isArray(this.failures) || typeof this.failures !== 'object'
      || Object.entries(this.failures).some(([id, count]) => !SNOWFLAKE.test(id) || !Number.isInteger(count) || count < 0)) throw Error('Registro de fallos inválido');
    this.state = await this.storage.get('jobs', { active: null, history: [], lastStartedAt: 0 });
    if (!this.state || !Array.isArray(this.state.history) || !Number.isFinite(this.state.lastStartedAt)) throw Error('Historial inválido');
    if (this.state.active) {
      this.state.active.status = 'interrupted'; this.state.active.done = true;
      this.state.active.error = 'El bot se detuvo durante el envío. No se reanudará automáticamente para evitar duplicados.';
      this.state.active.finishedAt = new Date().toISOString();
      this.state.history.unshift(this.state.active); this.state.active = null; await this.saveState();
    }
    return this;
  }
  validateConfig() {
    for (const key of ['admin_role_id', 'canal_consentimiento_id', 'mensaje_consentimiento_id'])
      if (typeof this.config[key] !== 'string' || this.config[key] && !SNOWFLAKE.test(this.config[key])) throw Error(`ID inválido: ${key}`);
    if (typeof this.config.emoji_consentimiento !== 'string' || !this.config.emoji_consentimiento || this.config.emoji_consentimiento.length > 100) throw Error('Emoji inválido');
    if (!Number.isInteger(this.config.delayMs) || this.config.delayMs < 1500 || this.config.delayMs > 30000
      || !Number.isInteger(this.config.batchSize) || this.config.batchSize < 1 || this.config.batchSize > 100
      || !Number.isInteger(this.config.batchPauseMs) || this.config.batchPauseMs < 0 || this.config.batchPauseMs > 120000
      || !Number.isInteger(this.config.cooldownMs) || this.config.cooldownMs < 0 || this.config.cooldownMs > 86400000
      || !Number.isInteger(this.config.maximumFailures) || this.config.maximumFailures < 1 || this.config.maximumFailures > 100) throw Error('Límites de anuncios inválidos');
  }
  persist(key, value) {
    const operation = this.persistTail.then(() => this.storage.set(key, structuredClone(value)));
    this.persistTail = operation.catch(() => {});
    return operation;
  }
  guild() {
    const guild = this.client.guilds.cache.get(this.context.guildId);
    if (!guild) throw Error('El servidor Discord configurado no está disponible');
    return guild;
  }
  canAccess(member) {
    if (!member || member.guild?.id !== this.context.guildId) return false;
    return !!(this.context.dashboardRoleId && member.roles.cache.has(this.context.dashboardRoleId))
      || member.id === member.guild.ownerId || !!member.permissions?.has(PermissionFlagsBits.Administrator)
      || !!(this.config.admin_role_id && member.roles.cache.has(this.config.admin_role_id));
  }
  async saveState() { this.state.history = this.state.history.slice(0, 100); await this.persist('jobs', this.state); }
  async consent(id, accepted) { return (await this.consentMany([id], accepted)) > 0; }
  async consentMany(ids, accepted) {
    const operation = this.consentTail.then(async () => {
      if (this.closed) return 0;
      const changed = [...new Set(ids)].filter(id => SNOWFLAKE.test(id) && this.consents.has(id) !== accepted);
      if (!changed.length) return 0;
      if (accepted && this.consents.size + changed.length > 100000) throw Error('Se alcanzó el máximo de consentimientos');
      const next = new Set(this.consents);
      for (const id of changed) { if (accepted) next.add(id); else next.delete(id); }
      this.consents = next;
      for (const id of changed) this.changes.set(id, { accepted, revision: ++this.revision });
      await this.persist('consents', [...next].sort()); this.reportConsentCount();
      return changed.length;
    });
    this.consentTail = operation.catch(() => {});
    return operation;
  }
  reportConsentCount() {
    const count = this.consents.size;
    if (count === this.lastReportedConsentCount) return;
    const previous = this.lastReportedConsentCount; this.lastReportedConsentCount = count;
    this.context.log(previous === null ? `Consentimientos: ${count}` : `Consentimientos: ${previous} → ${count}`);
  }
  matchesEmoji(emoji) {
    const custom = /^<a?:\w+:([0-9]{17,20})>$/.exec(this.config.emoji_consentimiento);
    return custom ? emoji.id === custom[1] : emoji.name === this.config.emoji_consentimiento;
  }
  async reaction(reaction, user, accepted) {
    if (user.bot || reaction.message.guildId !== this.context.guildId || reaction.message.id !== this.config.mensaje_consentimiento_id
      || reaction.message.channelId !== this.config.canal_consentimiento_id || !this.matchesEmoji(reaction.emoji)) return;
    await this.consent(user.id, accepted);
  }
  async sync() {
    if (this.syncTask) return this.syncTask;
    if (!this.config.canal_consentimiento_id || !this.config.mensaje_consentimiento_id) throw Error('Configura el mensaje de consentimiento en bot/.env');
    this.syncing = true; this.synced = false; const revision = this.revision;
    this.syncTask = this.performSync(revision);
    try { return await this.syncTask; }
    finally { this.syncTask = null; this.syncing = false; }
  }
  async performSync(revision) {
    try {
      const channel = await this.guild().channels.fetch(this.config.canal_consentimiento_id);
      if (!channel?.messages) throw Error('Canal de consentimiento no válido');
      const message = await channel.messages.fetch(this.config.mensaje_consentimiento_id);
      await message.react(this.config.emoji_consentimiento);
      const custom = /^<a?:\w+:([0-9]{17,20})>$/.exec(this.config.emoji_consentimiento);
      const reaction = message.reactions.cache.find(r => custom ? r.emoji.id === custom[1] : this.matchesEmoji(r.emoji));
      if (!reaction) throw Error('No se pudo leer la reacción de consentimiento');
      const found = new Set(); let after;
      for (;;) {
        const users = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
        if (!users.size) break;
        for (const [id, user] of users) if (!user.bot) found.add(id);
        const next = users.lastKey(); if (!next || next === after) throw Error('Discord no avanzó la paginación'); after = next;
        if (found.size > 100000) throw Error('Demasiados consentimientos');
        if (users.size < 100) break;
      }
      const commit = this.consentTail.then(async () => {
        for (const [id, change] of this.changes) if (change.revision > revision) { if (change.accepted) found.add(id); else found.delete(id); }
        await this.persist('consents', [...found].sort()); this.consents = found; this.synced = true; this.reportConsentCount();
        for (const [id, change] of this.changes) if (change.revision <= revision) this.changes.delete(id);
      });
      this.consentTail = commit.catch(() => {}); await commit;
      return { ok: true, users: found.size, message: `Consentimientos sincronizados: ${found.size}` };
    } catch (error) { this.synced = false; throw error; }
  }
  async setup({ channelId, messageId = '', adminRoleId, emoji = '✅' }) {
    if (this.state.active || this.syncing) throw Error('Espera a que termine el envío o la sincronización');
    if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(adminRoleId) || messageId && !SNOWFLAKE.test(messageId)
      || typeof emoji !== 'string' || !emoji || emoji.length > 100) throw Error('Configuración de consentimiento inválida');
    const channel = await this.guild().channels.fetch(channelId);
    if (!channel?.isSendable() || channel.guildId !== this.context.guildId || !channel.messages) throw Error('El canal debe pertenecer al servidor configurado');
    const message = messageId ? await channel.messages.fetch(messageId) : await channel.send({
      content: `## Anuncios de ArkMillennia Fenix\nReacciona con ${emoji} para recibir anuncios por mensaje directo. Quita tu reacción para dejar de recibirlos.`, allowedMentions: { parse: [] },
    });
    await message.react(emoji);
    this.config = { ...this.config, canal_consentimiento_id: channelId, mensaje_consentimiento_id: message.id, admin_role_id: adminRoleId, emoji_consentimiento: emoji };
    await this.persist('config', this.config); return this.sync();
  }
  async setConsentSource({ channelId, messageId, emoji = this.config.emoji_consentimiento }) {
    if (this.state.active || this.starting || this.syncing || this.testing) throw Error('Espera a que termine el envío o la sincronización');
    if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId)
      || typeof emoji !== 'string' || !emoji.trim() || emoji.length > 100) throw Error('Canal, mensaje o reacción inválidos');
    const channel = await this.guild().channels.fetch(channelId);
    if (!channel || channel.guildId !== this.context.guildId || !channel.messages?.fetch) throw Error('El canal debe pertenecer al servidor configurado');
    const message = await channel.messages.fetch(messageId);
    if (!message || message.guildId && message.guildId !== this.context.guildId || message.channelId && message.channelId !== channelId) {
      throw Error('El mensaje debe pertenecer al canal y servidor configurados');
    }
    await message.react(emoji.trim());
    const previous = this.config;
    this.config = { ...this.config, canal_consentimiento_id: channelId, mensaje_consentimiento_id: messageId, emoji_consentimiento: emoji.trim() };
    this.validateConfig();
    try { await this.persist('config', this.config); return await this.sync(); }
    catch (error) { this.config = previous; await this.persist('config', previous); throw error; }
  }
  status() {
    return { isSending: !!this.state.active, cooldownRemaining: Math.max(0, Math.ceil((this.state.lastStartedAt + this.config.cooldownMs - Date.now()) / 1000)),
      configured: !!this.config.mensaje_consentimiento_id, synced: this.synced, consentCount: this.consents.size,
      active: this.state.active ? structuredClone(this.state.active) : null };
  }
  progress(id) {
    const job = this.state.active?.sendId === id ? this.state.active : this.state.history.find(value => value.sendId === id);
    return job ? structuredClone(job) : null;
  }

  reserveUploads(names) {
    for (const name of names) this.inUse.set(name, (this.inUse.get(name) ?? 0) + 1);
  }

  releaseUploads(names) {
    for (const name of names) {
      const current = this.inUse.get(name) ?? 0;
      if (current <= 1) this.inUse.delete(name);
      else this.inUse.set(name, current - 1);
    }
  }
  async start(input, actor) {
    if (this.closed || this.state.active || this.starting || this.testing) throw Error('Ya hay un anuncio en curso o el módulo está cerrado');
    if (!this.client.isReady()) throw Error('Discord todavía no está listo');
    if (!this.synced || this.syncing) throw Error('Espera a que se sincronicen las reacciones de consentimiento');
    if (this.status().cooldownRemaining) throw Error('Espera a que termine el tiempo de espera entre anuncios');
    if (!this.consents.size) throw Error('Todavía no hay usuarios suscritos');
    this.starting = true;
    try {
      const prepared = await createPayloads(input.blocks, input.color, this.storage);
      const recipients = [...this.consents], sendId = crypto.randomUUID();
      const job = { sendId, tipo: 'custom-blocks', date: new Date().toISOString(), actor: String(actor.id), blocksCount: prepared.blocks.length,
        total: recipients.length, procesados: 0, enviados: 0, fallidos: 0, omitidos: 0, pages: prepared.payloads.length, status: 'sending', done: false };
      this.state.active = job; this.state.lastStartedAt = Date.now();
      try { await this.saveState(); }
      catch (error) { this.state.active = null; throw error; }
      this.controller = new AbortController(); this.reserveUploads(prepared.uploads);
      this.task = this.context.run(() => this.send(job, recipients, prepared.payloads, this.controller.signal))
        .catch(error => { job.error = error.name === 'AbortError' ? 'Envío cancelado' : 'El envío se interrumpió; revisa los logs'; job.status = error.name === 'AbortError' ? 'cancelled' : 'failed'; })
        .finally(async () => {
          job.done = true; job.finishedAt = new Date().toISOString();
          job.result = { enviados: job.enviados, fallidos: job.fallidos, omitidos: job.omitidos, total: job.total, pages: job.pages };
          if (job.status === 'sending') job.status = 'completed';
          this.state.history.unshift(job); this.state.active = null; this.releaseUploads(prepared.uploads);
          try { await this.persist('failures', this.failures); await this.saveState(); }
          catch (error) { this.context.log(`No se pudo guardar el resultado del anuncio: ${error.name}`); }
        });
      return { ok: true, sendId };
    } finally { this.starting = false; }
  }
  async preview(text, actor) {
    for (const [key, value] of this.previews) if (value.expires < Date.now()) this.previews.delete(key);
    if (this.previews.size >= 100) throw Error('Demasiadas vistas previas pendientes');
    const id = crypto.randomUUID(), input = { blocks: [{ type: 'text', content: text }], color: '#8f1d3d' };
    await createPayloads(input.blocks, input.color, this.storage);
    this.previews.set(id, { input, actor: actor.id, expires: Date.now() + 600000 }); return { id, text };
  }
  async confirm(id, actor) {
    const preview = this.previews.get(id);
    if (!preview || preview.actor !== actor.id || preview.expires < Date.now()) throw Error('La confirmación caducó o pertenece a otro usuario');
    const result = await this.start(preview.input, actor); this.previews.delete(id); return result;
  }
  async sendTest(input, actor) {
    const actorId = String(actor?.id ?? '');
    if (!SNOWFLAKE.test(actorId)) throw Error('No se pudo identificar la cuenta conectada');
    if (this.closed || !this.client.isReady()) throw Error('Discord todavía no está listo');
    if (this.starting || this.testing) throw Error('Espera a que termine la otra operación');
    const cooldown = this.testCooldowns.get(actorId) ?? 0;
    if (Date.now() < cooldown) throw Error(`Espera ${Math.ceil((cooldown - Date.now()) / 1000)} s antes de enviar otra prueba`);
    this.testing = true;
    try {
      const prepared = await createPayloads(input.blocks, input.color, this.storage);
      this.reserveUploads(prepared.uploads);
      try {
        const user = await this.client.users.fetch(actorId);
        if (!user || user.bot) throw Error('La cuenta de la dashboard no es válida');
        for (const payload of prepared.payloads) await user.send(payload);
        this.testCooldowns.set(actorId, Date.now() + 10000);
        return { ok: true, pages: prepared.payloads.length };
      } finally { this.releaseUploads(prepared.uploads); }
    } finally { this.testing = false; }
  }
  async uploadReferences() {
    const referenced = new Set();
    if (typeof this.storage.entries !== 'function') return referenced;
    for (const [key, draft] of await this.storage.entries()) {
      if (!String(key).startsWith('draft:') || !Array.isArray(draft?.blocks)) continue;
      for (const block of draft.blocks) {
        const urls = block?.type === 'image' ? [block.url] : block?.type === 'gallery' && Array.isArray(block.images) ? block.images : [];
        for (const url of urls) {
          const match = typeof url === 'string' && /^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/.exec(url);
          if (match) referenced.add(match[1]);
        }
      }
    }
    return referenced;
  }
  async deleteUpload(name) {
    if (!SAFE_UPLOAD.test(name)) throw Error('Nombre de imagen inválido');
    if (this.inUse.has(name)) { const error = Error('La imagen está en un anuncio en curso'); error.statusCode = 409; throw error; }
    if ((await this.uploadReferences()).has(name)) { const error = Error('Quita esta imagen de los borradores guardados antes de eliminarla'); error.statusCode = 409; throw error; }
    if (typeof this.storage.getBlob === 'function' && !await this.storage.getBlob(name)) return false;
    return this.storage.deleteBlob(name);
  }
  async uploadsInfo() {
    const [files, referenced] = await Promise.all([this.storage.listBlobs(), this.uploadReferences()]);
    const valid = files.filter(file => SAFE_UPLOAD.test(file.key));
    const totalSize = valid.reduce((sum, file) => sum + file.bytes, 0);
    return { count: valid.length, totalSize, totalSizeMB: (totalSize / 1048576).toFixed(2), quotaMB: 256,
      files: valid.map(file => ({ name: file.key, bytes: file.bytes, updatedAt: file.updatedAt,
        inDraft: referenced.has(file.key), inUse: this.inUse.has(file.key) })) };
  }
  async cleanupUploads(age = UPLOAD_GRACE_MS) {
    let removed = 0; const referenced = await this.uploadReferences();
    for (const file of await this.storage.listBlobs()) {
      if (!SAFE_UPLOAD.test(file.key) || this.inUse.has(file.key) || referenced.has(file.key)) continue;
      const updatedAt = new Date(file.updatedAt).getTime();
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt > age && await this.storage.deleteBlob(file.key)) removed++;
    }
    return removed;
  }
  async send(job, recipients, payloads, signal) {
    for (const id of recipients) {
      signal.throwIfAborted();
      if (!this.consents.has(id)) { job.omitidos++; job.procesados++; await this.saveState(); continue; }
      try {
        const member = await this.guild().members.fetch({ user: id, force: true });
        if (member.user.bot) { await this.consent(id, false); job.omitidos++; }
        else {
          let delivered = false;
          for (const payload of payloads) {
            signal.throwIfAborted(); if (!this.consents.has(id)) break;
            await member.user.send(payload); delivered = true;
            if (payloads.length > 1) await this.delay(1500, signal);
          }
          if (delivered) { job.enviados++; delete this.failures[id]; } else job.omitidos++;
        }
      } catch (error) {
        if (signal.aborted || error.name === 'AbortError') throw error;
        if ([40005, 50035, 50045].includes(error.code)) throw error;
        job.fallidos++;
        if ([50007, 10007, 10013].includes(error.code)) {
          this.failures[id] = (this.failures[id] ?? 0) + 1;
          if (error.code === 10007 || error.code === 10013 || this.failures[id] >= this.config.maximumFailures) await this.consent(id, false);
        }
      }
      job.procesados++; await this.persist('failures', this.failures); await this.saveState();
      if (job.procesados < job.total) {
        await this.delay(this.config.delayMs, signal);
        if (job.procesados % this.config.batchSize === 0) await this.delay(this.config.batchPauseMs, signal);
      }
    }
  }
  cancel() { if (this.controller && this.state.active) { this.controller.abort(); return true; } return false; }
  async close() { this.closed = true; this.cancel(); if (this.task) await this.task; await this.persistTail; }
}

module.exports = { AnnouncementService, DEFAULT_CONFIG, UPLOAD_GRACE_MS };
