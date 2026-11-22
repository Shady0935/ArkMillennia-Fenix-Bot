const express = require('express');
const { CATEGORIES } = require('./service.cjs');

const SNOWFLAKE = /^[0-9]{17,20}$/;

function createRouter(service) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.get('/api/guilds', async (_req, res, next) => {
    try { res.json(await service.listGuilds()); } catch (error) { next(error); }
  });
  router.get('/api/config/:guildId', (req, res, next) => {
    try {
      if (!SNOWFLAKE.test(req.params.guildId) || !service.client.guilds.cache.has(req.params.guildId)) throw Error('Servidor no disponible para este bot');
      res.json({ categories: CATEGORIES, config: service.getConfig(req.params.guildId) });
    } catch (error) { next(error); }
  });
  router.put('/api/config/:guildId', async (req, res, next) => {
    try { res.json({ config: await service.updateConfig(req.params.guildId, req.body) }); } catch (error) { next(error); }
  });
  router.get('/dashboard.js', (_req, res) => res.sendFile(require('node:path').join(__dirname, 'public', 'dashboard.js')));
  router.get('/dashboard.css', (_req, res) => res.sendFile(require('node:path').join(__dirname, 'public', 'dashboard.css')));
  router.use((error, _req, res, _next) => {
    if (!res.headersSent) res.status(400).json({ error: String(error.message || 'No se pudo actualizar la configuración').slice(0, 240) });
  });
  return router;
}

module.exports = { createRouter };
