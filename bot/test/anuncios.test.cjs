const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Collection } = require('discord.js');
const { AnnouncementService } = require('../features/anuncios/service.cjs');
const { createPayloads, normalizeBlocks } = require('../features/anuncios/payload.cjs');
const { imageExtension } = require('../features/anuncios/http.cjs');
const { JsonStore } = require('../runtime/json-store.cjs');
const GUILD = '123456789012345678', CHANNEL = '223456789012345678', MESSAGE = '323456789012345678', A = '423456789012345678', B = '523456789012345678';
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'millenniafenix-announcements-'));
  const sent = [], users = new Map(), pages = []; let service;
  const reaction = { emoji: { name: '✅' }, users: { fetch: async args => pages.length ? pages.shift()(args) : new Collection() } };
  const message = { react: async () => {}, reactions: { cache: new Collection([['consent', reaction]]) } };
  const guild = { id: GUILD, ownerId: A, channels: { fetch: async () => ({ messages: { fetch: async () => message } }) },
    members: { fetch: async ({ user }) => {
      if (!users.has(user)) { const error = Error('Gone'); error.code = 10007; throw error; }
      return { user: { bot: false, send: async payload => { sent.push(user); await users.get(user)(payload); } } };
    } } };
  const context = { dataDirectory: directory, guildId: GUILD, client: { guilds: { cache: new Map([[GUILD, guild]]) }, isReady: () => true }, log: () => {}, run: fn => Promise.resolve().then(fn) };
  const environment = { ANNOUNCEMENTS_CHANNEL_ID: CHANNEL, ANNOUNCEMENTS_MESSAGE_ID: MESSAGE };
  service = new AnnouncementService(context, { environment, delay: async () => {}, ...options });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, context, directory, sent, users, pages, guild, reaction, environment };
}
const input = { blocks: [{ type: 'text', content: 'Un anuncio de prueba' }], color: '#8f1d3d' };

