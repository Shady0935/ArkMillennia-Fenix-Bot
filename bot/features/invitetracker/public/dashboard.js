const el = (tag, className = '', value = '') => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value) item.textContent = value;
  return item;
};

export async function mount(root, { api, icon, module }) {
  const page = el('div', 'invite-tracker-page');
  const header = el('header', 'invite-tracker-heading');
  header.append(el('p', 'eyebrow', 'MILLENNIA FENIX BOT'), el('h1', '', module.title),
    el('p', 'invite-tracker-subtitle', 'Registra quién invitó a cada miembro desde que actives el seguimiento.'));
  const notice = el('p', 'invite-tracker-notice'); notice.hidden = true;
  const guildList = el('div', 'invite-tracker-guilds');
  const panel = el('section', 'invite-tracker-panel');
  page.append(header, notice, guildList, panel); root.replaceChildren(page);

  let guilds = [], selected = '', state = null, dirty = false, busy = false;
  const request = (path, options = {}) => api(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const tell = (message, error = false) => { notice.textContent = message; notice.hidden = !message; notice.classList.toggle('error', error); };
  const current = () => guilds.find(item => item.id === selected);

  function drawGuilds() {
    guildList.replaceChildren();
    for (const guild of guilds) {
      const button = el('button', 'invite-tracker-guild'); button.type = 'button'; button.setAttribute('aria-pressed', String(guild.id === selected));
      const image = el('span', 'invite-tracker-guild-icon');
      if (guild.iconUrl) { const img = document.createElement('img'); img.src = guild.iconUrl; img.alt = ''; image.append(img); }
      else image.textContent = guild.name.slice(0, 1).toUpperCase();
      button.append(image, el('span', '', guild.name)); button.addEventListener('click', () => void selectGuild(guild.id)); guildList.append(button);
    }
  }

  function draw() {
    panel.replaceChildren();
    const guild = current();
    if (!guild || !state) return;
    const title = el('div', 'invite-tracker-title');
    title.append(el('div', '', ''), el('h2', '', state.guild.name)); panel.append(title);
    const capabilities = state.capability;
    const missing = [];
    if (!capabilities.hasGuildMembersIntent) missing.push('Guild Members intent');
    if (!capabilities.hasGuildInvitesIntent) missing.push('Guild Invites intent');
    if (!capabilities.canFetchInvites) missing.push('Administrar servidor o Ver registro de auditoría');
    const warning = el('div', 'invite-tracker-warning');
    warning.append(icon(missing.length ? 'warning' : 'info'), el('span', '', missing.length
      ? `No se puede activar todavía. Falta: ${missing.join('; ')}.`
      : 'Discord no expone el código usado en la entrada: si varios invites cambian a la vez, se marcará como «no identificado» para no adjudicarlo mal. El conteo comienza al activar el módulo; no se reconstruyen entradas pasadas.'));
    panel.append(warning);
    if (capabilities.inviteManageChannels === 0) {
      const caveat = el('div', 'invite-tracker-caveat'); caveat.append(icon('info'), el('span', '', 'Sin «Administrar canales» en los canales de invitación, Discord puede no enviar eventos de creación/eliminación y una invitación nueva durante el seguimiento podría quedar sin atribución.')); panel.append(caveat);
    }
    const master = el('label', 'invite-tracker-master');
    const active = document.createElement('input'); active.type = 'checkbox'; active.checked = state.config.enabled; active.disabled = busy || !!missing.length;
    master.append(active, el('span', 'invite-tracker-switch'), el('span', 'invite-tracker-master-copy', 'Seguimiento activado'));
    active.addEventListener('change', () => { state.config.enabled = active.checked; changed(); }); panel.append(master);

    const channelLabel = el('label', 'invite-tracker-field'); channelLabel.append(el('span', '', 'Canal para entradas y salidas'));
    const select = document.createElement('select'); select.disabled = busy;
    select.add(new Option('Selecciona un canal', ''));
    const groups = new Map();
    for (const channel of state.channels) {
      const category = channel.category || 'Sin categoría';
      if (!groups.has(category)) { const group = document.createElement('optgroup'); group.label = category; groups.set(category, group); select.append(group); }
      groups.get(category).append(new Option(`# ${channel.name}`, channel.id));
    }
    select.value = state.config.channelId; select.addEventListener('change', () => { state.config.channelId = select.value; changed(); }); channelLabel.append(select); panel.append(channelLabel);

    const toggles = el('div', 'invite-tracker-toggles');
    for (const [key, label] of [['notifyJoins', 'Avisar cuando alguien entra'], ['notifyLeaves', 'Avisar cuando alguien sale']]) {
      const row = el('label', 'invite-tracker-toggle-row'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.config[key]; input.disabled = busy;
      row.append(input, el('span', 'invite-tracker-checkbox'), el('span', '', label));
      input.addEventListener('change', () => { state.config[key] = input.checked; changed(); }); toggles.append(row);
    }
    panel.append(toggles);
    for (const [key, label, placeholder] of [
      ['joinMessage', 'Mensaje de entrada', '👋 {member} se unió. Invitó: {inviter}.'],
      ['leaveMessage', 'Mensaje de salida', '🚪 {member} salió. Lo había invitado: {inviter}.'],
    ]) {
      const field = el('label', 'invite-tracker-field'); field.append(el('span', '', label));
      const input = document.createElement('input'); input.type = 'text'; input.maxLength = 1000; input.value = state.config[key]; input.placeholder = placeholder; input.disabled = busy;
      input.addEventListener('input', () => { state.config[key] = input.value; changed(); }); field.append(input);
      field.append(el('small', '', 'Variables disponibles: {member}, {inviter}, {code}. Las menciones se muestran sin notificar al usuario.')); panel.append(field);
    }
    const commands = el('p', 'invite-tracker-command'); commands.textContent = 'Comando: /invites [usuario] — muestra sus invitaciones verificadas y quién lo invitó.'; panel.append(commands);
    const actions = el('footer', 'invite-tracker-actions');
    actions.append(el('span', 'invite-tracker-save-state', dirty ? 'Hay cambios sin guardar' : `Estado: ${capabilities.status === 'ready' ? 'listo' : capabilities.status === 'permission-error' ? 'error de permisos' : 'pendiente'}`));
    const save = el('button', 'invite-tracker-save', busy ? 'Guardando…' : 'Guardar configuración'); save.type = 'button'; save.disabled = busy || !dirty;
    save.addEventListener('click', () => void saveConfig()); actions.append(save); panel.append(actions);
  }

  function changed() { dirty = true; draw(); }
  async function saveConfig() {
    if (!dirty || busy || !selected) return;
    busy = true; tell(''); draw();
    try { state = await request(`api/config/${encodeURIComponent(selected)}`, { method: 'PUT', body: JSON.stringify(state.config) }); dirty = false; tell('Configuración guardada.'); }
    catch (error) { tell(error.message || 'No se pudo guardar la configuración.', true); }
    finally { busy = false; drawGuilds(); draw(); }
  }
  async function selectGuild(id) {
    if (busy || id === selected) return;
    if (dirty) await saveConfig();
    if (dirty) return;
    busy = true; selected = id; state = null; drawGuilds(); panel.replaceChildren(el('p', 'invite-tracker-empty', 'Cargando configuración…'));
    try { state = await request(`api/config/${encodeURIComponent(id)}`); dirty = false; }
    catch (error) { tell(error.message || 'No se pudo cargar el servidor.', true); }
    finally { busy = false; drawGuilds(); draw(); }
  }

  try {
    guilds = await request('api/guilds');
    if (!guilds.length) panel.append(el('p', 'invite-tracker-empty', 'El bot no tiene servidores de Discord disponibles.'));
    else { drawGuilds(); await selectGuild(guilds[0].id); }
  } catch (error) { tell(error.message || 'No se pudieron cargar los servidores.', true); }
  return () => root.replaceChildren();
}
