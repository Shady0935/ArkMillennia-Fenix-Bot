const { LauncherService } = require('../features/launcher/service.cjs');
module.exports = {
  version: '1.0.0',
  async setup(context) {
    const service = await new LauncherService(context).initialize();
    context.provide('launcher', service);
    context.every(60000, () => service.cleanup());
  },
};
