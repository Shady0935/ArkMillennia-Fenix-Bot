const { Events, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { SuggestionsService } = require('../features/suggestions/service.cjs');
const { createRouter } = require('../features/suggestions/http.cjs');

const command = new SlashCommandBuilder().setName('sugerencias').setDescription('Modera las sugerencias de ArkMillennia Fenix')
  .addSubcommand(s => s.setName('aceptar').setDescription('Acepta una sugerencia').addStringOption(o => o.setName('id').setDescription('ID de la sugerencia').setRequired(true)))
  .addSubcommand(s => s.setName('denegar').setDescription('Deniega una sugerencia').addStringOption(o => o.setName('id').setDescription('ID de la sugerencia').setRequired(true)).addStringOption(o => o.setName('motivo').setDescription('Motivo visible para la comunidad').setMaxLength(300)))
  .addSubcommand(s => s.setName('bloquear').setDescription('Bloquea a una persona para que no envíe sugerencias').addUserOption(o => o.setName('usuario').setDescription('Persona').setRequired(true)).addStringOption(o => o.setName('motivo').setDescription('Motivo').setMaxLength(300)))
  .addSubcommand(s => s.setName('desbloquear').setDescription('Retira a una persona de la lista de bloqueo').addUserOption(o => o.setName('usuario').setDescription('Persona').setRequired(true)));

module.exports = {
  version: '1.0.0',
  commands: [
    { data: new SlashCommandBuilder().setName('sugerir').setDescription('Envía una sugerencia al equipo de ArkMillennia Fenix'), execute: async (interaction, context) => {
      const service = context.services.get('suggestions');
      if (!service) throw Error('El módulo de sugerencias no está disponible');
      return service.handleInteraction(interaction);
    } },
    { data: command, execute: async (interaction, context) => {
      const service = context.services.get('suggestions');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!service.canManage(member)) throw Error('No tienes permiso para moderar sugerencias');
        const action = interaction.options.getSubcommand();
        if (action === 'aceptar' || action === 'denegar') {
          const result = await service.moderate(interaction.options.getString('id'), action === 'aceptar' ? 'accepted' : 'denied', member, interaction.options.getString('motivo') || '');
          return interaction.editReply(`Sugerencia ${result.id}: ${action === 'aceptar' ? 'aceptada' : 'denegada'}.`);
        }
        const user = interaction.options.getUser('usuario');
        if (action === 'bloquear') { await service.blacklistAdd(user.id, interaction.options.getString('motivo') || '', member); return interaction.editReply(`${user.username} fue añadido a la lista de bloqueo.`); }
        await service.blacklistRemove(user.id, member); return interaction.editReply(`${user.username} fue retirado de la lista de bloqueo.`);
      } catch (error) { return interaction.editReply({ content: String(error.message || 'No se pudo completar la moderación').slice(0, 1500), allowedMentions: { parse: [] } }); }
    } },
  ],
  async setup(context) {
    const service = await new SuggestionsService(context).initialize(), router = createRouter(service);
    context.provide('suggestions', service);
    context.provide('dashboard:suggestions', { title: 'Sugerencias', description: 'Personaliza el buzón, revisa propuestas y modera votos', icon: 'lightbulb', order: 55,
      client: 'dashboard.js', styles: ['dashboard.css'], canAccess: member => service.canAccess(member), http: (req, res, next) => router(req, res, next) });
    context.on(Events.InteractionCreate, interaction => service.handleInteraction(interaction));
    context.on(Events.ClientReady, () => {
      if (service.voteDisplayMigrationRequired) {
        service.refreshSuggestionMessages().catch(error => context.log(`No se pudo migrar la presentación de votos (${error.code || error.name})`));
      }
    });
    context.onClose(() => service.close());
  },
};
