const KEY = Symbol.for('millenniafenixbot.errorMonitor');
const state = globalThis[KEY] || (globalThis[KEY] = { sinks: new Set(), installed: false });

function installErrorMonitor(log) {
  if (typeof log !== 'function') throw TypeError('El monitor requiere una función de registro');
  state.sinks.add(log);
  if (!state.installed) {
    state.installed = true;
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      const detail = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error);
      for (const sink of state.sinks) { try { sink(`Excepción fatal no controlada (${origin}): ${detail}`); } catch {} }
      // Monitor-only: Node conserva su salida y política de terminación por defecto.
    });
    process.on('warning', warning => {
      const detail = warning instanceof Error ? warning.stack || `${warning.name}: ${warning.message}` : String(warning);
      for (const sink of state.sinks) { try { sink(`Advertencia de Node: ${detail}`); } catch {} }
    });
  }
  return () => state.sinks.delete(log);
}

module.exports = { installErrorMonitor };
