const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ModuleManager } = require('../runtime/modules.cjs');

function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'millenniafenix-js-'));
  const directory = path.join(root, 'bot/modules');
  const client = new EventEmitter();
  const manager = new ModuleManager(directory, client, { namespace: () => ({ get: async (_key, fallback = null) => fallback, set: async () => {} }) }, () => {});
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, client, write: (name, code) => fs.writeFileSync(path.join(directory, name), code) };
}

test('real JS and local helper are replaced; syntax errors retain active handlers', async t => {
  const { manager, write } = environment(t);
  write('helper.js', 'module.exports = "primero";');
  write('saludos.js', 'const message = require("./helper.js"); module.exports = { data: {name:"saludo",description:"Saludo"}, execute: async i => i.reply(message) };');
  await manager.load('saludos');
  const output = [];
  const interaction = { commandName: 'saludo', reply: async text => output.push(text) };
  await manager.execute(interaction);
  write('helper.js', 'module.exports = "segundo";');
  await manager.load('saludos', true);
  await manager.execute(interaction);
  write('saludos.js', 'esto no es JS válido !');
  await assert.rejects(manager.load('saludos', true));
  await manager.execute(interaction);
  assert.deepEqual(output, ['primero', 'segundo', 'segundo']);
});

test('failed candidate and unload remove timers/listeners, while native command collisions fail before commit', async t => {
  const { manager, client, write } = environment(t);
  manager.setReserved(['ping']);
  write('bad.js', 'module.exports = { data:{name:"ping",description:"Duplicado"}, execute() {} };');
  await assert.rejects(manager.load('bad'), /reservado/);
  write('eventos.js', 'module.exports = { setup(ctx) {ctx.on("demo", () => {}); ctx.every(1000, () => {}); throw Error("fallo");} };');
  await assert.rejects(manager.load('eventos'));
  assert.equal(client.listenerCount('demo'), 0);
  write('eventos.js', 'module.exports = { setup(ctx) {ctx.on("demo", () => {});} };');
  await manager.load('eventos');
  assert.equal(client.listenerCount('demo'), 1);
  await manager.unload('eventos');
  assert.equal(client.listenerCount('demo'), 0);
});

test('busy async handler prevents reload; previous version survives', async t => {
  const { manager, write } = environment(t);
  write('ocupado.js', 'module.exports = {data:{name:"ocupado",description:"Prueba"}, execute: async i => i.wait()};');
  await manager.load('ocupado');
  let release;
  const waiting = manager.execute({ commandName: 'ocupado', wait: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(manager.load('ocupado', true), /ocupado/);
  release();
  assert.equal(await waiting, true);
  await manager.load('ocupado', true);
});

test('service replacement is atomic, stale proxies are rejected and a background job prevents constructor side effects during reload', async t => {
  const { manager, write } = environment(t);
  write('service.js', 'module.exports={setup(ctx){ctx.provide("demo",{value:()=>1,run:task=>ctx.run(task)});}};');
  await manager.load('service'); const original = manager.services.get('demo');
  assert.equal(await original.value(), 1);
  let release; const job = original.run(() => new Promise(resolve => { release = resolve; }));
  write('service.js', 'throw Error("Constructor must not run while busy");');
  await assert.rejects(manager.load('service', true), /ocupado/); release(); await job;
  await assert.rejects(manager.load('service', true), /Constructor/); assert.equal(await original.value(), 1);
  write('service.js', 'module.exports={setup(ctx){ctx.provide("demo",{value:()=>2});}};');
  await manager.load('service', true); assert.equal(await manager.services.get('demo').value(), 2);
  await assert.rejects(original.value(), /recargado/); await manager.unload('service'); assert.equal(manager.services.get('demo'), undefined);
});
