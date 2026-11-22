const fs = require('node:fs');
const path = require('node:path');

async function bounded(operation, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

function clearLocalCache(filename, root, seen = new Set()) {
  if (seen.has(filename)) return;
  seen.add(filename);
  const cached = require.cache[filename];
  if (!cached) return;
  for (const child of cached.children) {
    if (child.filename.startsWith(root + path.sep) && !child.filename.includes(`${path.sep}node_modules${path.sep}`)) {
      clearLocalCache(child.filename, root, seen);
    }
  }
  delete require.cache[filename];
}

class ModuleManager {
  constructor(directory, client, database, log = () => {}, adminRoleIds = [], guildId = '', dashboardRoleId = '') {
    this.directory = path.resolve(directory);
    this.client = client;
    this.database = database;
    this.log = log;
    this.adminRoleIds = adminRoleIds;
    this.guildId = guildId;
    this.dashboardRoleIds = Object.freeze((Array.isArray(dashboardRoleId) ? dashboardRoleId : dashboardRoleId ? [dashboardRoleId] : []).map(String));
    this.dashboardRoleId = this.dashboardRoleIds[0] || '';
    this.providers = new Map();
    this.services = Object.freeze({
      get: name => this.service(name),
      list: () => [...this.providers.entries()].map(([name, entry]) => ({ name, owner: entry.module.id })),
    });
    this.modules = new Map();
    this.reserved = new Set();
    this.closed = false;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  setReserved(names) {
    const next = new Set(names);
    this.validate(null, next);
    this.reserved = next;
  }

  validate(candidate, reserved = this.reserved) {
    const names = new Set(reserved);
    for (const module of [...this.modules.values(), ...(candidate ? [candidate] : [])]) {
      if (candidate && module !== candidate && module.id === candidate.id) continue;
      for (const command of module.commands) {
        const data = command.data;
        if (!data || !/^[a-z][a-z0-9_-]{0,31}$/.test(data.name) || typeof data.description !== 'string'
          || !data.description.length || data.description.length > 100 || typeof command.execute !== 'function') throw Error('Comando inválido');
        if (names.has(data.name)) throw Error(`Comando duplicado o reservado: ${data.name}`);
        names.add(data.name);
      }
    }
    if (names.size > 100) throw Error('Máximo 100 comandos');
  }

  async load(id, reload = false) {
    if (this.closed || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw Error('ID de módulo inválido');
    const old = this.modules.get(id);
    if (old?.busy) throw Error('Módulo ocupado; vuelve a intentar cuando termine');
    if (!!old !== reload) throw Error(old ? 'El módulo ya está cargado' : 'El módulo no está cargado');
    const filename = ['.js', '.cjs'].map(ext => path.join(this.directory, id + ext)).find(p => fs.existsSync(p));
    if (!filename || !fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw Error('No existe el archivo JS del módulo');
    if (fs.statSync(filename).size > 1024 * 1024) throw Error('Módulo demasiado grande');
    clearLocalCache(filename, path.dirname(this.directory));
    const module = { id, active: false, busy: 0, commands: [], resources: [], closed: false, preparing: true, providers: new Map() };
    try {
      const exported = require(filename);
      module.version = String(exported.version ?? '1.0.0');
      const commands = exported.commands ?? (exported.data ? [exported] : []);
      module.commands = commands.map(command => ({ ...command, data: command.data?.toJSON ? command.data.toJSON() : command.data }));
      this.validate(module);
      const context = {
        client: this.client, storage: this.database.namespace(id),
        guildId: this.guildId, dashboardRoleId: this.dashboardRoleId, dashboardRoleIds: this.dashboardRoleIds,
        adminRoleIds: Object.freeze([...this.adminRoleIds]), services: this.services,
        provide: (name, value) => {
          if (!module.preparing || module.closed || name.startsWith('system:') || !/^[a-z][a-z0-9:._-]{0,63}$/.test(name) || !value || typeof value !== 'object') throw Error('Servicio inválido o registro fuera de setup');
          if (module.providers.has(name)) throw Error('Servicio duplicado');
          module.providers.set(name, value);
        },
        run: task => {
          if (!module.active || module.closed) return Promise.reject(Error('Módulo no activo'));
          return this.invoke(module, task);
        },
        log: message => this.log(`[${id}] ${String(message)}`),
        on: (event, handler) => {
          if (module.closed) throw Error('Módulo cerrado');
          const wrapped = (...args) => {
            // Slash handlers belong to the dispatcher. This event hook is for buttons/modals and other events.
            if (event === 'interactionCreate' && args[0]?.isChatInputCommand?.()) return;
            this.invoke(module, handler, ...args).catch(error => {
              const interaction = event === 'interactionCreate' ? args[0] : null;
              if (interaction && [10062, 40060].includes(Number(error?.code))) {
                const age = Number.isFinite(interaction.createdTimestamp) ? `${Date.now() - interaction.createdTimestamp}ms` : 'edad desconocida';
                this.log(`[${id}] Interacción no disponible al responder (${error.code}, ${interaction.customId || interaction.commandName || 'sin id'}, ${age})`);
                return;
              }
              this.log(`[${id}] Evento fallido: ${error.stack || error.name}`);
            });
          };
          this.client.on(event, wrapped);
          module.resources.push(() => this.client.off(event, wrapped));
        },
        every: (milliseconds, handler) => {
          if (module.closed) throw Error('Módulo cerrado');
          if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 86400000) throw Error('Intervalo inválido');
          let pending = false;
          const timer = setInterval(() => {
            if (pending || !module.active) return;
            pending = true;
            this.invoke(module, handler).catch(error => this.log(`[${id}] Tarea fallida: ${error.stack || error.name}`)).finally(() => { pending = false; });
          }, milliseconds);
          timer.unref();
          module.resources.push(() => clearInterval(timer));
        },
        onClose: close => { if (module.closed) throw Error('Módulo cerrado'); if (typeof close !== 'function') throw Error('onClose requiere una función'); module.resources.push(close); },
      };
      module.context = context;
      if (typeof exported.dispose === 'function') module.resources.push(() => exported.dispose(context));
      if (exported.setup) await bounded(Promise.resolve().then(() => {
        if (old?.busy) throw Error('Módulo ocupado; vuelve a intentar cuando termine');
        return exported.setup(context);
      }), 10000, 'setup agotó el tiempo de preparación');
      module.preparing = false;
      this.validate(module);
      for (const name of module.providers.keys()) {
        const existing = this.providers.get(name);
        if (existing && existing.module !== old) throw Error(`Servicio duplicado: ${name}`);
      }
      if (old?.busy) throw Error('Módulo ocupado; vuelve a intentar cuando termine');
      if (old) old.active = false;
      module.active = true;
      this.modules.set(id, module);
      for (const [name, value] of module.providers) this.providers.set(name, { module, value });
      if (old) await this.dispose(old);
      if (typeof exported.activate === 'function') this.invoke(module, exported.activate).catch(error => this.log(`[${id}] Activación fallida: ${error.message}`));
      return this.list();
    } catch (error) {
      if (this.modules.get(id) !== module) await this.dispose(module);
      throw error;
    }
  }

  async invoke(module, handler, ...args) {
    if (!module.active) return;
    module.busy++;
    try { return await handler(...args, module.context); }
    finally { module.busy--; }
  }

  async execute(interaction) {
    for (const module of this.modules.values()) {
      const command = module.commands.find(c => c.data.name === interaction.commandName);
      if (command && module.active) {
        if (command.adminOnly && !interaction.memberPermissions?.has('Administrator')
          && !this.adminRoleIds.some(id => interaction.member?.roles?.cache?.has(id))) throw Error('No tienes permiso');
        await this.invoke(module, command.execute, interaction);
        return true;
      }
    }
    return false;
  }

  async unload(id) {
    const module = this.modules.get(id);
    if (!module) throw Error('Módulo no cargado');
    if (module.busy) throw Error('Módulo ocupado');
    module.active = false;
    this.modules.delete(id);
    await this.dispose(module);
    return this.list();
  }

  async dispose(module) {
    module.closed = true;
    for (const name of module.providers.keys()) if (this.providers.get(name)?.module === module) this.providers.delete(name);
    const jobs = [];
    for (const close of module.resources.reverse()) {
      try { jobs.push(Promise.resolve(close()).catch(error => this.log(`[${module.id}] Error al limpiar: ${error.stack || error.name}`))); }
      catch (error) { this.log(`[${module.id}] Error al limpiar: ${error.stack || error.name}`); }
    }
    module.resources = [];
    try { await bounded(Promise.allSettled(jobs), 2000, 'Limpieza agotada'); }
    catch { this.log(`[${module.id}] La limpieza asíncrona no terminó a tiempo`); }
  }

  list() { return [...this.modules.values()].map(m => ({ id: m.id, version: m.version })); }
  registerSystemService(name, value) {
    if (!name.startsWith('system:') || this.providers.has(name)) throw Error('Servicio del sistema inválido');
    this.providers.set(name, { value, module: { id: 'system', active: true, closed: false, busy: 0 } });
  }
  service(name) {
    const entry = this.providers.get(name);
    if (!entry?.module.active || entry.module.closed) return undefined;
    return new Proxy(entry.value, {
      get: (target, key) => typeof target[key] !== 'function' ? target[key] : (...args) => {
        if (!entry.module.active || entry.module.closed) return Promise.reject(Error('Servicio recargado; vuelve a intentar'));
        return this.invoke(entry.module, target[key].bind(target), ...args);
      },
    });
  }
  commands() { return [...this.modules.values()].flatMap(m => m.commands.map(c => c.data)); }
  async loadAll(disabled = []) {
    const ids = new Set(fs.readdirSync(this.directory).filter(f => /^[a-z][a-z0-9_-]*\.(?:js|cjs)$/.test(f)).map(f => f.replace(/\.(?:js|cjs)$/, '')));
    for (const id of [...ids].sort()) {
      if (disabled.includes(id)) continue;
      try { await this.load(id); } catch (error) { this.log(`Módulo ${id} rechazado: ${error.message}`); }
    }
  }
  async close() {
    this.closed = true;
    for (const module of this.modules.values()) module.active = false;
    for (const module of this.modules.values()) await this.dispose(module);
    this.modules.clear();
  }
}

module.exports = { ModuleManager };
