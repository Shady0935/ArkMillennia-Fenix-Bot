const { createEmbed, normalizeEmbedData } = require('../runtime/embeds.cjs');

module.exports = {
  version: '1.0.0',
  setup(context) {
    context.provide('embeds', {
      create: options => createEmbed(options),
      normalize: (embed, options) => normalizeEmbedData(embed, options),
    });
  },
};
