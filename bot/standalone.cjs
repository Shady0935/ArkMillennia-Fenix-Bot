const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Client, Events, GatewayIntentBits, Partials, MessageFlags, ActivityType } = require('discord.js');
const { ModuleManager } = require('./runtime/modules.cjs');
const { CommandRegistry } = require('./runtime/command-registry.cjs');
const { DashboardSystem } = require('./dashboard/system.cjs');
const { readEnvironment } = require('./runtime/environment.cjs');
const { Database } = require('./runtime/database.cjs');
const { migrateLegacy } = require('./runtime/migrate-legacy.cjs');
const { installErrorMonitor } = require('./runtime/error-monitor.cjs');

function configuration(env) {
  const roles=(env.DISCORD_ADMIN_ROLE_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
  if (!env.DISCORD_TOKEN || !/^[0-9]{17,20}$/.test(env.DISCORD_GUILD_ID||'') || roles.some(id=>!/^[0-9]{17,20}$/.test(id))) throw Error('Configura DISCORD_TOKEN y DISCORD_GUILD_ID en .env');
  const dashboardRoleId=String(env.DASHBOARD_REQUIRED_ROLE_ID||'').trim();
  if(!/^[0-9]{17,20}$/.test(dashboardRoleId))throw Error('Configura DASHBOARD_REQUIRED_ROLE_ID en .env');
  return { token:env.DISCORD_TOKEN.trim(), guildId:env.DISCORD_GUILD_ID, dashboardRoleId, roles,
    global:env.DISCORD_GLOBAL_COMMANDS==='true', presence:env.DISCORD_STATUS||'ArkMillennia Fenix' };
}

class StandaloneBot {
  constructor(options={}) {
    this.root=path.resolve(options.root||path.join(__dirname,'..')); this.options=options; this.closed=false; this.startedAt=Date.now();
    this.environment=options.environment||(()=>readEnvironment(this.root)); this.serial=Promise.resolve();
  }
  log(message) {
    let text=String(message);
    for(const secret of [this.config?.token,this.dashboard?.config?.secret]) if(secret)text=text.split(secret).join('[REDACTED]');
    (this.options.log||console.log)(text.replace(/[\r\n]/g,' ').slice(0,2000));
  }
  async start() {
    this.config=configuration(this.environment());
    this.removeErrorMonitor=installErrorMonitor(message=>this.log(message));
    this.database=await new Database(this.environment()).initialize();
    await migrateLegacy(this.root,this.database,message=>this.log(message));
    this.client=this.options.client||new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildModeration,GatewayIntentBits.GuildInvites,
      GatewayIntentBits.GuildExpressions,GatewayIntentBits.GuildWebhooks,GatewayIntentBits.GuildScheduledEvents,GatewayIntentBits.GuildIntegrations],
      partials:[Partials.Channel,Partials.Message,Partials.Reaction,Partials.User],allowedMentions:{parse:[],repliedUser:false},rest:{retries:0}});
    this.modules=new ModuleManager(path.join(this.root,'bot/modules'),this.client,this.database,message=>this.log(message),this.config.roles,this.config.guildId,this.config.dashboardRoleId);
    this.registry=new CommandRegistry(this.client,this.config.guildId,this.database.namespace('runtime'),this.config.global);
    await this.registry.initialize();
    this.dashboard=new DashboardSystem({root:path.join(this.root,'bot'),client:this.client,guildId:this.config.guildId,
      adminRoleIds:this.config.roles,database:this.database,services:this.modules.services,environment:this.environment,log:message=>this.log(message),botStatus:()=>this.status()});
    await this.dashboard.initialize();
    this.modules.registerSystemService('system:dashboard',this.dashboard);
    this.modules.registerSystemService('system:bot',{status:()=>this.status()});
    const env=this.environment();
    await this.modules.loadAll((env.BOT_DISABLED_JS_MODULES||'').split(',').map(value=>value.trim()).filter(Boolean));
    this.client.on(Events.ClientReady,()=>{
      this.log('Conectado a Discord · bot independiente');
      this.client.user.setActivity(this.config.presence,{type:ActivityType.Playing});
      this.enqueue(()=>this.registry.sync(this.modules.commands())).catch(error=>this.log(`Sincronización fallida: ${error.code||error.name}`));
    });
    this.client.on(Events.InteractionCreate,interaction=>this.interaction(interaction).catch(error=>this.log(`Interacción: ${error.code||error.name}`)));
    this.client.on(Events.Error,error=>this.log(`Discord: ${error.stack||error.code||error.name}`));
    const ready = this.client.isReady() ? Promise.resolve() : new Promise(resolve => this.client.once(Events.ClientReady, resolve));
    await this.client.login(this.config.token);
    await ready;
    try { await this.dashboard.start(); } catch(error) { this.log(`Dashboard no pudo arrancar: ${error.code||error.name}`); }
    this.log('Bot Ready');
    return this;
  }
  status() { return {discord:!!this.client?.isReady(),mode:'standalone',startedAt:this.startedAt,uptimeSeconds:Math.floor((Date.now()-this.startedAt)/1000),modules:this.modules?.list()||[]}; }
  enqueue(operation) { const next=this.serial.then(operation,operation);this.serial=next.catch(()=>{});return next; }
  async interaction(interaction) {
    if(!interaction.isChatInputCommand()||interaction.guildId!==this.config.guildId||!this.modules.commands().some(command=>command.name===interaction.commandName))return;
    try { await this.modules.execute(interaction); }
    catch(error) {
      this.log(`Comando ${interaction.commandName}: ${error.code||error.name}`);
      const payload={content:'No se pudo ejecutar el comando.',allowedMentions:{parse:[]}};
      try { if(interaction.replied||interaction.deferred)await interaction.editReply(payload);else await interaction.reply({...payload,flags:MessageFlags.Ephemeral}); }catch{}
    }
  }
  async command(text) {
    const [action,id,...extra]=text.trim().split(/\s+/);
    if(extra.length||!['status','list','load','reload','unload','sync','help','stop'].includes(action))throw Error('Comandos: status, list, load ID, reload ID, unload ID, sync, stop');
    if(action==='help')return 'status | list | load ID | reload ID | unload ID | sync | stop';
    if(action==='status')return this.status();if(action==='list')return this.modules.list();if(action==='stop'){await this.close();return 'Bot detenido';}
    if(id==='dashboard') {
      if(action==='reload')return this.dashboard.reload();if(action==='load')return this.dashboard.start(true);if(action==='unload')return this.dashboard.stop();throw Error('Acción de dashboard inválida');
    }
    return this.enqueue(async()=>{if(action==='load')await this.modules.load(id);else if(action==='reload')await this.modules.load(id,true);else if(action==='unload')await this.modules.unload(id);
      await this.registry.sync(this.modules.commands());return this.modules.list();});
  }
  async close() { if(this.closed)return;this.closed=true;this.removeErrorMonitor?.();await this.dashboard?.stop();await this.modules?.close();this.client?.destroy();await this.database?.close(); }
}

async function start(options={}) {
  const bot=new StandaloneBot(options);
  try { await bot.start(); } catch(error) { await bot.close();throw error; }
  const reader=readline.createInterface({input:process.stdin,terminal:false});
  reader.on('line',line=>{bot.command(line).then(result=>{bot.log(JSON.stringify(result));if(bot.closed){reader.close();process.exit(0);}}).catch(error=>bot.log(error.message));});
  // Closing stdin must not stop a daemon; Pelican supplies its own console.
  const shutdown=async()=>{reader.close();await bot.close();process.exit(0);};
  process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
  return bot;
}
module.exports={StandaloneBot,start,configuration};
