# Integración de funciones de bienvenida

## Integrado en Millennia Fenix Bot

- Mensajes de bienvenida y despedida con variables `{user}`, `{username}`, `{server}` y `{count}`.
- Bienvenida opcional por mensaje privado.
- Asignación de hasta diez roles automáticos, validando la jerarquía del bot.
- Verificación con botón que asigna un rol y responde de forma privada.
- Panel con canales y roles del servidor principal, pruebas de mensajes y edición del mensaje de verificación.
- Navegación de la dashboard inspirada en Discord, con marca y acentos de ArkMillennia Fenix.

## Pendiente de revisar

- **Tarjetas gráficas configurables:** el proyecto de referencia depende de un compositor Canvas y un modelo Prisma. Millennia Fenix Bot usa almacenamiento MySQL namespaced y todavía no tiene ese pipeline; conviene diseñar una versión compatible antes de añadirla.
- **Seguimiento de invitaciones:** requiere snapshots persistentes de invitaciones, atribución fiable en eventos de entrada y políticas de privacidad/retención. Los eventos actuales de creación/borrado no bastan para inferir quién invitó a cada miembro.
- **Configuración multi-servidor:** la dashboard actual está diseñada para un único servidor principal; esto requiere un cambio de modelo y de permisos.
