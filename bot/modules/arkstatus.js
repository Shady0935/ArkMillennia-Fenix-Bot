const { EmbedBuilder, Events, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { COLORS, env, channelId, getGuildChannel, mentionsNone, updatePanel } = require('../features/ark/common.cjs');
const { configuredMaps, collectStatus, statusEmbed } = require('../features/ark/status.cjs');

module.exports = {
  version: '1.0.0',
  commands: [{
    data: new SlashCommandBuilder().setName('arkestado').setDescription('Consulta el estado de los servidores ARK'),
    execute: async (interaction, context) => {
      const service = context.services.get('ark:status');
      const status = await service?.current();
      if (!status?.maps?.length) return interaction.reply({
        content: 'El estado aún no está disponible. Configura los puertos de consulta A2S del clúster.',
        flags: MessageFlags.Ephemeral,
      });
      return interaction.reply({ embeds: [statusEmbed(status)], flags: MessageFlags.Ephemeral, allowedMentions: mentionsNone() });
    },
  }],
  async setup(context) {
    const maps = configuredMaps();
    const pollSeconds = Math.min(3600, Math.max(30, Number(env('ARK_STATUS_POLL_SECONDS', '60')) || 60));
    let busy = false;
    const refresh = async () => {
      if (!maps.length || busy) return null;
      busy = true;
      try {
        const status = await collectStatus(maps);
        await context.storage.set('last-status', status);
        const channel = await getGuildChannel(context.client, context.guildId, channelId('ARK_STATUS_CHANNEL_ID'));
        if (channel) await updatePanel(context, { channel, key: 'status-panel-message', marker: 'MF:ark-status', payload: { embeds: [statusEmbed(status)] } });
        return status;
      } finally { busy = false; }
    };
    context.provide('ark:status', { current: () => context.storage.get('last-status', null), refresh });
    if (!maps.length) context.log('Estado A2S desactivado: configura ARK_STATUS_MAPS con objetivos de consulta UDP.');
    context.on(Events.ClientReady, () => refresh());
    context.every(pollSeconds * 1000, () => refresh());
  },
};
