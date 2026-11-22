const express = require('express');
const path = require('node:path');

function createRouter(service) {
  const router = express.Router();
  router.use(express.json({ limit: '128kb' }));
  router.get('/api/state', async (req, res, next) => {
    try { if (!service.canAccess(req.access?.member)) return res.status(403).json({ error: 'No tienes acceso a esta sección' }); res.json(await service.dashboardState()); }
    catch (error) { next(error); }
  });
  router.put('/api/config', async (req, res, next) => {
    try { if (!service.canManage(req.access?.member)) return res.status(403).json({ error: 'No tienes permiso para configurar sugerencias' }); res.json(await service.updateConfig(req.body?.config || req.body)); }
    catch (error) { next(error); }
  });
  router.post('/api/panel', async (req, res, next) => {
    try { if (!service.canManage(req.access?.member)) return res.status(403).json({ error: 'No tienes permiso para publicar el panel' }); res.json(await service.publishPanel()); }
    catch (error) { next(error); }
  });
  router.post('/api/suggestions/:id/moderate', async (req, res, next) => {
    try { res.json(await service.manageApi(req.access?.member, req.params.id, req.body?.status, req.body?.reason)); }
    catch (error) { next(error); }
  });
  router.delete('/api/suggestions/:id', async (req, res, next) => {
    try { res.json(await service.deleteSuggestion(req.params.id, req.access?.member)); }
    catch (error) { next(error); }
  });
  router.post('/api/blacklist', async (req, res, next) => {
    try { res.json(await service.blacklistAdd(req.body?.userId, req.body?.reason, req.access?.member)); }
    catch (error) { next(error); }
  });
  router.delete('/api/blacklist/:userId', async (req, res, next) => {
    try { await service.blacklistRemove(req.params.userId, req.access?.member); res.json({ ok: true }); }
    catch (error) { next(error); }
  });
  router.get('/dashboard.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.js')));
  router.get('/dashboard.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.css')));
  router.use((error, _req, res, next) => { if (res.headersSent) return next(error); res.status(error.code === 50013 ? 403 : 400).json({ error: String(error.message || 'No se pudo completar la solicitud').slice(0, 240) }); });
  return router;
}

module.exports = { createRouter };
