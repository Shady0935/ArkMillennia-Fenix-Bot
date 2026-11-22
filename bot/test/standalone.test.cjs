const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { EventEmitter }=require('node:events');
const { Events }=require('discord.js');
const { StandaloneBot,configuration }=require('../standalone.cjs');
const { CommandRegistry }=require('../runtime/command-registry.cjs');
function commands(){
  const values=new Map([['legacy-jugadores',{id:'legacy-jugadores',name:'jugadores'}]]), calls=[];let sequence=0;
  return {values,calls,async create(spec){calls.push(['create',spec.name]);const previous=[...values.values()].find(value=>value.name===spec.name);const value={...spec,id:previous?.id||'bot-'+(++sequence)};values.set(value.id,value);return value;},
    async fetch(id){if(id===undefined)return new Map(values);if(values.has(id))return values.get(id);throw Object.assign(Error('Unknown command'),{code:10063});},async delete(id){calls.push(['delete',id]);values.delete(id);}};
}
test('single-guild command registry removes retired commands and tracks only bot commands',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'millenniafenix-registry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manager=commands(),client={guilds:{cache:new Map([['guild',{commands:manager}]])}};
  const values=new Map(),storage={get:async(key,fallback=null)=>values.has(key)?values.get(key):fallback,set:async(key,value)=>values.set(key,value)};
  const first=new CommandRegistry(client,'guild',storage);await first.sync([{name:'anuncio',description:'Anuncio'}]);
  assert.equal([...manager.values.values()].some(item=>item.name==='jugadores'),false);assert.equal(manager.values.size,1);
  const second=new CommandRegistry(client,'guild',storage);await second.sync([]);
  assert.equal(manager.values.size,0);
});
test('standalone connects to one Discord and reloads its modules',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'millenniafenix-standalone-'));fs.mkdirSync(path.join(root,'bot/modules'),{recursive:true});
  const filename=path.join(root,'bot/modules/demo.js');
  fs.writeFileSync(filename,'module.exports={data:{name:"ping",description:"Prueba"},execute:i=>i.reply("v1")};');
  const manager=commands();
  class FakeClient extends EventEmitter{
    constructor(){super();this.user={id:'323456789012345678',setActivity:()=>{}};this.guilds={cache:new Map([['123456789012345678',{commands:manager}]])};this.application={commands:commands()};}
    isReady(){return !this.closed;}
    async login(token){assert.equal(token,'test-only');this.emit(Events.ClientReady,this);return token;}
    destroy(){this.closed=true;}
  }
  const client=new FakeClient(),bot=new StandaloneBot({root,client,environment:()=>({DISCORD_TOKEN:'test-only',DISCORD_GUILD_ID:'123456789012345678',DASHBOARD_ENABLED:'false'}),log:()=>{}});
  t.after(async()=>{await bot.close();fs.rmSync(root,{recursive:true,force:true});});
  await bot.start();await bot.serial;
  const replies=[];const interaction=name=>({commandName:name,guildId:'123456789012345678',isChatInputCommand:()=>true,reply:async value=>replies.push(value)});
  await bot.interaction(interaction('list'));assert.deepEqual(replies,[]);
  await bot.interaction(interaction('ping'));assert.deepEqual(replies,['v1']);
  fs.writeFileSync(filename,'module.exports={data:{name:"ping",description:"Prueba"},execute:i=>i.reply("v2")};');
  await bot.command('reload demo');await bot.interaction(interaction('ping'));assert.deepEqual(replies,['v1','v2']);
  assert.equal([...manager.values.values()].some(item=>item.name==='jugadores'),false);assert.equal(bot.status().mode,'standalone');
});
test('standalone configuration requires one Discord and rejects missing credentials',()=>{
  assert.throws(()=>configuration({}),/DISCORD_TOKEN/);
  assert.equal(configuration({DISCORD_TOKEN:'test',DISCORD_GUILD_ID:'123456789012345678'}).guildId,'123456789012345678');
});
