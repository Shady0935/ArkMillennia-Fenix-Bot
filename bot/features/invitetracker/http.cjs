const express = require('express');
const path = require('node:path');

function createRouter(service) {
  const router = express.Router();
  router.use(express.json({ limit: '32kb' }));
  router.get('/api/guilds', async (_req, res, next) => {
    try { res.json(await service.listGuilds()); } catch (error) { next(error); }
  });
  router.get('/api/config/:guildId', async (req, res, next) => {
    try { res.json(await service.guildState(req.params.guildId)); } catch (error) { next(error); }
  });
  router.put('/api/config/:guildId', async (req, res, next) => {
    try {
      if (!service.canManage(req.access?.member)) return res.status(403).json({ error: 'No tienes permiso para configurar el seguimiento de invitaciones' });
      res.json(await service.updateConfig(req.params.guildId, req.body));
    } catch (error) { next(error); }
  });
  router.get('/dashboard.js', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.js')));
  router.get('/dashboard.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.css')));
  router.use((error, _req, res, _next) => {
    if (!res.headersSent) res.status(400).json({ error: String(error.message || 'No se pudo completar la solicitud').slice(0, 240) });
  });
  return router;
}

module.exports = { createRouter };
