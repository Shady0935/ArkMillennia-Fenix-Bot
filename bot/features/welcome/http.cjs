const express = require('express');
const path = require('node:path');

function createRouter(service) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.get('/dashboard.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.js')));
  router.get('/dashboard.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.css')));
  router.get('/api/resources', async (_req, res, next) => {
    try { res.json(await service.resources()); } catch (error) { next(error); }
  });
  router.get('/api/config', (_req, res) => res.json(service.config));
  router.put('/api/config', async (req, res, next) => {
    try { res.json({ ok: true, config: await service.save(req.body ?? {}) }); } catch (error) { next(error); }
  });
  router.post('/api/test/:kind', async (req, res, next) => {
    try { res.json(await service.test(req.params.kind, req.session.user.id)); } catch (error) { next(error); }
  });
  router.post('/api/verification/publish', async (_req, res, next) => {
    try { res.json(await service.setupVerification()); } catch (error) { next(error); }
  });
  router.use((error, _req, res, _next) => {
    if (!res.headersSent) res.status(Number.isInteger(error.statusCode) ? error.statusCode : 400)
      .json({ error: String(error.message || 'No se pudo completar la solicitud').slice(0, 220) });
  });
  return router;
}

module.exports = { createRouter };
