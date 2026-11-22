const RETIRED_COMMAND_NAMES = new Set(['jugadores', 'list', 'uptime', 'link', 'unlink', 'settings', 'linkcheck']);

class CommandRegistry {
  constructor(client, guildId, storage, global = false) {
    this.client = client; this.guildId = guildId; this.global = global; this.storage = storage; this.owned = []; this.cleanedLegacy = false;
  }
  async initialize() {
    this.owned = await this.storage.get('slash-owned', []);
    if (!Array.isArray(this.owned) || this.owned.some(item => !item || typeof item.id !== 'string'
      || typeof item.name !== 'string' || typeof item.global !== 'boolean')) throw Error('Registro de comandos inválido');
  }
  manager(global = this.global) {
    if (global) return this.client.application.commands;
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw Error('El servidor Discord configurado no está disponible');
    return guild.commands;
  }
  async sync(commands) {
    if (!this.cleanedLegacy) {
      const managers = new Set([
        this.client.guilds.cache.get(this.guildId)?.commands,
        this.client.application?.commands,
      ].filter(Boolean));
      for (const manager of managers) {
        const existing = await manager.fetch();
        for (const command of existing.values()) {
          if (RETIRED_COMMAND_NAMES.has(command.name)) await manager.delete(command.id);
        }
      }
      this.cleanedLegacy = true;
    }
    const selectedManager = this.manager();
    const names = new Set(commands.map(command => command.name));
    for (const old of [...this.owned]) {
      if (old.global === this.global && names.has(old.name)) continue;
      const manager = this.manager(old.global), existing = await manager.fetch(old.id).catch(error => {
        if (error.code === 10063) return null; throw error;
      });
      if (existing?.name === old.name) await manager.delete(old.id);
      this.owned = this.owned.filter(item => item.id !== old.id);
      await this.storage.set('slash-owned', this.owned);
    }
    for (const command of commands) {
      const previous = this.owned.find(item => item.name === command.name && item.global === this.global);
      let created;
      if (previous) {
        const manager = this.manager(previous.global);
        created = await manager.fetch(previous.id).then(existing => existing?.name === previous.name
          ? manager.edit(existing.id, command) : manager.create(command)).catch(error => {
          if (error.code === 10063) return manager.create(command);
          throw error;
        });
      } else created = await this.manager().create(command);
      this.owned = this.owned.filter(item => !(item.name === command.name && item.global === this.global));
      this.owned.push({ id: created.id, name: created.name, global: this.global });
      await this.storage.set('slash-owned', this.owned);
    }
  }
}
module.exports = { CommandRegistry };
