const { Events, SlashCommandBuilder, MessageFlags } = require('discord.js');
const { InviteTrackerService } = require('../features/invitetracker/service.cjs');
const { createRouter } = require('../features/invitetracker/http.cjs');

const invitesCommand = new SlashCommandBuilder().setName('invites').setDescription('Consulta quién invitó a una persona y sus invitaciones')
  .addUserOption(option => option.setName('usuario').setDescription('Persona que quieres consultar'));

module.exports = {
  version: '1.0.0',
  commands: [{ data: invitesCommand, execute: async (interaction, context) => {
    const service = context.services.get('invitetracker');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const user = interaction.options.getUser('usuario') || interaction.user;
      const result = await service.listInvites(interaction.guildId, user.id);
      const ownInviter = result.inviterById ? `<@${result.inviterById}>` : result.inviterSource === 'vanity' ? 'Enlace personalizado del servidor' : result.inviterSource === 'invite' ? 'No identificado' : 'Sin datos anteriores al inicio del seguimiento';
      const list = result.invitees.length
        ? result.invitees.map((invitee, index) => `${index + 1}. <@${invitee.memberId}> · ${invitee.active ? 'activo' : 'salió'} · <t:${Math.floor(new Date(invitee.joinedAt).getTime() / 1000)}:d>`).join('\n')
        : 'Todavía no hay invitaciones verificadas.';
      const content = `**Invitaciones de ${user}**\nTotal: **${result.total}** · En el servidor: **${result.active}**\n\n**Invitó a esta persona:** ${ownInviter}\n\n**Personas invitadas (hasta 10 recientes):**\n${list}`;
      return interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch (error) { return interaction.editReply({ content: String(error.message || 'No se pudo consultar el seguimiento').slice(0, 1500), allowedMentions: { parse: [] } }); }
  } }],
  async setup(context) {
    const service = await new InviteTrackerService(context).initialize(), router = createRouter(service);
    context.provide('invitetracker', service);
    context.provide('dashboard:invitetracker', { title: 'Seguimiento de invitaciones', description: 'Atribuye incorporaciones y consulta el historial de invitaciones', icon: 'group_add', order: 58,
      client: 'dashboard.js', styles: ['dashboard.css'], canAccess: member => service.canManage(member), http: (req, res, next) => router(req, res, next) });
    context.on(Events.ClientReady, () => service.primeEnabledGuilds());
    context.on(Events.InviteCreate, invite => service.onInviteCreate(invite));
    context.on(Events.InviteDelete, invite => service.onInviteDelete(invite));
    context.on(Events.GuildMemberAdd, member => service.onMemberAdd(member));
    context.on(Events.GuildMemberRemove, member => service.onMemberRemove(member));
    context.onClose(() => service.close());
  },
};
