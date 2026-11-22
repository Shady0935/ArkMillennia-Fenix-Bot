const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LauncherService } = require('../features/launcher/service.cjs');
const { DashboardSystem } = require('../dashboard/system.cjs');
const { ModuleManager } = require('../runtime/modules.cjs');
const { EventEmitter } = require('node:events');
const ID = '123456789012345678', GUILD = '223456789012345678', ROLE = '323456789012345678';
const secret = 'a'.repeat(64), challenge = crypto.createHash('sha256').update(secret).digest('hex');

async function fixture(t, modular = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'millenniafenix-launcher-')); let present = true, staff = true, ready = true, clock = Date.now();
  const member = { roles: { cache: { has: id => staff && id === ROLE } }, permissions: { has: () => false } };
  const guild = { ownerId: '423456789012345678', members: { fetch: async () => { if (!present) throw Object.assign(Error('not member'), { code: 10007 }); return member; } } };
  const client = Object.assign(new EventEmitter(), { user: { id: ID }, isReady: () => ready, guilds: { cache: new Map([[GUILD, guild]]) } });
  const providers = new Map(), context = { dataDirectory: path.join(root, 'data'), client, guildId: GUILD, adminRoleIds: [ROLE] };
  const launcher = new LauncherService(context, { environment: {}, now: () => clock }); providers.set('launcher', launcher);
  let manager;
  if (modular) {
    manager = new ModuleManager(path.join(root, 'bot/modules'), client, { namespace: () => ({ get: async (_key, fallback = null) => fallback, set: async () => {} }) }, () => {}, [ROLE], GUILD);
    fs.mkdirSync(path.join(root, 'bot/features/launcher'), { recursive: true });
    // Exercise the actual module manager's async service proxy against the router.
    manager.registerSystemService('system:test', {});
    fs.writeFileSync(path.join(root, 'bot/modules/launcher.js'), 'module.exports={setup(ctx){ctx.provide("launcher",global.__launcherFixture)}}');
    global.__launcherFixture = launcher; await manager.load('launcher'); delete global.__launcherFixture;
    assert.ok(manager.services.get('launcher'), 'Module publishes the launcher service');
  }
  const dashboard = new DashboardSystem({ root: path.join(root, 'bot'), client, guildId: GUILD, adminRoleIds: [],
    services: modular ? manager.services : { list: () => [], get: name => providers.get(name) }, log: () => {},
    environment: () => ({ DASHBOARD_ENABLED: 'true', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PORT: '0', DASHBOARD_PUBLIC_URL: 'http://localhost', DISCORD_OAUTH_CLIENT_SECRET: 'fixture-only' }),
    fetch: async url => ({ ok: true, json: async () => url.includes('/oauth2/token') ? { access_token: 'fixture-token' } : { id: ID, username: 'ArkMillennia Fenix Staff' } }) });
  await dashboard.start();
  t.after(async () => { await dashboard.stop(); if (manager) await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + dashboard.info().port;
  const request = (route, options = {}) => fetch(base + route, { redirect: 'manual', ...options });
  const post = (route, data, token) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(data) });
  async function pair() {
    const start = await post('/launcher/link', { challenge }); assert.equal(start.status, 200); const { id } = await start.json();
    const browser = await request('/launcher/authorize?id=' + id); assert.equal(browser.status, 302);
    const cookie = browser.headers.get('set-cookie').split(';')[0];
    const oauth = await request('/auth/discord', { headers: { Cookie: cookie } });
    const url = new URL(oauth.headers.get('location')); assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost/auth/discord/callback');
    const callback = await request('/auth/discord/callback?' + new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code' }), { headers: { Cookie: cookie } });
    assert.equal(callback.status, 200); assert.match(await callback.text(), /Discord vinculado/);
    assert.equal((await request('/api/modules', { headers: { Cookie: cookie } })).status, 401, 'Launcher OAuth does not create a dashboard login');
    const poll = await post('/launcher/poll', { id }, secret); assert.equal(poll.status, 200);
    assert.equal((await post('/launcher/poll', { id }, secret)).status, 410, 'Result can only be consumed once');
    return poll.json();
  }
  return { root, launcher, context, request, post, pair, setStaff: v => staff = v, setPresent: v => present = v, setReady: v => ready = v, advance: ms => clock += ms, clock: () => clock };
}
test('real callback, proof-bound polling and module proxy link Staff without granting dashboard access', async t => {
  const f = await fixture(t, true), result = await f.pair(); assert.equal(result.staff, true);
  const response = await f.request('/launcher/session', { headers: { Authorization: 'Bearer ' + result.token } }); assert.equal((await response.json()).staff, true);
  assert.ok(!fs.readFileSync(path.join(f.root, 'data/sessions.json'), 'utf8').includes(result.token), 'Only hashed session tokens are stored');
});
test('revoked role and guild departure remove Staff; offline Discord returns 503 instead of granting access', async t => {
  const f = await fixture(t), result = await f.pair(), headers = { Authorization: 'Bearer ' + result.token };
  f.setStaff(false); assert.equal((await (await f.request('/launcher/session', { headers })).json()).staff, false);
  f.setPresent(false); assert.equal((await (await f.request('/launcher/session', { headers })).json()).staff, false);
  f.setReady(false); assert.equal((await f.request('/launcher/session', { headers })).status, 503); assert.equal((await f.request('/launcher/health')).status, 503);
});
test('pairing rejects unknown secrets, expires and cannot replay callback state', async t => {
  const f = await fixture(t), begin = await (await f.post('/launcher/link', { challenge })).json();
  assert.equal((await f.post('/launcher/poll', { id: begin.id }, 'b'.repeat(64))).status, 410);
  assert.equal((await f.post('/launcher/poll', { id: begin.id }, secret)).status, 202);
  assert.equal((await f.request('/auth/discord/callback?code=fixture&state=' + 'a'.repeat(64))).status, 302);
  f.advance(300001); assert.equal((await f.post('/launcher/poll', { id: begin.id }, secret)).status, 410);
});
test('sessions survive module restart, expire and can be explicitly revoked', async t => {
  const f = await fixture(t), result = await f.pair(), headers = { Authorization: 'Bearer ' + result.token };
  const restarted = new LauncherService(f.context, { environment: {}, now: f.clock }); assert.ok(Object.keys(restarted.sessions).length === 1);
  assert.equal((await f.request('/launcher/session', { method: 'DELETE', headers })).status, 200);
  assert.equal((await f.request('/launcher/session', { headers })).status, 401);
  const again = await f.pair(); f.advance(31 * 86400000);
  assert.equal((await f.request('/launcher/session', { headers: { Authorization: 'Bearer ' + again.token } })).status, 401);
});
test('ordinary members can link but do not receive Staff; explicit roles override admin fallback', async t => {
  const f = await fixture(t); f.setStaff(false); assert.equal((await f.pair()).staff, false);
  const restricted = new LauncherService(f.context, { environment: { LAUNCHER_STAFF_ROLE_IDS: '523456789012345678' } });
  f.setStaff(true); assert.equal((await restricted.profile(ID, 'test')).staff, false);
});

test('Staff checks use roles in the single configured Discord', async t => {
  const f = await fixture(t);
  const service = new LauncherService(f.context, { environment: { LAUNCHER_STAFF_ROLE_IDS: ROLE } });
  assert.equal((await service.profile(ID, 'staff')).staff, true);
  assert.equal(f.context.guildId, GUILD);
  f.setStaff(false);
  assert.equal((await service.profile(ID, 'staff')).staff, false);
  f.context.client.guilds.cache.delete(GUILD);
  f.context.client.guilds.fetch = async () => null;
  await assert.rejects(service.profile(ID, 'staff'), /Servidor Discord no disponible/);
});
