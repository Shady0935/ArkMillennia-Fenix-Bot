const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const SAFE_FILE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const QUOTA = 256 * 1024 * 1024;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const CHUNK_SIZE = 384 * 1024;
const UPLOAD_TTL = 30 * 60 * 1000;
function imageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw Error('Formato de imagen no permitido (PNG, JPEG, GIF o WebP)');
}
const mime = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function createHttp(service) {
  const router = express.Router();
  const chunkUploads = new Map();
  let uploadLock = null;
  const acquireUpload = () => {
    if (uploadLock) return null;
    const lock = {};
    lock.timer = setTimeout(() => releaseUpload(lock), UPLOAD_TTL);
    lock.timer.unref?.();
    uploadLock = lock;
    service.uploading = true;
    return lock;
  };
  const releaseUpload = lock => {
    if (uploadLock !== lock) return;
    clearTimeout(lock.timer);
    uploadLock = null;
    service.uploading = false;
  };
  router.use(express.json({ limit: '256kb' }));
  router.get('/api/consents', (req, res) => res.json({ total: service.consents.size, synced: service.synced }));
  router.get('/api/config', (req, res) => res.json({ channelId: service.config.canal_consentimiento_id, messageId: service.config.mensaje_consentimiento_id,
    emoji: service.config.emoji_consentimiento, adminRoleId: service.config.admin_role_id }));
  router.put('/api/config', async (req, res, next) => {
    try { res.json(await service.setConsentSource(req.body ?? {})); } catch (error) { next(error); }
  });
  router.post('/api/sync', async (req, res, next) => { try { res.json(await service.sync()); } catch (error) { next(error); } });
  router.get('/api/announcement/status', (req, res) => res.json(service.status()));
  router.post('/api/announcement', async (req, res, next) => { try { res.json(await service.start(req.body, req.session.user)); } catch (error) { next(error); } });
  router.post('/api/announcement/test', async (req, res, next) => { try { res.json(await service.sendTest(req.body, req.session.user)); } catch (error) { next(error); } });
  router.post('/api/announcement/cancel', (req, res) => res.json({ ok: service.cancel() }));
  router.get('/api/announcement/:id/progress', (req, res) => {
    if (!service.progress(req.params.id)) return res.status(404).json({ error: 'Anuncio no encontrado' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    let timer;
    const update = () => {
      const value = service.progress(req.params.id);
      if (!value) { clearInterval(timer); res.end(); return; }
      res.write(`data: ${JSON.stringify(value)}\n\n`);
      if (value.done) { clearInterval(timer); res.end(); }
    };
    timer = setInterval(update, 1000); update(); res.once('close', () => clearInterval(timer));
  });
  router.get('/api/history', (req, res) => res.json(structuredClone(service.state.history)));
  router.get('/api/uploads/info', async (req, res, next) => { try { res.json(await service.uploadsInfo()); } catch (error) { next(error); } });
  router.get('/api/draft', async (req, res, next) => {
    try { res.json(await service.storage.get(`draft:${req.session.user.id}`, null)); } catch (error) { next(error); }
  });
  router.put('/api/draft', async (req, res, next) => {
    try {
      const draft = req.body;
      if (!draft || typeof draft !== 'object' || !Array.isArray(draft.blocks) || draft.blocks.length > 20
        || typeof draft.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(draft.color)) throw Error('Borrador inválido');
      await service.storage.set(`draft:${req.session.user.id}`, { blocks: draft.blocks, color: draft.color, updatedAt: Date.now() });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  router.delete('/api/draft', async (req, res, next) => {
    try { await service.storage.delete(`draft:${req.session.user.id}`); res.json({ ok: true }); } catch (error) { next(error); }
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_SIZE, files: 10, fields: 2, parts: 12 },
    fileFilter: (req, file, callback) => callback(null, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimetype)) });
  const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CHUNK_SIZE, files: 1, fields: 0, parts: 1 } });
  const clearChunkUpload = (id, state) => {
    if (chunkUploads.get(id) !== state) return;
    clearTimeout(state.timer); chunkUploads.delete(id); state.chunks.length = 0;
    releaseUpload(state.lock);
  };
  router.post('/api/upload/start', async (req, res, next) => {
    if (uploadLock || service.uploading) return res.status(409).json({ error: 'Ya hay una subida en curso' });
    const size = req.body?.size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_SIZE) return res.status(400).json({ error: 'La imagen debe pesar hasta 8 MiB' });
    const lock = acquireUpload();
    if (!lock) return res.status(409).json({ error: 'Ya hay una subida en curso' });
    try {
      const info = await service.uploadsInfo();
      if (info.totalSize + size > QUOTA) throw Error('Se alcanzó el límite de 256 MiB de imágenes; limpia archivos antiguos');
      const id = crypto.randomBytes(16).toString('hex');
      const state = { owner: req.session.user.id, size, chunks: [], received: 0, timer: null, lock };
      state.timer = setTimeout(() => clearChunkUpload(id, state), UPLOAD_TTL); state.timer.unref?.();
      chunkUploads.set(id, state);
      res.json({ uploadId: id, chunkSize: CHUNK_SIZE });
    } catch (error) {
      releaseUpload(lock); next(error);
    }
  });
  router.put('/api/upload/:id/chunk/:index', (req, res, next) => {
    const id = req.params.id, state = chunkUploads.get(id), index = Number(req.params.index);
    if (!/^[a-f0-9]{32}$/.test(id) || !state || state.owner !== req.session.user.id) return res.status(404).json({ error: 'Subida no encontrada o caducada' });
    if (!Number.isInteger(index) || index !== state.chunks.length || state.busy) return res.status(409).json({ error: 'Fragmento fuera de orden' });
    state.busy = true;
    chunkUpload.single('chunk')(req, res, error => {
      if (error) { clearChunkUpload(id, state); return next(error); }
      if (!req.file) { clearChunkUpload(id, state); return res.status(400).json({ error: 'Falta un fragmento de imagen' }); }
      const expected = Math.min(CHUNK_SIZE, state.size - state.received);
      if (req.file.size !== expected) { clearChunkUpload(id, state); return res.status(400).json({ error: 'El tamaño del fragmento no coincide' }); }
      state.chunks.push(req.file.buffer); state.received += req.file.size;
      state.busy = false;
      res.json({ received: state.received, size: state.size });
    });
  });
  router.post('/api/upload/:id/complete', async (req, res, next) => {
    const id = req.params.id, state = chunkUploads.get(id);
    if (!/^[a-f0-9]{32}$/.test(id) || !state || state.owner !== req.session.user.id) return res.status(404).json({ error: 'Subida no encontrada o caducada' });
    if (state.busy) return res.status(409).json({ error: 'Espera a que termine el fragmento actual' });
    try {
      if (state.received !== state.size) throw Error('La imagen todavía no se ha cargado por completo');
      const buffer = Buffer.concat(state.chunks, state.size), extension = imageExtension(buffer);
      const name = crypto.randomBytes(16).toString('hex') + '.' + extension;
      await service.storage.setBlob(name, buffer, mime[extension]);
      res.json({ files: [{ url: '/uploads/' + name, name }] });
    } catch (error) { next(error); }
    finally { clearChunkUpload(id, state); }
  });
  router.post('/api/upload/:id/cancel', (req, res) => {
    const id = req.params.id, state = chunkUploads.get(id);
    if (!state || state.owner !== req.session.user.id) return res.status(404).json({ error: 'Subida no encontrada o caducada' });
    if (state.busy) return res.status(409).json({ error: 'Espera a que termine el fragmento actual' });
    clearChunkUpload(id, state); res.json({ ok: true });
  });
  router.post('/api/upload', (req, res, next) => {
    if (uploadLock || service.uploading) return res.status(409).json({ error: 'Ya hay una subida en curso' });
    const lock = acquireUpload();
    if (!lock) return res.status(409).json({ error: 'Ya hay una subida en curso' });
    const releaseAbandoned = () => { if (req.aborted || (!req.complete && res.destroyed)) releaseUpload(lock); };
    req.once('aborted', releaseAbandoned);
    res.once('close', releaseAbandoned);
    upload.array('images', 10)(req, res, error => {
      (async () => {
        if (error) throw error;
        if (!req.files?.length) throw Error('Selecciona imágenes PNG, JPEG, GIF o WebP');
        const files = req.files.map(file => {
          const extension = imageExtension(file.buffer);
          return { buffer: file.buffer, name: crypto.randomBytes(16).toString('hex') + '.' + extension, contentType: mime[extension] };
        });
        const info = await service.uploadsInfo();
        if (info.totalSize + files.reduce((sum, file) => sum + file.buffer.length, 0) > QUOTA) throw Error('Se alcanzó el límite de 256 MiB de imágenes; limpia archivos antiguos');
        for (const file of files) await service.storage.setBlob(file.name, file.buffer, file.contentType);
        res.json({ files: files.map(file => ({ url: '/uploads/' + file.name, name: file.name })) });
      })().catch(next).finally(() => {
        req.off('aborted', releaseAbandoned);
        res.off('close', releaseAbandoned);
        releaseUpload(lock);
      });
    });
  });
  router.delete('/api/upload/:name', async (req, res, next) => {
    try {
      if (!SAFE_FILE.test(req.params.name)) throw Error('Nombre de imagen inválido');
      if (!await service.deleteUpload(req.params.name)) return res.status(404).json({ error: 'La imagen ya no existe' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  router.post('/api/uploads/cleanup-old', async (req, res, next) => { try { res.json({ removed: await service.cleanupUploads() }); } catch (error) { next(error); } });
  router.get('/uploads/:name', async (req, res, next) => {
    try {
      if (!SAFE_FILE.test(req.params.name)) return res.sendStatus(404);
      const file = await service.storage.getBlob(req.params.name);
      if (!file) return res.sendStatus(404);
      res.set({ 'Content-Type': file.contentType, 'Content-Length': String(file.data.length), 'X-Content-Type-Options': 'nosniff' }).send(file.data);
    } catch (error) { next(error); }
  });
  router.use(express.static(require('node:path').join(__dirname, 'public'), { dotfiles: 'deny' }));
  router.use((error, req, res, next) => { if (!res.headersSent) res.status(Number.isInteger(error.statusCode) ? error.statusCode : 400).json({ error: String(error.message).slice(0, 250) }); });
  return (req, res, next) => new Promise((resolve, reject) => {
    const done = () => { res.off('finish', done); res.off('close', done); resolve(); };
    res.once('finish', done); res.once('close', done);
    router(req, res, error => { done(); if (error) reject(error); else next(); });
  });
}
module.exports = { createHttp, imageExtension };
