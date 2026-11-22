// Pelican entry point. All editable bot code lives under bot/; state lives under data/.
process.env.MILLENNIAFENIXBOT_CONFIG_ROOT = __dirname;
require('./bot/standalone.cjs').start({ root: __dirname }).catch(error => {
  console.error('No se pudo iniciar Millennia Fenix Bot:', error.message || error.code || error.name);
  process.exitCode = 1;
});
