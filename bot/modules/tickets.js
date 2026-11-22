const { Events } = require('discord.js');
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { TicketService } = require('../features/tickets/service.cjs');
const { createRouter } = require('../features/tickets/http.cjs');

async function runTicketCommand(interaction, context) {
  if (interaction.guildId !== context.guildId) throw Error('Usa este comando dentro de un ticket del servidor configurado');
  const service = context.services.get('tickets');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const ticket = await service.ticket(interaction.channelId);
  if (!ticket || ticket.guildId !== interaction.guildId) throw Error('Usa este comando dentro de un canal de ticket');
  const action = interaction.options.getSubcommand();
  if (action === 'close') {
    if (interaction.user.id !== ticket.ownerId && !await service.isSupport(member)) throw Error('Solo el propietario o soporte puede cerrar este ticket');
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tickets:confirm-close').setLabel('Sí, cerrar').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tickets:cancel-close').setLabel('Seguir en el ticket').setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({ content: '¿Cerrar definitivamente? Se copiarán los adjuntos al canal 1569784973790281758 del servidor 1347720640882413659, se guardará la transcripción y se eliminará este canal.', components: [row], flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (action === 'add' || action === 'remove') {
    const { member: target } = await service.setTicketUser(ticket.channelId, member, interaction.options.getUser('usuario').id, action === 'add');
    return interaction.editReply({ content: action === 'add' ? `${target.user.username} ya tiene acceso al ticket.` : `Se retiró el acceso de ${target.user.username}.` });
  }
  if (action === 'claim') {
    const result = await service.claimTicket(ticket.channelId, member);
    return interaction.editReply({ content: `Ticket asignado a ${result.claimedByName}.` });
  }
  if (action === 'unclaim') {
    await service.unclaimTicket(ticket.channelId, member);
    return interaction.editReply({ content: 'Ticket liberado para soporte.' });
  }
  if (action === 'archive') {
    await service.archiveTicket(ticket.channelId, member);
    return interaction.editReply({ content: 'Ticket archivado; el canal se conserva y puede reabrirse.' });
  }
  if (action === 'reopen') {
    await service.reopenTicket(ticket.channelId, member);
    return interaction.editReply({ content: 'Ticket reabierto.' });
  }
}

const ticketCommand = new SlashCommandBuilder().setName('tickets').setDescription('Acciones de soporte en el canal del ticket')
  .addSubcommand(command => command.setName('add').setDescription('Da acceso al ticket a una persona').addUserOption(option => option.setName('usuario').setDescription('Persona que podrá ver y responder').setRequired(true)))
  .addSubcommand(command => command.setName('remove').setDescription('Retira el acceso individual de una persona').addUserOption(option => option.setName('usuario').setDescription('Persona a retirar del ticket').setRequired(true)))
  .addSubcommand(command => command.setName('claim').setDescription('Asígnate este ticket'))
  .addSubcommand(command => command.setName('unclaim').setDescription('Libera el ticket para soporte'))
  .addSubcommand(command => command.setName('close').setDescription('Guarda la transcripción y elimina el canal'))
  .addSubcommand(command => command.setName('archive').setDescription('Conserva el canal y permite reabrir el ticket'))
  .addSubcommand(command => command.setName('reopen').setDescription('Reabre un ticket archivado'));

module.exports = {
  version: '1.0.0',
  commands: [{ data: ticketCommand, execute: async (interaction, context) => {
    try { await runTicketCommand(interaction, context); }
    catch (error) {
      const payload = { content: String(error.message || 'No se pudo ejecutar la acción de tickets').slice(0, 1800), allowedMentions: { parse: [] } };
      if (interaction.replied || interaction.deferred) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } }],
  async setup(context) {
    const service = await new TicketService(context).initialize();
    const router = createRouter(service);
    context.provide('tickets', service);
    context.provide('dashboard:tickets', {
      title: 'Tickets',
      description: 'Configura el centro de ayuda y administra las solicitudes de soporte',
      icon: 'extension',
      order: 50,
      client: 'dashboard.js',
      styles: ['dashboard.css'],
      canAccess: member => service.canAccess(member),
      http: (req, res, next) => router(req, res, next),
    });
    context.on(Events.InteractionCreate, interaction => service.handleInteraction(interaction));
    context.on(Events.MessageCreate, message => service.onMessage(message));
    context.on(Events.ChannelDelete, channel => service.onChannelDelete(channel));
    context.onClose(() => service.close());
  },
};
