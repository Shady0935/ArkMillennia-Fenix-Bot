# Módulos de ArkMillennia Fenix

El bot está hecho en Node.js con módulos independientes. Estos módulos portan las funciones del bot Python que publicaba el ranking, la tienda, el calendario, el estado y la auditoría. Los canales se configuran en el `.env` del proyecto y deben pertenecer al `DISCORD_GUILD_ID`.

## Funciones

- `/tienda`: busca dinosaurios, artículos, cajas y mejoras del catálogo. El catálogo se copia a `bot/features/ark/data/catalogue.json`; las ofertas de kits y puntos están en `premium.json`. Las búsquedas y las páginas se responden en privado.
- `/ranking`: consulta las ocho categorías del ranking con selector y paginación privados. El panel opcional se publica en `ARK_RANKING_CHANNEL_ID`.
- `/arkestado`: muestra el último sondeo del clúster. El panel opcional usa `ARK_STATUS_CHANNEL_ID`.
- `/horariomodos`: consulta el calendario. El módulo actualiza el panel y publica la operación cuando está próxima o ya terminó.
- `/auditoriaark`: indica si la entrega de auditoría está habilitada. Los eventos solo se publican en un canal que el módulo verifique como oculto para `@everyone` y visible para algún rol admin configurado.

## Estado del juego

`arkstatus` consulta el paquete de información de Steam A2S por UDP; no usa RCON. Envía la solicitud acolchada a 1200 bytes y acepta el desafío de cuatro bytes definido para el protocolo A2S. Configura `ARK_STATUS_MAPS` con entradas separadas por punto y coma:

```dotenv
ARK_STATUS_MAPS=Genesis|ark.example.net|27015|PvE;Ragnarok|ark.example.net|27016|PvE
ARK_STATUS_POLL_SECONDS=60
```

Cada entrada es `Nombre|host público|puerto de consulta|modalidad`. El puerto debe ser el puerto Steam Query accesible desde donde se ejecuta el bot. El panel muestra estado, mapa y cantidad de jugadores; no enumera nombres. La integración MCP de Tatnik sirve para inspección del servidor desde Codex, no como API de ejecución disponible para este proceso Node.

## Archivos de datos

Los archivos operativos van bajo `data/ark/`; no se importó el ranking de jugadores ni el estado operativo del servidor.

`ranking.json` usa el formato que produce el recolector del ranking:

```json
{
  "updatedAt": "2026-11-21T12:00:00Z",
  "mode": "PvP",
  "rankingLimit": 50,
  "categories": [
    { "name": "Tribus y puntos", "value": "🏆 1. Ejemplo · 1200 puntos" },
    { "name": "Bajas de jugadores", "value": "Aún no hay registros elegibles." },
    { "name": "Dinos enemigos", "value": "Aún no hay registros elegibles." },
    { "name": "Eficiencia PvP", "value": "Aún no hay registros elegibles." },
    { "name": "Caza de salvajes", "value": "Aún no hay registros elegibles." },
    { "name": "Domesticaciones", "value": "Aún no hay registros elegibles." },
    { "name": "Tiempo jugado", "value": "Aún no hay registros elegibles." },
    { "name": "Muertes registradas", "value": "Aún no hay registros elegibles." }
  ]
}
```

Debe contener ocho objetos en `categories`, cada uno con `name` y `value` como texto; `value` puede incluir encabezados y filas. El bot pagina las filas reconocibles como puestos, y limita los datos desactualizados a una indicación visible.

`mode-schedule.json` puede contener `next` (hasta dos eventos con `mode`, `epoch`, `cdmx` y `chile`) y un objeto `operation` con `id`, `mode`, `epoch`, `cdmx`, `chile`, `phase` y, opcionalmente, `maps`. Se usa solo para publicar el calendario y el estado comunicado por ese archivo; no inicia reinicios ni modifica los servidores.

Los eventos de auditoría se leen de `data/ark/admin-audit/` (o del subdirectorio indicado por `ARK_AUDIT_DIRECTORY`). Cada nombre debe ser un ID hexadecimal de 32 caracteres seguido de `.json`. Se valida el esquema 1, el mapa, el timestamp y los campos según el tipo `command` o `compatibility`. El bot oculta comandos que parecen contener credenciales y no muestra hashes de cuenta. Un envío incierto queda marcado y no se repite automáticamente.

## Canales y opciones

Configura estas variables en `.env`:

- `ARK_RANKING_CHANNEL_ID`, `ARK_SHOP_CHANNEL_ID`, `ARK_STATUS_CHANNEL_ID` y `ARK_MODE_ANNOUNCEMENTS_CHANNEL_ID` son opcionales; sus paneles no se publican si faltan.
- `ARK_TICKET_CHANNEL_ID` o `ARK_TICKET_URL` añade el botón de ticket a las ofertas.
- `ARK_RANKING_DATA_FILE` y `ARK_MODE_SCHEDULE_FILE` aceptan solo nombres simples de archivo JSON dentro de `data/ark/`.
- Para auditoría, configura `ARK_ADMIN_AUDIT_ENABLED=true`, `ARK_ADMIN_AUDIT_CHANNEL_ID` y `DISCORD_ADMIN_ROLE_IDS`. El canal debe ocultarse de `@everyone` y permitir acceso a un rol admin que el bot tenga configurado.

Los paneles guardan su ID en el espacio MySQL de cada módulo y buscan una marca de recuperación antes de crear otro mensaje. Los datos se importan desde el servidor Tatnik de forma selectiva: se copió el catálogo público y las ofertas actuales, sin credenciales, historial de jugadores ni procedencia interna de la hoja de ventas.
