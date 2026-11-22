const { RoleManagerService } = require('../features/rolemanager/service.cjs');

module.exports = {
  version: '1.0.0',
  async setup(context) {
    const service = new RoleManagerService(context), router = service.router();
    context.provide('rolemanager', service);
    context.provide('dashboard:rolemanager', {
      title: 'Administrar rangos',
      description: 'Busca miembros y administra rangos en el Discord de ArkMillennia Fenix',
      icon: 'group',
      order: 15,
      client: 'dashboard.js',
      styles: ['dashboard.css'],
      canAccess: member => context.dashboardRoleIds.some(roleId => member?.roles?.cache?.has(roleId)),
      http: (req, res, next) => router(req, res, next),
    });
  },
};

