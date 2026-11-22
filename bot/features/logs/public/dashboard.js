const node = (tag, className = '', text = '') => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
};

export async function mount(root, { api, icon, module }) {
  const page = node('div', 'discord-logs-page');
  const heading = node('header', 'discord-logs-heading');
  const headingCopy = node('div');
  headingCopy.append(node('p', 'eyebrow', 'MILLENNIA FENIX BOT'), node('h1', '', module.title),
    node('p', 'discord-logs-description', 'Elige cada servidor y configura dónde se publica cada tipo de actividad.'));
  heading.append(headingCopy);
  const notice = node('p', 'discord-logs-notice'); notice.hidden = true; notice.setAttribute('role', 'status');
  const serversTitle = node('div', 'discord-logs-section-title');
  serversTitle.append(node('h2', '', 'Servidores'), node('span', 'discord-logs-subtle', 'El bot solo muestra servidores a los que pertenece.'));
  const servers = node('div', 'discord-logs-servers');
  const settings = node('section', 'discord-logs-settings');
  page.append(heading, notice, serversTitle, servers, settings); root.replaceChildren(page);

  let guilds = [], currentGuild = null, categories = {}, config = null, dirty = false, busy = false;
  const request = (path, options = {}) => api(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const notify = (message, error = false) => {
    notice.textContent = message || ''; notice.hidden = !message;
    notice.classList.toggle('error', error); notice.classList.toggle('success', !!message && !error);
  };
  const selectedGuild = () => guilds.find(guild => guild.id === currentGuild) || null;

  function serverImage(guild, size = 'large') {
    const frame = node('span', `discord-logs-server-icon ${size}`);
    if (guild.iconUrl) {
      const image = document.createElement('img'); image.alt = ''; image.src = guild.iconUrl;
      image.addEventListener('error', () => { image.remove(); frame.append(icon('dns')); }, { once: true });
      frame.append(image);
    } else frame.append(icon('dns'));
    return frame;
  }

  function drawServers() {
    servers.replaceChildren();
    for (const guild of guilds) {
      const button = node('button', 'discord-logs-server'); button.type = 'button';
      button.setAttribute('aria-pressed', String(guild.id === currentGuild));
      button.append(serverImage(guild, 'small'));
      const copy = node('span', 'discord-logs-server-copy');
      copy.append(node('strong', '', guild.name), node('span', '', `${guild.channels.length} canales disponibles`));
      button.append(copy, icon('arrow'));
      button.addEventListener('click', () => void switchGuild(guild.id));
      servers.append(button);
    }
  }

  function drawSettings() {
    settings.replaceChildren();
    const guild = selectedGuild();
    if (!guild || !config) return;
    const serverHeading = node('div', 'discord-logs-current-server');
    serverHeading.append(serverImage(guild));
    const serverCopy = node('div', 'discord-logs-current-copy');
    serverCopy.append(node('p', 'eyebrow', 'CONFIGURACIÓN POR SERVIDOR'), node('h2', '', guild.name),
      node('span', '', `${guild.channels.length} canales donde el bot puede publicar`));
    serverHeading.append(serverCopy);
    settings.append(serverHeading);

    if (!guild.canViewAuditLog) {
      const warning = node('p', 'discord-logs-warning');
      warning.append(icon('warning'), node('span', '', 'El bot no tiene «Ver registro de auditoría». Los registros de expulsiones y la información de responsable pueden ser limitados.'));
      settings.append(warning);
    }

    const master = node('label', 'discord-logs-master');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = config.enabled; checkbox.disabled = busy;
    const switchMark = node('span', 'discord-logs-switch');
    const masterCopy = node('span', 'discord-logs-master-copy');
    masterCopy.append(node('strong', '', 'Registros activos'), node('span', '', 'Al desactivarlos, el bot dejará de enviar registros en este servidor.'));
    master.append(checkbox, switchMark, masterCopy);
    checkbox.addEventListener('change', () => { config.enabled = checkbox.checked; markDirty(); });
    settings.append(master);

    const categoryHeading = node('div', 'discord-logs-category-heading');
    categoryHeading.append(node('h3', '', 'Tipos de actividad'), node('span', '', 'Activa cada categoría y asigna su canal.'));
    settings.append(categoryHeading);
    const list = node('div', 'discord-logs-category-list');
    for (const [id, definition] of Object.entries(categories)) {
      const item = config.categories[id];
      const card = node('article', 'discord-logs-category');
      const line = node('div', 'discord-logs-category-main');
      const checkLabel = node('label', 'discord-logs-category-toggle');
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = item.enabled; check.disabled = busy;
      checkLabel.append(check, node('span', 'discord-logs-checkbox'));
      const description = node('span', 'discord-logs-category-copy');
      description.append(node('strong', '', definition.label), node('span', '', definition.description));
      line.append(checkLabel, description);

      const channelField = node('label', 'discord-logs-channel');
      channelField.append(node('span', '', 'Canal de destino'));
      const select = node('select'); select.disabled = busy;
      select.setAttribute('aria-label', `Canal de destino: ${definition.label}`);
      select.add(new Option(guild.channels.length ? 'Seleccionar canal' : 'No hay canales disponibles', ''));
      const groups = new Map();
      for (const channel of guild.channels) {
        const groupName = channel.category || 'Sin categoría';
        if (!groups.has(groupName)) { const group = document.createElement('optgroup'); group.label = groupName; groups.set(groupName, group); select.append(group); }
        groups.get(groupName).append(new Option(`# ${channel.name}`, channel.id));
      }
      select.value = item.channelId || '';
      channelField.append(select); line.append(channelField); card.append(line);
      check.addEventListener('change', () => { item.enabled = check.checked; markDirty(); });
      select.addEventListener('change', () => { item.channelId = select.value; markDirty(); });
      list.append(card);
    }
    settings.append(list);
    const actions = node('div', 'discord-logs-actions');
    const state = node('span', 'discord-logs-save-state', dirty ? 'Hay cambios sin guardar' : 'Configuración guardada');
    const save = node('button', 'button primary'); save.type = 'button'; save.disabled = busy || !dirty;
    save.append(icon(busy ? 'progress_activity' : 'save'), document.createTextNode(busy ? 'Guardando…' : 'Guardar cambios'));
    save.addEventListener('click', () => void saveConfig());
    actions.append(state, save); settings.append(actions);
  }

  function markDirty() {
    dirty = true;
    const state = settings.querySelector('.discord-logs-save-state');
    const save = settings.querySelector('.discord-logs-actions .button');
    if (state) state.textContent = 'Hay cambios sin guardar';
    if (save) save.disabled = busy || !dirty;
  }

  async function saveConfig() {
    if (!dirty || busy || !currentGuild) return;
    busy = true; notify(''); drawSettings();
    try {
      const result = await request(`api/config/${encodeURIComponent(currentGuild)}`, { method: 'PUT', body: JSON.stringify(config) });
      config = result.config; dirty = false; notify('Configuración guardada.', false);
    } catch (error) { notify(error.message || 'No se pudo guardar la configuración.', true); }
    finally { busy = false; drawSettings(); }
  }

  async function switchGuild(id) {
    if (busy || id === currentGuild) return;
    if (dirty) await saveConfig();
    if (dirty) return;
    busy = true; notify(''); currentGuild = id; drawServers(); drawSettings();
    try {
      const result = await request(`api/config/${encodeURIComponent(id)}`);
      categories = result.categories; config = result.config; dirty = false;
    } catch (error) { config = null; notify(error.message || 'No se pudo cargar este servidor.', true); }
    finally { busy = false; drawServers(); drawSettings(); }
  }

  try {
    guilds = await request('api/guilds');
    if (!guilds.length) {
      settings.append(node('p', 'discord-logs-empty', 'El bot no tiene servidores de Discord disponibles.'));
    } else {
      drawServers(); await switchGuild(guilds[0].id);
    }
  } catch (error) { notify(error.message || 'No se pudieron cargar los servidores.', true); }
  return () => root.replaceChildren();
}
