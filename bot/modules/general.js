const { SlashCommandBuilder, MessageFlags } = require('discord.js');
module.exports = {
  version:'1.0.0',
  commands:[
    {data:new SlashCommandBuilder().setName('ping').setDescription('Comprueba la conexión del bot'),execute:async interaction=>interaction.reply({content:'Pong.',flags:MessageFlags.Ephemeral})},
    {data:new SlashCommandBuilder().setName('estado').setDescription('Estado del bot de ArkMillennia Fenix'),execute:async(interaction,ctx)=>{
      const status=await ctx.services.get('system:bot')?.status();
      await interaction.reply({content:status?`Bot conectado · ${Math.floor(status.uptimeSeconds/60)} minutos activo · ${status.modules.length} módulos`:'Bot conectado.',flags:MessageFlags.Ephemeral});
    }},
    {data:new SlashCommandBuilder().setName('saludo').setDescription('Un saludo de ArkMillennia Fenix'),execute:async interaction=>interaction.reply({content:`¡Hola, ${interaction.user.username}!`,allowedMentions:{parse:[]}})},
  ],
};
