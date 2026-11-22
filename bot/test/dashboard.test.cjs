const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DashboardSystem } = require('../dashboard/system.cjs');
const { createHttp } = require('../features/anuncios/http.cjs');
const { AnnouncementService } = require('../features/anuncios/service.cjs');
const ID = '123456789012345678', GUILD = '223456789012345678';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'millenniafenix-dashboard-')), providers = new Map();
  const guild = { id: GUILD, ownerId: ID };
  let allowed = true;
  const member = { id: ID, guild, roles: { cache: new Map() }, permissions: { has: () => allowed } };
  guild.members = { fetch: async () => member };
  const client = { user: { id: '323456789012345678' }, isReady: () => true, guilds: { cache: new Map([[GUILD, guild]]) } };
  const dashboard = new DashboardSystem({ root: path.join(directory, 'bot'), client, guildId: GUILD, adminRoleIds: [],
    services: { list: () => [...providers.keys()].map(name => ({ name })), get: name => providers.get(name) }, log: () => {},
    environment: () => ({ DASHBOARD_ENABLED: 'true', DASHBOARD_PORT: '0', DASHBOARD_HOST: '127.0.0.1', DASHBOARD_PUBLIC_URL: 'http://localhost', DISCORD_OAUTH_CLIENT_SECRET: 'test-only-secret' }),
    fetch: async url => url.includes('/oauth2/token') ? { ok: true, json: async () => ({ access_token: 'test-access-token' }) } : { ok: true, json: async () => ({ id: ID, username: 'ArkMillennia Fenix Admin' }) },
  });
  providers.set('dashboard:demo', { title: 'Demo', description: 'Module', canAccess: () => allowed, http: async (req, res) => res.json({ feature: 'demo' }) });
  await dashboard.start();
  t.after(async () => { await dashboard.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  let cookie = '', csrf = '';
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${dashboard.info().port}` + route, { redirect: 'manual', ...options,
    headers: { Cookie: cookie, Origin: 'http://localhost', 'X-CSRF-Token': csrf, ...options.headers } });
  const login = async () => {
    const start = await request('/auth/discord'); assert.equal(start.status, 302);
    cookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request('/auth/discord/callback?' + new URLSearchParams({ state, code: 'test-code' })); assert.equal(callback.status, 302);
    cookie = callback.headers.get('set-cookie').split(';')[0];
    const me = await (await request('/api/me')).json(); csrf = me.csrf; assert.equal(me.loggedIn, true);
    return state;
  };
  return { dashboard, providers, request, login, client, directory, deny: () => { allowed = false; } };
}
test('dashboard requires Discord login, verifies state, rotates the session and protects mutations with CSRF', async t => {
  const { request, login } = await fixture(t);
  assert.equal((await request('/extensions/demo/')).status, 401);
  assert.equal((await request('/api/me')).status, 200);
  const invalid = await request('/auth/discord/callback?code=test&state=wrong'); assert.match(invalid.headers.get('location'), /oauth_state/);
  const state = await login();
  assert.deepEqual(await (await request('/extensions/demo/')).json(), { feature: 'demo' });
  assert.equal((await request('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await request('/api/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  const replay = await request('/auth/discord/callback?' + new URLSearchParams({ state, code: 'test-code' })); assert.match(replay.headers.get('location'), /oauth_state/);
  assert.equal((await request('/api/logout', { method: 'POST' })).status, 200);
  assert.equal((await request('/api/modules')).status, 401);
});
test('dashboard discovers features dynamically, denies revoked permissions and restarts independently', async t => {
  const { dashboard, providers, request, login, deny } = await fixture(t); await login();
  assert.equal((await (await request('/api/modules')).json()).length, 1);
  providers.set('dashboard:future', { title: 'Future', description: 'A new feature', canAccess: () => true, http: async (req, res) => res.json({ ok: true }) });
  assert.equal((await (await request('/api/modules')).json()).length, 2);
  providers.delete('dashboard:demo'); assert.equal((await request('/extensions/demo/')).status, 403);
  await dashboard.reload(); assert.equal(dashboard.info().listening, true); assert.equal((await request('/api/modules')).status, 200);
  providers.delete('dashboard:future'); deny();
  // Owner remains a dashboard administrator but does not inherit feature permission.
  assert.deepEqual(await (await request('/api/modules')).json(), []);
});
test('authenticated announcement HTTP stores validated images, rejects active uploads deletion and returns persisted history', async t => {
  const { providers, request, login, directory, client } = await fixture(t);
  const service = new AnnouncementService({ client, guildId: GUILD, dataDirectory: path.join(directory, 'anuncios'), log: () => {}, run: task => Promise.resolve().then(task) }, { environment: {} });
  t.after(() => service.close()); providers.set('dashboard:anuncios', { title: 'Anuncios', description: 'Test', canAccess: () => true, http: createHttp(service) });
  await login();
  const invalid = new FormData(); invalid.append('images', new Blob(['<svg onload=alert(1)>'], { type: 'image/png' }), 'x.png');
  assert.equal((await request('/extensions/anuncios/api/upload', { method: 'POST', body: invalid })).status, 400);
  const valid = new FormData(); valid.append('images', new Blob([Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])], { type: 'image/png' }), 'x.png');
  const response = await request('/extensions/anuncios/api/upload', { method: 'POST', body: valid }); assert.equal(response.status, 200);
  const result = await response.json(), url = result.files[0].url; assert.match(url, /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.equal((await request('/extensions/anuncios' + url)).status, 200);
  service.inUse.add(result.files[0].name);
  assert.equal((await request('/extensions/anuncios/api/upload/' + result.files[0].name, { method: 'DELETE' })).status, 400);
  service.inUse.clear(); assert.equal((await request('/extensions/anuncios/api/upload/' + result.files[0].name, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await request('/extensions/anuncios/api/history')).json(), []);
  assert.equal((await request('/extensions/anuncios/api/announcement', { method: 'POST', body: JSON.stringify({ blocks: [{ type: 'text', content: 'x' }] }), headers: { 'Content-Type': 'application/json' } })).status, 400);
});
