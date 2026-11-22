const node = (tag, className = '', text = '') => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};

const symbol = name => {
  const value = node('span', 'material-symbols-outlined', name);
  value.setAttribute('aria-hidden', 'true');
  return value;
};

const initials = value => String(value || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toLocaleUpperCase('es');

function avatar(user) {
  const root = node('span', 'rolemanager-avatar');
  root.append(node('span', 'rolemanager-avatar-fallback', initials(user.displayName)));
  const image = document.createElement('img');
  image.alt = '';
  image.src = user.avatarUrl;
  image.addEventListener('error', () => image.remove(), { once: true });
  root.append(image);
  return root;
}

export async function mount(root, { api, module }) {
  const page = node('div', 'rolemanager-page');
  const heading = node('header', 'rolemanager-heading');
  const headingCopy = node('div');
  headingCopy.append(node('p', 'eyebrow', 'MILLENNIA FENIX BOT'), node('h1', '', module.title),
    node('p', 'rolemanager-description', 'Busca a un miembro y administra sus rangos en el Discord de ArkMillennia Fenix.'));
  heading.append(headingCopy);

  const toolbar = node('section', 'rolemanager-toolbar');
  const serverField = node('label', 'rolemanager-server-field');
  serverField.append(node('span', 'rolemanager-field-label', 'Servidor'));
  const serverSelect = node('select', 'rolemanager-server-select');
  serverSelect.setAttribute('aria-label', 'Discord configurado');
  serverField.hidden = true;
  serverField.append(serverSelect);
  const serverBadge = node('div', 'rolemanager-server-badge');
  serverBadge.append(symbol('group'));
  const serverBadgeText = node('div', 'rolemanager-server-badge-copy');
  serverBadgeText.append(node('strong', '', 'Discord configurado'), node('span', '', 'Administración de rangos'));
  serverBadge.append(serverBadgeText);
  toolbar.append(serverField, serverBadge);

  const notice = node('p', 'rolemanager-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'status');

  const layout = node('div', 'rolemanager-layout');
  const searchPanel = node('section', 'rolemanager-panel rolemanager-search-panel');
  const searchTitle = node('div', 'rolemanager-panel-heading');
  searchTitle.append(node('h2', '', 'Buscar miembro'));
  const searchForm = node('form', 'rolemanager-search-form');
  const searchInput = node('input', 'rolemanager-search-input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Nombre, apodo o ID';
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'Buscar miembro del servidor');
  const searchButton = node('button', 'button primary', 'Buscar');
  searchButton.type = 'submit';
  searchForm.append(searchInput, searchButton);
  const searchHint = node('p', 'rolemanager-search-hint', 'Escribe al menos dos caracteres.');
  const resultsHeading = node('div', 'rolemanager-results-heading');
  resultsHeading.append(node('span', '', 'Resultados'), node('span', 'rolemanager-results-count'));
  const results = node('div', 'rolemanager-results');
  searchPanel.append(searchTitle, searchForm, searchHint, resultsHeading, results);

  const editor = node('section', 'rolemanager-panel rolemanager-editor');
  layout.append(searchPanel, editor);
  page.append(heading, toolbar, notice, layout);
  root.replaceChildren(page);

  let guilds = [];
  let memberData = null;
  let selectedUserId = '';
  let searchSequence = 0;
  let memberSequence = 0;
  let roleFilter = '';
  const busyRoles = new Set();

  const request = (path, options = {}) => api(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });

  function selectedGuild() {
    return guilds.find(guild => guild.id === serverSelect.value) || null;
  }

  function notify(message, error = false) {
    notice.textContent = message || '';
    notice.hidden = !message;
    notice.classList.toggle('error', error);
    notice.classList.toggle('success', !!message && !error);
  }

  function drawServerBadge() {
    const guild = selectedGuild();
    const copy = serverBadge.querySelector('.rolemanager-server-badge-copy');
    copy.replaceChildren(
      node('strong', '', guild?.name || 'Servidor'),
      node('span', '', guild?.label || 'Discord conectado'),
    );
  }

  function drawEditorLoading(message) {
    editor.replaceChildren();
    const state = node('div', 'rolemanager-empty');
    state.append(symbol('group'), node('strong', '', message));
    editor.append(state);
  }

  function drawMemberResults(items) {
    results.replaceChildren();
    const count = resultsHeading.lastChild;
    count.textContent = items.length ? String(items.length) : '';
    if (!items.length) {
      results.append(node('p', 'rolemanager-empty-results', 'No se encontraron miembros.'));
      return;
    }
    for (const user of items) {
      const item = node('button', 'rolemanager-user');
      item.type = 'button';
      item.setAttribute('aria-pressed', String(user.id === selectedUserId));
      item.append(avatar(user));
      const copy = node('span', 'rolemanager-user-copy');
      copy.append(node('strong', '', user.displayName), node('span', '', '@' + user.username));
      item.append(copy, node('span', 'rolemanager-user-role-count', String(user.roleCount)));
      item.addEventListener('click', () => loadMember(user.id));
      results.append(item);
    }
  }

  function colorDot(color) {
    const dot = node('span', 'rolemanager-color-dot');
    dot.style.setProperty('--role-color', color || '#68716d');
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  function drawCurrentRoles() {
    const current = node('section', 'rolemanager-current');
    const roles = memberData.roles.filter(role => role.assigned);
    const title = node('div', 'rolemanager-subheading');
    title.append(node('h3', '', 'Rangos actuales'), node('span', 'rolemanager-results-count', String(roles.length)));
    const chips = node('div', 'rolemanager-role-chips');
    if (!roles.length) chips.append(node('span', 'rolemanager-muted', 'Sin rangos asignados que el bot pueda administrar.'));
    for (const role of roles) {
      const chip = node('span', 'rolemanager-role-chip');
      chip.style.setProperty('--role-color', role.color || '#68716d');
      chip.append(colorDot(role.color), node('span', '', role.name));
      chips.append(chip);
    }
    current.append(title, chips);
    return current;
  }

  function drawRoles() {
    if (!memberData) return;
    editor.replaceChildren();
    const header = node('div', 'rolemanager-member-heading');
    header.append(avatar(memberData.member));
    const identity = node('div', 'rolemanager-member-identity');
    identity.append(node('strong', '', memberData.member.displayName),
      node('span', '', '@' + memberData.member.username + ' · ' + memberData.guildName));
    header.append(identity);
    const change = node('button', 'button secondary rolemanager-change-user', 'Cambiar usuario');
    change.type = 'button';
    change.addEventListener('click', () => {
      selectedUserId = '';
      memberData = null;
      drawEditorLoading('Selecciona un miembro para administrar sus rangos.');
      searchInput.focus();
    });
    header.append(change);

    const roleSection = node('section', 'rolemanager-roles-section');
    const sectionHeading = node('div', 'rolemanager-subheading rolemanager-roles-heading');
    const sectionCopy = node('div');
    sectionCopy.append(node('h2', '', 'Rangos del servidor'), node('p', '', 'Solo se muestran rangos que el bot puede administrar.'));
    const filter = node('input', 'rolemanager-role-filter');
    filter.type = 'search';
    filter.placeholder = 'Filtrar rangos';
    filter.setAttribute('aria-label', 'Filtrar rangos por nombre');
    filter.value = roleFilter;
    sectionHeading.append(sectionCopy, filter);

    const warning = node('p', 'rolemanager-permission-warning');
    if (!memberData.canManageRoles) {
      warning.textContent = 'El bot no tiene el permiso Administrar rangos en este servidor. Los cambios están desactivados.';
      warning.hidden = false;
    } else {
      warning.hidden = true;
    }

    const list = node('div', 'rolemanager-role-list');
    const empty = node('p', 'rolemanager-empty-results', 'No hay rangos que coincidan con el filtro.');
    empty.hidden = true;
    roleSection.append(sectionHeading, warning, drawCurrentRoles(), list, empty);
    editor.append(header, roleSection);

    function populate() {
      const query = roleFilter.trim().toLocaleLowerCase('es');
      const visible = memberData.roles.filter(role => !query || role.name.toLocaleLowerCase('es').includes(query));
      list.replaceChildren();
      empty.textContent = memberData.roles.length
        ? 'No hay rangos que coincidan con el filtro.'
        : 'No hay rangos que el bot pueda administrar en este servidor.';
      empty.hidden = visible.length > 0;
      for (const role of visible) {
        const row = node('article', 'rolemanager-role-row' + (role.assigned ? ' assigned' : ''));
        row.style.setProperty('--role-color', role.color || '#68716d');
        const details = node('div', 'rolemanager-role-details');
        details.append(colorDot(role.color));
        details.append(node('strong', 'rolemanager-role-name', role.name));
        const state = node('span', 'rolemanager-role-state' + (role.assigned ? ' is-assigned' : ''),
          role.assigned ? 'Asignado' : 'Disponible');
        details.append(state);
        row.append(details);
        if (role.editable) {
          const action = node('button', 'button small ' + (role.assigned ? 'danger' : 'secondary'),
            busyRoles.has(role.id) ? 'Actualizando…' : role.assigned ? 'Quitar' : 'Asignar');
          action.type = 'button';
          action.disabled = busyRoles.has(role.id);
          action.addEventListener('click', () => updateRole(role, !role.assigned));
          row.append(action);
        } else {
          const locked = node('span', 'rolemanager-locked', role.reason || 'No editable por el bot');
          row.append(locked);
        }
        list.append(row);
      }
    }
    filter.addEventListener('input', () => { roleFilter = filter.value; populate(); });
    populate();
  }

  async function loadMember(userId) {
    const sequence = ++memberSequence;
    selectedUserId = userId;
    memberData = null;
    drawEditorLoading('Cargando rangos del miembro…');
    notify('');
    const params = new URLSearchParams({ guildId: serverSelect.value, userId });
    try {
      const next = await request('api/member?' + params.toString());
      if (sequence !== memberSequence) return;
      memberData = next;
      roleFilter = '';
      drawRoles();
    } catch (error) {
      if (sequence !== memberSequence) return;
      selectedUserId = '';
      drawEditorLoading('No se pudieron cargar los rangos.');
      notify(error.message || 'No se pudieron cargar los rangos.', true);
    }
  }

  async function updateRole(role, assigned) {
    if (!memberData || busyRoles.has(role.id)) return;
    busyRoles.add(role.id);
    drawRoles();
    notify('');
    try {
      const next = await request('api/member-role', {
        method: 'PUT',
        body: JSON.stringify({
          guildId: memberData.guildId,
          userId: memberData.member.id,
          roleId: role.id,
          assigned,
        }),
      });
      memberData = next;
      notify(assigned ? `Se asignó el rango «${role.name}».` : `Se quitó el rango «${role.name}».`);
    } catch (error) {
      notify(error.message || 'No se pudo actualizar el rango.', true);
    } finally {
      busyRoles.delete(role.id);
      drawRoles();
    }
  }

  async function searchMembers() {
    const query = searchInput.value.trim();
    if (query.length < 2) {
      drawMemberResults([]);
      results.replaceChildren(node('p', 'rolemanager-empty-results', 'Escribe al menos dos caracteres.'));
      resultsHeading.lastChild.textContent = '';
      notify('');
      return;
    }
    const sequence = ++searchSequence;
    searchButton.disabled = true;
    searchButton.textContent = 'Buscando…';
    searchHint.textContent = 'Buscando en ' + (selectedGuild()?.name || 'el servidor') + '…';
    try {
      const params = new URLSearchParams({ guildId: serverSelect.value, q: query });
      const items = await request('api/members?' + params.toString());
      if (sequence !== searchSequence) return;
      drawMemberResults(items);
      searchHint.textContent = 'Puedes buscar por nombre, apodo o ID.';
    } catch (error) {
      if (sequence === searchSequence) {
        drawMemberResults([]);
        results.replaceChildren(node('p', 'rolemanager-empty-results', error.message || 'No se pudo buscar.'));
        searchHint.textContent = '';
      }
    } finally {
      if (sequence === searchSequence) {
        searchButton.disabled = false;
        searchButton.textContent = 'Buscar';
      }
    }
  }

  searchForm.addEventListener('submit', event => { event.preventDefault(); void searchMembers(); });
  serverSelect.addEventListener('change', () => {
    ++searchSequence;
    ++memberSequence;
    selectedUserId = '';
    memberData = null;
    drawServerBadge();
    drawMemberResults([]);
    results.replaceChildren(node('p', 'rolemanager-empty-results', 'Busca un miembro de este servidor.'));
    drawEditorLoading('Selecciona un miembro para administrar sus rangos.');
    notify('');
  });

  try {
    guilds = await request('api/guilds');
    for (const guild of guilds) {
      const option = new Option(`${guild.label} · ${guild.name}`, guild.id);
      serverSelect.add(option);
    }
    serverSelect.value = guilds[0]?.id || '';
    drawServerBadge();
    drawEditorLoading('Selecciona un miembro para administrar sus rangos.');
    results.append(node('p', 'rolemanager-empty-results', 'Busca un miembro de este servidor.'));
  } catch (error) {
    serverSelect.disabled = true;
    searchButton.disabled = true;
    drawEditorLoading('No se pudo cargar este Discord.');
    notify(error.message || 'No se pudo cargar este Discord.', true);
  }

  return () => root.replaceChildren();
}

