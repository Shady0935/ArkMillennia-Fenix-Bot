const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const { AnnouncementService } = require('../features/anuncios/service.cjs');
const { createPayloads, normalizeBlocks } = require('../features/anuncios/payload.cjs');

const ids = {
  guild: '123456789012345678', channel: '223456789012345678', message: '323456789012345678',
  user: '423456789012345678', nextChannel: '523456789012345678', nextMessage: '623456789012345678',
};
const filename = 'a'.repeat(32) + '.png';

function fixture(t, { draft = null } = {}) {
  const records = new Map();
  if (draft) records.set(`draft:${ids.user}`, draft);
  const blobs = new Map([[filename, { contentType: 'image/png', data: Buffer.from('image'), updatedAt: new Date(0) }]]);
  const storage = {
    get: async (key, fallback = null) => records.has(key) ? structuredClone(records.get(key)) : structuredClone(fallback),
    set: async (key, value) => { records.set(key, structuredClone(value)); return value; },
    entries: async () => [...records.entries()],
    listBlobs: async () => [...blobs.entries()].map(([key, value]) => ({ key, bytes: value.data.length, updatedAt: value.updatedAt })),
    getBlob: async key => blobs.get(key) ?? null,
    deleteBlob: async key => blobs.delete(key),
  };
  const sent = [], fetchedUsers = [];
  const message = {
    id: ids.nextMessage, channelId: ids.nextChannel, guildId: ids.guild, reactions: { cache: new Collection() },
    react: async emoji => message.reactions.cache.set('consent', { emoji: { name: emoji }, users: { fetch: async () => new Collection() } }),
  };
  const channel = { guildId: ids.guild, messages: { fetch: async () => message } };
  const guild = { channels: { fetch: async () => channel } };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[ids.guild, guild]]) },
    users: { fetch: async id => { fetchedUsers.push(id); return { id, bot: false, send: async payload => sent.push({ id, payload }) }; } },
  };
  const context = { client, guildId: ids.guild, storage, log: () => {}, run: fn => Promise.resolve().then(fn) };
  const service = new AnnouncementService(context, { environment: {
    ANNOUNCEMENTS_CHANNEL_ID: ids.channel, ANNOUNCEMENTS_MESSAGE_ID: ids.message,
  } });
  t.after(() => service.close());
  return { service, storage, records, blobs, sent, fetchedUsers };
}

test('image deletion removes the DB blob and protects files used by saved drafts', async t => {
  const { service, records, blobs } = fixture(t, {
    draft: { blocks: [{ type: 'image', url: `/uploads/${filename}` }], color: '#ffffff' },
  });
  await service.initialize();
  assert.equal((await service.uploadsInfo()).files[0].inDraft, true);
  assert.equal(await service.cleanupUploads(0), 0);
  await assert.rejects(service.deleteUpload(filename), error => error.statusCode === 409);
  records.delete(`draft:${ids.user}`);
  assert.equal(await service.deleteUpload(filename), true);
  assert.equal(blobs.has(filename), false);
  assert.equal(await service.deleteUpload(filename), false);
});

test('dashboard consent source persists and test delivery targets only the authenticated user', async t => {
  const { service, records, sent, fetchedUsers } = fixture(t);
  await service.initialize();
  const result = await service.setConsentSource({ channelId: ids.nextChannel, messageId: ids.nextMessage, emoji: '✅' });
  assert.equal(result.users, 0);
  assert.equal(records.get('config').mensaje_consentimiento_id, ids.nextMessage);

  const reloaded = new AnnouncementService(service.context, { environment: {
    ANNOUNCEMENTS_CHANNEL_ID: ids.channel, ANNOUNCEMENTS_MESSAGE_ID: ids.message,
  } });
  await reloaded.initialize();
  assert.equal(reloaded.config.mensaje_consentimiento_id, ids.nextMessage);

  const delivery = await service.sendTest({ blocks: [{ type: 'text', content: 'Preview' }], color: '#ffffff' }, { id: ids.user });
  assert.equal(delivery.ok, true);
  assert.deepEqual(fetchedUsers, [ids.user]);
  assert.deepEqual(sent.map(item => item.id), [ids.user]);
  assert.equal(service.state.history.length, 0);
  await reloaded.close();
});

test('test delivery holds uploaded images until its direct message completes', async t => {
  const { service } = fixture(t);
  let finishSend;
  service.client.users.fetch = async id => ({ id, bot: false, send: async () => new Promise(resolve => { finishSend = resolve; }) });
  const pending = service.sendTest({ blocks: [{ type: 'image', url: `/uploads/${filename}` }], color: '#ffffff' }, { id: ids.user });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.inUse.has(filename), true);
  await assert.rejects(service.deleteUpload(filename), error => error.statusCode === 409);
  finishSend();
  await pending;
  assert.equal(service.inUse.has(filename), false);
});

test('simultaneous sends retain uploaded images until the final send releases them', async t => {
  const { service } = fixture(t);
  service.reserveUploads([filename]);
  service.reserveUploads([filename]);
  service.releaseUploads([filename]);
  assert.equal(service.inUse.get(filename), 1);
  await assert.rejects(service.deleteUpload(filename), error => error.statusCode === 409);
  service.releaseUploads([filename]);
  assert.equal(service.inUse.has(filename), false);
});

test('test announcements may run while a mass campaign is active', async t => {
  const { service, sent } = fixture(t);
  service.state.active = { sendId: 'active-campaign', status: 'sending' };
  const result = await service.sendTest({ blocks: [{ type: 'text', content: 'Preview' }], color: '#ffffff' }, { id: ids.user });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
});

test('payload pagination preserves all images and enforces the twenty image limit', async t => {
  const { service } = fixture(t);
  const images = Array.from({ length: 12 }, (_, index) => `https://example.com/${index}.png`);
  const prepared = await createPayloads([{ type: 'gallery', images }], '#ffffff', service.storage);
  assert.equal(prepared.payloads.length, 2);
  assert.equal(prepared.imageCount, 12);
  assert.deepEqual(prepared.payloads.map(page => page.page), [{ index: 1, total: 2 }, { index: 2, total: 2 }]);
  assert.match(JSON.stringify(prepared.payloads[0].components), /Mensaje 1 de 2/);
  assert.throws(() => normalizeBlocks([{ type: 'gallery', images: Array.from({ length: 21 }, (_, i) => `https://example.com/${i}.png`) }]));
});
