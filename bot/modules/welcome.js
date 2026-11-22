const { Events } = require('discord.js');
const { WelcomeService } = require('../features/welcome/service.cjs');
const { createRouter } = require('../features/welcome/http.cjs');

module.exports = {
  version: '1.0.0',
  async setup(context) {
    const service = await new WelcomeService(context).initialize();
    const router = createRouter(service);
    context.provide('welcome', service);
    context.provide('dashboard:welcome', {
      title: 'Comunidad',
      description: 'Configura bienvenidas, despedidas, roles automáticos y verificación',
      icon: 'campaign',
      order: 5,
      client: 'dashboard.js',
      styles: ['dashboard.css'],
      canAccess: member => !!context.dashboardRoleId && member?.roles?.cache?.has(context.dashboardRoleId),
      http: (req, res, next) => router(req, res, next),
    });
    context.on(Events.GuildMemberAdd, member => service.onMemberAdd(member));
    context.on(Events.GuildMemberRemove, member => service.onMemberRemove(member));
    context.on(Events.InteractionCreate, interaction => service.onInteraction(interaction));
  },
};
