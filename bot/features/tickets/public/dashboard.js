const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function mount(target, { api }) {
  target.innerHTML = `<section class="tickets-page">
    <header class="tickets-heading"><div><span class="tickets-eyebrow">ARKMILLENNIA FENIX · SOPORTE</span><h1>Tickets</h1><p>Configura el centro de ayuda y gestiona las solicitudes de tu comunidad.</p></div><div class="tickets-stats"><span><b id="ticket-open-count">0</b> abiertos</span><span><b id="ticket-archived-count">0</b> archivados</span></div></header>
    <p id="tickets-notice" class="tickets-notice" role="status" aria-live="polite" hidden></p>
    <div class="tickets-layout"><form id="tickets-form" class="tickets-card tickets-config">
      <div class="tickets-card-title"><div><h2>Configuración</h2><p>El panel publicado se actualiza al guardar y volver a publicarlo.</p></div><label class="tickets-switch millenniafenix-toggle-control"><input id="tickets-enabled" type="checkbox"><span class="millenniafenix-toggle-track"></span><span class="millenniafenix-toggle-text">Tickets activos</span></label></div>
      <div class="tickets-grid">
        <label>Canal del panel<select id="panel-channel" required></select></label>
        <label>Forma de elegir categoría<select id="panel-style"><option value="buttons">Botones</option><option value="select">Menú desplegable</option></select></label>
        <label>Formato del panel<select id="panel-display"><option value="embed">Embed clásico</option><option value="components_v2">Components V2</option></select></label>
        <label>Categoría para tickets<select id="ticket-category" required></select></label>
        <label>Categoría de archivo<select id="archive-category"></select></label>
        <label>Rol de soporte<select id="support-role" required></select></label>
        <label>Canal de registros<select id="log-channel"></select></label>
        <label>Tickets abiertos por usuario<input id="max-open" type="number" min="1" max="5" required></label>
      </div>
      <label>Título del panel<input id="panel-title" maxlength="100" required></label>
      <label>Descripción del panel<textarea id="panel-description" rows="3" maxlength="3500" required></textarea></label>
      <div class="tickets-image-control"><div><strong>Imagen del panel</strong><p>Se mostrará como miniatura en el embed de Discord. PNG, JPEG, GIF o WebP · máximo 8 MiB.</p><img id="ticket-panel-image" alt="Vista previa de la imagen del panel" hidden></div><div class="tickets-image-actions"><label class="tickets-button secondary" for="ticket-image-file">Subir imagen<input id="ticket-image-file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden></label><button class="tickets-button secondary" id="remove-ticket-image" type="button">Quitar imagen</button></div></div>
      <label>Mensaje al abrir <small>Puedes usar {user} y {support}</small><textarea id="welcome-message" rows="3" maxlength="1800" required></textarea></label>
      <div class="tickets-category-head"><div><h3>Categorías de atención</h3><p>Define los motivos disponibles y un rol opcional para cada uno.</p></div><button type="button" class="tickets-button secondary" id="add-ticket-category">Añadir categoría</button></div>
      <div id="ticket-categories" class="tickets-category-list"></div>
      <div class="tickets-actions"><button class="tickets-button" type="submit">Guardar configuración</button><button class="tickets-button secondary" type="button" id="publish-ticket-panel">Guardar y publicar panel</button></div>
    </form>
    <section class="tickets-card tickets-list"><div class="tickets-card-title"><div><h2>Solicitudes</h2><p>Últimos 100 tickets registrados.</p></div><button type="button" class="tickets-button secondary" id="refresh-tickets">Actualizar</button></div>
      <div class="tickets-filters"><input id="ticket-search" type="search" placeholder="Buscar usuario, canal o categoría"><select id="ticket-status"><option value="all">Todos los estados</option><option value="open">Abiertos</option><option value="archived">Archivados</option><option value="deleted">Cerrados</option></select></div><div id="ticket-records" class="ticket-records"></div>
    </section></div>
    <dialog class="ticket-close-dialog" id="ticket-close-dialog"><form method="dialog"><button class="ticket-close-x" aria-label="Cerrar">×</button></form><span class="tickets-eyebrow">CIERRE DEFINITIVO</span><h2>¿Cerrar este ticket?</h2><p>Se guardará la transcripción y después se eliminará el canal de Discord. Podrás consultar la transcripción desde esta lista.</p><div class="ticket-close-actions"><button type="button" class="tickets-button secondary" id="cancel-ticket-close">Cancelar</button><button type="button" class="tickets-button danger" id="confirm-ticket-close">Guardar y eliminar canal</button></div></dialog>
  </section>`;

  const $ = selector => target.querySelector(selector);
  const form = $('#tickets-form');
  let state = null;
  const request = async (url, options = {}) => {
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) options.body = JSON.stringify(options.body);
    const response = await api(url, options);
    if (response?.error) throw new Error(response.error);
    return response;
  };
  const notice = $('#tickets-notice');
  const show = (message, error = false) => { notice.textContent = String(message || ''); notice.classList.toggle('error', error); notice.hidden = !message; };
  const hide = () => { notice.hidden = true; };
  const optionList = (items, selected, emptyLabel) => `<option value="">${escapeHtml(emptyLabel)}</option>${items.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}`;
  const roleOptions = (selected, includeEmpty = true) => `${includeEmpty ? '<option value="">Sin restricción</option>' : '<option value="">Selecciona un rol</option>'}${state.roles.map(role => `<option value="${escapeHtml(role.id)}" ${role.id === selected ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('')}`;
  const channelOptions = (type, selected, empty) => optionList(state.channels.filter(item => item.type === type), selected, empty);
  function addCategory(category = { key: '', name: '', description: '', emoji: '', requiredRoleId: '', enabled: true }) {
    const row = document.createElement('article'); row.className = 'tickets-category-row'; row.dataset.key = category.key || `category-${Date.now().toString(36)}`;
    row.innerHTML = `<div class="tickets-category-fields"><label>Nombre<input data-field="name" maxlength="80" required value="${escapeHtml(category.name)}"></label><label>Identificador<input data-field="key" maxlength="32" pattern="[a-z][a-z0-9_-]{1,31}" required value="${escapeHtml(category.key)}" placeholder="general"></label><label>Descripción<input data-field="description" maxlength="100" required value="${escapeHtml(category.description)}"></label><label>Emoji<input data-field="emoji" maxlength="32" value="${escapeHtml(category.emoji || '')}" placeholder="❓"></label><label>Rol requerido<select data-field="requiredRoleId">${roleOptions(category.requiredRoleId)}</select></label><label class="tickets-inline-check millenniafenix-toggle-control"><input data-field="enabled" type="checkbox" ${category.enabled ? 'checked' : ''}><span class="millenniafenix-toggle-track compact"></span><span class="millenniafenix-toggle-text">Disponible</span></label></div><button type="button" class="tickets-remove" aria-label="Eliminar categoría">Quitar</button>`;
    row.querySelector('.tickets-remove').addEventListener('click', () => row.remove()); $('#ticket-categories').append(row);
  }
  function readConfig() {
    const categories = [...target.querySelectorAll('.tickets-category-row')].map(row => ({
      key: row.querySelector('[data-field="key"]').value.trim(), name: row.querySelector('[data-field="name"]').value.trim(),
      description: row.querySelector('[data-field="description"]').value.trim(), requiredRoleId: row.querySelector('[data-field="requiredRoleId"]').value,
      emoji: row.querySelector('[data-field="emoji"]').value.trim(),
      enabled: row.querySelector('[data-field="enabled"]').checked,
    }));
    return { enabled: $('#tickets-enabled').checked, panelStyle: $('#panel-style').value, panelDisplay: $('#panel-display').value, panelImageName: state?.config?.panelImageName || '', panelChannelId: $('#panel-channel').value, ticketCategoryId: $('#ticket-category').value,
      archiveCategoryId: $('#archive-category').value, supportRoleId: $('#support-role').value, logChannelId: $('#log-channel').value,
      maxOpenPerUser: Number($('#max-open').value), panelTitle: $('#panel-title').value.trim(), panelDescription: $('#panel-description').value.trim(),
      welcomeMessage: $('#welcome-message').value.trim(), categories };
  }
  function fillConfig(config) {
    $('#tickets-enabled').checked = config.enabled; $('#panel-channel').innerHTML = channelOptions('text', config.panelChannelId, 'Selecciona canal');
    $('#panel-style').value = config.panelStyle || 'buttons';
    $('#panel-display').value = config.panelDisplay || 'embed';
    $('#ticket-category').innerHTML = channelOptions('category', config.ticketCategoryId, 'Selecciona categoría');
    $('#archive-category').innerHTML = channelOptions('category', config.archiveCategoryId, 'Sin categoría de archivo');
    $('#support-role').innerHTML = roleOptions(config.supportRoleId, false); $('#log-channel').innerHTML = channelOptions('text', config.logChannelId, 'Sin canal de registros');
    $('#max-open').value = config.maxOpenPerUser; $('#panel-title').value = config.panelTitle; $('#panel-description').value = config.panelDescription;
    $('#welcome-message').value = config.welcomeMessage; $('#ticket-categories').replaceChildren(); config.categories.forEach(addCategory);
    const image = $('#ticket-panel-image'); image.hidden = !config.panelImageName;
    image.src = config.panelImageName ? `/extensions/tickets/api/panel-image?v=${encodeURIComponent(config.panelImageName)}` : '';
    $('#remove-ticket-image').disabled = !config.panelImageName;
  }
  const date = value => value ? new Date(value).toLocaleString() : '—';
  function renderTickets() {
    const q = $('#ticket-search').value.trim().toLocaleLowerCase(), status = $('#ticket-status').value;
    const list = state.tickets.filter(ticket => (status === 'all' || ticket.status === status) && `${ticket.ownerName} ${ticket.categoryName} ${ticket.channelId}`.toLocaleLowerCase().includes(q));
    $('#ticket-records').innerHTML = list.length ? list.map(ticket => `<article class="ticket-record"><div class="ticket-record-main"><div class="ticket-record-title"><span class="ticket-status ${escapeHtml(ticket.status)}">${escapeHtml(ticket.status === 'open' ? 'Abierto' : ticket.status === 'archived' ? 'Archivado' : 'Cerrado')}</span><strong>${escapeHtml(ticket.categoryName)}</strong></div><p>${escapeHtml(ticket.ownerName)} · <a href="${escapeHtml(ticket.url)}" target="_blank" rel="noopener">#${escapeHtml(ticket.channelId)}</a></p><small>Creado ${escapeHtml(date(ticket.createdAt))}${ticket.claimedByName ? ` · Atendiendo: ${escapeHtml(ticket.claimedByName)}` : ''}</small></div><div class="ticket-record-actions">${ticket.status === 'open' ? `<button data-action="claim" data-id="${escapeHtml(ticket.channelId)}">${ticket.claimedById ? 'Liberar' : 'Atender'}</button><button data-action="archive" data-id="${escapeHtml(ticket.channelId)}">Archivar</button><button class="ticket-danger" data-action="close" data-id="${escapeHtml(ticket.channelId)}">Cerrar</button>` : ''}${ticket.status === 'archived' ? `<button data-action="reopen" data-id="${escapeHtml(ticket.channelId)}">Reabrir</button>` : ''}${ticket.transcriptAvailable ? `<a class="ticket-transcript" href="/extensions/tickets/api/tickets/${encodeURIComponent(ticket.channelId)}/transcript" target="_blank" rel="noopener">Ver transcripción</a>` : ''}</div></article>`).join('') : '<p class="tickets-empty">No hay tickets para mostrar.</p>';
  }
  async function load() {
    hide(); state = await request('/api/state'); fillConfig(state.config); $('#ticket-open-count').textContent = state.counts.open; $('#ticket-archived-count').textContent = state.counts.archived; renderTickets();
  }
  async function save() { state = await request('/api/config', { method: 'PUT', body: { config: readConfig() } }); fillConfig(state.config); renderTickets(); return state.panelUpdated; }
  form.addEventListener('submit', async event => { event.preventDefault(); show('Guardando configuración…', false, 'loading'); try { const updated = await save(); show(updated === true ? 'Configuración guardada y panel actualizado en Discord.' : updated === false ? 'Configuración guardada, pero no se pudo actualizar el panel publicado.' : 'Configuración guardada.', false, 'success'); } catch (error) { show(error.message, true); } });
  $('#publish-ticket-panel').addEventListener('click', async () => { show('Guardando y publicando panel…', false, 'loading'); try { await save(); const result = await request('/api/panel', { method: 'POST', body: {} }); show(`Panel publicado correctamente en Discord. ${result.url}`); } catch (error) { show(error.message, true); } });
  $('#add-ticket-category').addEventListener('click', () => { if (target.querySelectorAll('.tickets-category-row').length >= 25) return show('Discord permite un máximo de 25 categorías.', true); addCategory(); });
  $('#ticket-image-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 8 * 1024 * 1024) { show('La imagen supera el máximo de 8 MiB.', true); event.target.value = ''; return; }
    const data = new FormData(); data.append('image', file);
    show('Subiendo imagen…', false, 'loading');
    try { const result = await request('/api/panel-image', { method: 'POST', body: data }); state.config.panelImageName = result.panelImageName; fillConfig(state.config); show('Imagen cargada. Publícala para actualizar el embed en Discord.'); }
    catch (error) { show(error.message, true); }
    finally { event.target.value = ''; }
  });
  $('#remove-ticket-image').addEventListener('click', async () => {
    show('Quitando imagen…', false, 'loading');
    try { await request('/api/panel-image', { method: 'DELETE' }); state.config.panelImageName = ''; fillConfig(state.config); show('Imagen quitada. Publícala para actualizar el embed en Discord.'); }
    catch (error) { show(error.message, true); }
  });
  $('#refresh-tickets').addEventListener('click', () => load().catch(error => show(error.message, true)));
  $('#ticket-search').addEventListener('input', renderTickets); $('#ticket-status').addEventListener('change', renderTickets);
  const closeDialog = $('#ticket-close-dialog'); let closingTicketId = '';
  $('#ticket-records').addEventListener('click', async event => { const button = event.target.closest('[data-action]'); if (!button) return; if (button.dataset.action === 'close') { closingTicketId = button.dataset.id; closeDialog.showModal(); return; } button.disabled = true; try { await request(`/api/tickets/${encodeURIComponent(button.dataset.id)}/action`, { method: 'POST', body: { action: button.dataset.action } }); await load(); show('Ticket actualizado.'); } catch (error) { button.disabled = false; show(error.message, true); } });
  $('#cancel-ticket-close').addEventListener('click', () => closeDialog.close());
  $('#confirm-ticket-close').addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; show('Guardando transcripción y cerrando ticket…', false, 'loading'); try { await request(`/api/tickets/${encodeURIComponent(closingTicketId)}/action`, { method: 'POST', body: { action: 'close' } }); closeDialog.close(); await load(); show('Transcripción guardada y canal eliminado.'); } catch (error) { show(error.message, true); } finally { button.disabled = false; closingTicketId = ''; } });
  try { await load(); } catch (error) { show(error.message, true); }
}
