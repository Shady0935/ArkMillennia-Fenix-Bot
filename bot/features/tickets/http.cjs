const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');

const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const imageExtension = buffer => {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw Error('La imagen debe ser PNG, JPEG, GIF o WebP');
};

function createRouter(service) {
  const router = express.Router();
  router.use(express.json({ limit: '128kb' }));
  router.get('/api/state', async (req, res, next) => {
    try {
      if (!service.canAccess(req.access?.member)) return res.status(403).json({ error: 'No tienes acceso a esta sección' });
      res.json(await service.dashboardState());
    } catch (error) { next(error); }
  });
  router.put('/api/config', async (req, res, next) => {
    try {
      if (!service.canManage(req.access?.member)) return res.status(403).json({ error: 'No tienes permiso para configurar los tickets' });
      res.json(await service.updateConfig(req.body?.config || req.body));
    } catch (error) { next(error); }
  });
  router.post('/api/panel-image', (req, res, next) => {
    if (!service.canManage(req.access?.member)) return res.status(403).json({ error: 'No tienes permiso para cambiar la imagen del panel' });
    multer({ storage: multer.memoryStorage(), limits: { fileSize: IMAGE_LIMIT, files: 1 },
      fileFilter: (_request, file, callback) => callback(null, Object.values(IMAGE_MIME).includes(file.mimetype)) }).single('image')(req, res, error => {
      (async () => {
        if (error) throw error;
        if (!req.file) throw Error('Selecciona una imagen PNG, JPEG, GIF o WebP');
        const extension = imageExtension(req.file.buffer);
        const name = `${crypto.randomBytes(16).toString('hex')}.${extension}`;
        const previous = service.config.panelImageName;
        await service.storage.setBlob(`panel-image:${name}`, req.file.buffer, IMAGE_MIME[extension]);
        service.config.panelImageName = name;
        await service.storage.set('config', service.config);
        if (previous && previous !== name) await service.storage.deleteBlob(`panel-image:${previous}`).catch(() => {});
        res.json({ name, panelImageName: name });
      })().catch(next);
    });
  });
  router.get('/api/panel-image', async (_req, res, next) => {
    try {
      const name = service.config.panelImageName;
      if (!name) return res.sendStatus(404);
      const image = await service.storage.getBlob(`panel-image:${name}`);
      if (!image) return res.sendStatus(404);
      res.set({ 'Content-Type': image.contentType, 'Content-Length': String(image.data.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300' }).send(image.data);
    } catch (error) { next(error); }
  });
  router.delete('/api/panel-image', async (req, res, next) => {
    try {
      if (!service.canManage(req.access?.member)) return res.status(403).json({ error: 'No tienes permiso para quitar la imagen del panel' });
      const previous = service.config.panelImageName;
      service.config.panelImageName = '';
      await service.storage.set('config', service.config);
      if (previous) await service.storage.deleteBlob(`panel-image:${previous}`);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  router.post('/api/panel', async (req, res, next) => {
    try {
      if (!service.canManage(req.access?.member)) return res.status(403).json({ error: 'No tienes permiso para publicar el panel' });
      res.json(await service.publishPanel());
    } catch (error) { next(error); }
  });
  router.post('/api/tickets/:channelId/action', async (req, res, next) => {
    try { res.json(await service.manageTicket(req.params.channelId, req.body?.action, req.access?.member)); }
    catch (error) { next(error); }
  });
  router.get('/api/tickets/:channelId/transcript', async (req, res, next) => {
    try {
      const transcript = await service.transcript(req.params.channelId, req.access?.member);
      if (!transcript?.data) return res.status(404).json({ error: 'No hay una transcripción disponible' });
      res.type('html').set('Content-Disposition', `inline; filename="ticket-${req.params.channelId}.html"`).send(transcript.data);
    } catch (error) { next(error); }
  });
  router.get('/api/tickets/:channelId/attachments/:attachmentId', async (req, res, next) => {
    try {
      const url = await service.archivedAttachmentUrl(req.params.channelId, req.params.attachmentId, req.access?.member);
      if (!url) return res.status(404).json({ error: 'No se encontró el adjunto archivado' });
      res.redirect(302, url);
    } catch (error) { next(error); }
  });
  router.get('/dashboard.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.js')));
  router.get('/dashboard.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.css')));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.code === 10003 || error.code === 10004 ? 404 : error.code === 50013 ? 403 : 400;
    res.status(status).json({ error: String(error.message || 'No se pudo completar la solicitud').slice(0, 240) });
  });
  return router;
}

module.exports = { createRouter };
