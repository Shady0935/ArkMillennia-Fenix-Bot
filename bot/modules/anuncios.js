const { SlashCommandBuilder, Events, MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { AnnouncementService } = require('../features/anuncios/service.cjs');
const { createHttp } = require('../features/anuncios/http.cjs');

async function authorized(interaction, context) {
  if (interaction.guildId !== context.guildId) throw Error('Usa este comando en el Discord configurado');
  const member = await context.client.guilds.cache.get(context.guildId).members.fetch({ user: interaction.user.id, force: true });
  const service = context.services.get('anuncios');
  if (!service || !await service.canAccess(member)) throw Error('No tienes permiso para gestionar anuncios');
  return { service, member };
}
async function command(interaction, context, run) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try { const access = await authorized(interaction, context); await run(access.service, access.member); }
  catch (error) { await interaction.editReply({ content: String(error.message).slice(0, 1800), allowedMentions: { parse: [] } }); }
}
module.exports = {
  version: '1.0.0',
  commands: [
    { data: new SlashCommandBuilder().setName('anuncio').setDescription('Abre el editor o prepara un anuncio por mensaje directo')
      .addStringOption(option => option.setName('texto').setDescription('Texto del anuncio (se pedirá confirmación)').setMaxLength(2000)),
      execute: (interaction, context) => command(interaction, context, async service => {
        const text = interaction.options.getString('texto');
        if (text) {
          const preview = await service.preview(text, interaction.user);
          await interaction.editReply({ content: 'Revisa el anuncio. Se enviará únicamente a quienes mantienen su reacción de consentimiento.',
            embeds: [new EmbedBuilder().setTitle('Vista previa del anuncio').setDescription(text).setColor(0x8F1D3D)],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`anuncios:enviar:${preview.id}`).setLabel('Confirmar envío').setStyle(ButtonStyle.Danger))], allowedMentions: { parse: [] } });
        } else {
          const dashboard = await context.services.get('system:dashboard')?.info();
          await interaction.editReply(dashboard?.listening ? `Editor de anuncios: ${dashboard.url}/#anuncios` : 'La dashboard está apagada. Puedes usar /anuncio texto:... o activarla en bot/.env.');
        }
      }) },
    ...['sync', 'recoverconsent'].map(name => ({ data: new SlashCommandBuilder().setName(name).setDescription('Actualiza los suscriptores desde las reacciones del mensaje configurado'),
      execute: (interaction, context) => command(interaction, context, async service => { const result = await service.sync(); await interaction.editReply(result.message); }) })),
  ],
  async setup(context) {
    const service = await new AnnouncementService(context).initialize(), http = createHttp(service);
    context.provide('anuncios', service);
    context.provide('dashboard:anuncios', { title: 'Anuncios', description: 'Editor de mensajes directos, consentimiento e historial', icon: 'campaign', order: 20,
      canAccess: member => service.canAccess(member), http });
    context.on(Events.MessageReactionAdd, (reaction, user) => service.reaction(reaction, user, true));
    context.on(Events.MessageReactionRemove, (reaction, user) => service.reaction(reaction, user, false));
    context.on(Events.GuildMemberRemove, async member => { if (member.guild.id === context.guildId) await service.consent(member.id, false); });
    context.on(Events.MessageReactionRemoveAll, async message => {
      if (message.id === service.config.mensaje_consentimiento_id && message.channelId === service.config.canal_consentimiento_id && message.guildId === context.guildId) {
        await service.consentMany([...service.consents], false);
      }
    });
    context.on(Events.MessageReactionRemoveEmoji, async reaction => {
      if (reaction.message.id === service.config.mensaje_consentimiento_id && reaction.message.channelId === service.config.canal_consentimiento_id
        && reaction.message.guildId === context.guildId && service.matchesEmoji(reaction.emoji)) {
        await service.consentMany([...service.consents], false);
      }
    });
    const sync = async () => { if (service.config.mensaje_consentimiento_id) await service.sync(); };
    context.on(Events.ClientReady, sync);
    context.on(Events.ShardDisconnect, () => { service.synced = false; service.cancel(); });
    context.on(Events.ShardResume, sync);
    context.on(Events.MessageDelete, message => {
      if (message.id === service.config.mensaje_consentimiento_id && message.channelId === service.config.canal_consentimiento_id
        && message.guildId === context.guildId) { service.synced = false; service.cancel(); }
    });
    context.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isButton?.() || !interaction.customId.startsWith('anuncios:enviar:')) return;
      await command(interaction, context, async active => {
        const result = await active.confirm(interaction.customId.slice('anuncios:enviar:'.length), interaction.user);
        await interaction.editReply({ content: `Envío iniciado. ID: ${result.sendId}`, embeds: [], components: [] });
      });
    });
    context.every(60000, () => service.cleanupUploads());
    context.onClose(() => service.close());
  },
  async activate(context) {
    if (context.client.isReady()) {
      const service = context.services.get('anuncios');
      if ((await service.status()).configured) await service.sync();
    }
  },
};