test('environment IDs reuse an existing message, partial reaction revocations and unrelated messages are respected', async t => {
  const { service } = fixture(t);
  assert.equal(service.config.mensaje_consentimiento_id, MESSAGE);
  const reaction = { message: { id: MESSAGE, channelId: CHANNEL, guildId: GUILD, partial: true }, emoji: { name: '✅' } };
  await service.reaction(reaction, { id: A, bot: false }, true); assert.ok(service.consents.has(A));
  await service.reaction(reaction, { id: A, bot: false }, false); assert.ok(!service.consents.has(A));
  await service.reaction(reaction, { id: B, bot: true }, true); assert.equal(service.consents.size, 0);
  await service.reaction({ ...reaction, emoji: { name: '❌' } }, { id: A }, true); assert.equal(service.consents.size, 0);
});
test('sync paginates past bots, removes offline revocations and overlays concurrent live changes', async t => {
  const { service, pages } = fixture(t);
  service.consent(B, true);
  const first = new Collection(Array.from({ length: 100 }, (_, i) => [(BigInt(A) + BigInt(i)).toString(), { bot: i === 99 }]));
  pages.push(async args => { assert.equal(args.after, undefined); return first; });
  pages.push(async args => {
    assert.equal(args.after, first.lastKey()); service.consent(A, false); service.consent(B, true);
    return new Collection([['623456789012345678', { bot: false }]]);
  });
  await service.sync(); assert.equal(service.synced, true); assert.ok(!service.consents.has(A)); assert.ok(service.consents.has(B));
  pages.push(async () => new Collection()); await service.sync(); assert.equal(service.consents.size, 0);
});
test('consent must be verified before sending; only current members with consent receive messages', async t => {
  const { service, users, sent } = fixture(t);
  service.consent(A, true); service.consent(B, true);
  assert.throws(() => service.start(input, { id: A }), /sincronicen/);
  service.synced = true; users.set(A, async () => {});
  service.start(input, { id: A }); await service.task;
  assert.deepEqual(sent, [A]); assert.ok(!service.consents.has(B));
  assert.equal(service.state.history[0].enviados, 1); assert.equal(service.state.history[0].fallidos, 1);
  assert.throws(() => service.start(input, { id: A }), /espera/);
});
test('revocation during a campaign skips the recipient and cancellation stops following sends', async t => {
  const { service, users, sent } = fixture(t);
  service.synced = true; service.consent(A, true); service.consent(B, true);
  users.set(A, async () => { service.consent(B, false); }); users.set(B, async () => {});
  service.start(input, { id: A }); await service.task;
  assert.deepEqual(sent, [A]); assert.equal(service.state.history[0].omitidos, 1);
  service.state.lastStartedAt = 0; service.consent(B, true); users.set(A, async () => { service.cancel(); });
  service.start(input, { id: A }); await service.task;
  assert.equal(service.state.history[0].status, 'cancelled'); assert.deepEqual(sent, [A, A]);
});
test('confirmation is actor-bound, expires and cannot be replayed; active campaigns reject a second send', async t => {
  const { service, users } = fixture(t); service.synced = true; service.consent(A, true);
  let release; users.set(A, () => new Promise(resolve => { release = resolve; }));
  const preview = service.preview('Hola', { id: A });
  assert.throws(() => service.confirm(preview.id, { id: B }), /pertenece/);
  service.confirm(preview.id, { id: A }); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => service.start(input, { id: A }), /curso/); assert.throws(() => service.confirm(preview.id, { id: A }), /caducó/);
  release(); await service.task;
});
test('restart marks an incomplete campaign interrupted and never resumes delivery; corrupt stores fail closed', async t => {
  const { service, context, environment, sent, directory } = fixture(t);
  service.state.active = { sendId: 'unfinished', total: 2, procesados: 1, status: 'sending' }; service.saveState();
  const replacement = new AnnouncementService(context, { environment });
  assert.equal(replacement.state.history[0].status, 'interrupted'); assert.equal(replacement.state.active, null); assert.deepEqual(sent, []);
  await replacement.close(); service.state.active = null;
  fs.writeFileSync(path.join(directory, 'consentidos.json'), '{broken');
  assert.throws(() => new AnnouncementService(context, { environment }));
});
test('payloads split long text, keep attachment filenames and reject traversal, unsafe links and excess images', async t => {
  const { directory } = fixture(t), filename = 'a'.repeat(32) + '.png';
  fs.writeFileSync(path.join(directory, filename), 'image');
  const prepared = createPayloads([{ type: 'text', content: 'a'.repeat(12000) }, { type: 'image', url: '/uploads/' + filename }], '#8f1d3d', directory);
  assert.ok(prepared.payloads.length > 1); assert.deepEqual(prepared.uploads, [filename]);
  for (const payload of prepared.payloads) { assert.ok(payload.flags); assert.deepEqual(payload.allowedMentions.parse, []); }
  assert.throws(() => normalizeBlocks([{ type: 'image', url: '/uploads/../../config.json' }]));
  assert.throws(() => normalizeBlocks([{ type: 'button', label: 'x', url: 'javascript:alert(1)' }]));
  assert.throws(() => normalizeBlocks(Array.from({ length: 11 }, () => ({ type: 'image', url: 'https://example.com/image.png' }))));
  assert.throws(() => createPayloads([{ type: 'image', url: '/uploads/' + 'b'.repeat(32) + '.png' }], '#8f1d3d', directory));
});
test('image signatures reject SVG/HTML and cleanup never removes files in use', async t => {
  const { service } = fixture(t);
  assert.equal(imageExtension(Buffer.from([137,80,78,71,13,10,26,10])), 'png');
  assert.throws(() => imageExtension(Buffer.from('<svg onload=alert(1)>')));
  const filename = 'a'.repeat(32) + '.png', full = path.join(service.uploads, filename); fs.writeFileSync(full, 'image');
  fs.utimesSync(full, new Date(0), new Date(0)); service.inUse.add(filename); assert.equal(service.cleanupUploads(), 0);
  service.inUse.clear(); assert.equal(service.cleanupUploads(), 1);
});
test('large galleries split below the Discord request limit and invalid campaign payloads do not revoke consent', async t => {
  const { directory, service, users, sent } = fixture(t);
  const images = Array.from({ length: 5 }, (_, index) => {
    const name = String(index).repeat(32) + '.png'; fs.writeFileSync(path.join(directory, name), ''); fs.truncateSync(path.join(directory, name), 8 * 1048576); return '/uploads/' + name;
  });
  const prepared = createPayloads([{ type: 'gallery', images }], '#8f1d3d', directory);
  assert.equal(prepared.payloads.length, 2);
  for (const payload of prepared.payloads) assert.ok(payload.files.length <= 3);
  service.synced = true; service.consent(A, true); service.consent(B, true);
  users.set(A, async () => { const error = Error('Invalid payload'); error.code = 50035; throw error; }); users.set(B, async () => {});
  service.start(input, { id: A }); await service.task;
  assert.deepEqual(sent, [A]); assert.equal(service.state.history[0].status, 'failed');
  assert.equal(service.failures[A], undefined); assert.ok(service.consents.has(A)); assert.ok(service.consents.has(B));
});
test('JSON store rejects corrupt state instead of silently losing subscriptions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'millenniafenix-store-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory); store.write('data.json', { test: true }); assert.deepEqual(store.read('data.json', {}), { test: true });
  assert.throws(() => store.read('../config.json', {})); fs.writeFileSync(path.join(directory, 'data.json'), '{'); assert.throws(() => store.read('data.json', {}));
});
