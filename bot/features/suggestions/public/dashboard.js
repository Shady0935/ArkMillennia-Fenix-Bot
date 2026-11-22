const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

export async function mount(target, { api }) {
  target.innerHTML = `<section class="suggestions-page">
    <header class="sg-heading"><div><span class="sg-eyebrow">ARKMILLENNIA FENIX · COMUNIDAD</span><h1>Sugerencias</h1><p>Configura el buzón y revisa las propuestas de la comunidad.</p></div><div class="sg-stats"><span><b id="sg-pending">0</b> pendientes</span><span><b id="sg-accepted">0</b> aceptadas</span><span><b id="sg-denied">0</b> denegadas</span></div></header>
    <div class="sg-layout"><form class="sg-card sg-config" id="sg-form"><div class="sg-title"><div><h2>Configuración</h2><p>Elige el estilo de cada mensaje y personaliza sus textos.</p></div><label class="millenniafenix-toggle-control"><input id="sg-enabled" type="checkbox"><span class="millenniafenix-toggle-track"></span><span class="millenniafenix-toggle-text">Sugerencias activas</span></label></div>
      <div class="sg-grid"><label>Canal de sugerencias<select id="sg-channel" required></select></label><label>Canal del panel<select id="sg-panel-channel"></select></label><label>Formato del panel<select id="sg-panel-display"><option value="embed">Embed clásico</option><option value="components_v2">Components V2</option></select></label><label>Formato de las sugerencias<select id="sg-suggestion-display"><option value="embed">Embed clásico</option><option value="components_v2">Components V2</option></select></label></div>
      <div class="sg-votebar-setting"><label class="sg-votebar-control"><input id="sg-vote-bar" type="checkbox"><span class="sg-votebar-track" aria-hidden="true"></span><span>Barra de emojis experimental</span></label><small class="sg-toggle-hint">Desactivada por ahora. Los porcentajes de voto siempre se mostrarán.</small></div>
      <label>Título del panel<input id="sg-panel-title" maxlength="100" required></label><label>Descripción del panel<textarea id="sg-panel-description" rows="3" maxlength="3500" required></textarea></label>
      <div class="sg-grid"><label>Título de cada sugerencia<input id="sg-suggestion-title" maxlength="100" required></label><label>Texto del botón para enviar<input id="sg-submit-label" maxlength="80" required></label><label>Etiqueta voto positivo<input id="sg-up-label" maxlength="60" required></label><label>Etiqueta voto negativo<input id="sg-down-label" maxlength="60" required></label><label>Máximo de caracteres<input id="sg-max-length" type="number" min="50" max="3500" required></label></div>
      <div class="sg-grid sg-colors"><label>Color pendiente<input id="sg-pending-color" type="color"></label><label>Color aceptada<input id="sg-accepted-color" type="color"></label><label>Color denegada<input id="sg-denied-color" type="color"></label></div>
      <label>Roles moderadores<select id="sg-moderator-roles" multiple size="5"></select><small>También pueden moderar los administradores del bot y quienes tengan permisos de administrador.</small></label>
      <div class="sg-actions"><button class="sg-button" type="submit">Guardar configuración</button><button class="sg-button secondary" type="button" id="sg-publish">Guardar y publicar panel</button></div></form>
      <section class="sg-card"><div class="sg-title"><div><h2>Lista de bloqueo</h2><p>Las personas bloqueadas no pueden enviar nuevas propuestas.</p></div></div><form id="sg-blacklist-form" class="sg-blacklist-form"><input id="sg-user-id" inputmode="numeric" placeholder="ID de usuario" required><input id="sg-block-reason" maxlength="300" placeholder="Motivo (opcional)"><button class="sg-button" type="submit">Bloquear</button></form><div id="sg-blacklist" class="sg-blacklist"></div></section>
    </div><section class="sg-card sg-list-card"><div class="sg-title"><div><h2>Propuestas</h2><p>Las últimas 200 sugerencias, con sus votos actuales.</p></div><div class="sg-list-controls"><select id="sg-filter"><option value="all">Todos los estados</option><option value="pending">Pendientes</option><option value="accepted">Aceptadas</option><option value="denied">Denegadas</option></select><button class="sg-button secondary" type="button" id="sg-refresh">Actualizar</button></div></div><div id="sg-list" class="sg-list"></div></section>
    <dialog class="sg-delete-dialog" id="sg-delete-dialog" aria-labelledby="sg-delete-title"><span class="sg-eyebrow">ACCIÓN DEFINITIVA</span><h2 id="sg-delete-title">¿Eliminar esta sugerencia?</h2><p id="sg-delete-copy">Se intentará borrar la publicación de Discord y se eliminarán también sus votos guardados.</p><div class="sg-delete-actions"><button class="sg-button secondary" type="button" id="sg-delete-cancel">Cancelar</button><button class="sg-button danger" type="button" id="sg-delete-confirm">Eliminar sugerencia</button></div></dialog>
  </section>`;
  const $ = selector => target.querySelector(selector);
  let state;
  let pendingDeleteId = '';
  const toast = (text, type = 'success') => api.toast(text, type, 'suggestions');
  const request = async (url, options = {}) => { if (options.body && typeof options.body !== 'string') options.body = JSON.stringify(options.body); const result = await api(url, options); if (result?.error) throw Error(result.error); return result; };
  const channelOptions = (selected, empty) => `<option value="">${esc(empty)}</option>${state.channels.map(c => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>#${esc(c.name)}</option>`).join('')}`;
  const roleOptions = selected => state.roles.map(r => `<option value="${esc(r.id)}" ${selected.includes(r.id) ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  function fill() {
    const c = state.config;
    $('#sg-enabled').checked = c.enabled; $('#sg-channel').innerHTML = channelOptions(c.channelId, 'Selecciona canal'); $('#sg-panel-channel').innerHTML = channelOptions(c.panelChannelId, 'Sin panel publicado');
    $('#sg-panel-display').value = c.panelDisplay; $('#sg-suggestion-display').value = c.suggestionDisplay;
    $('#sg-vote-bar').checked = c.showVoteBar === true;
    $('#sg-panel-title').value = c.panelTitle; $('#sg-panel-description').value = c.panelDescription; $('#sg-suggestion-title').value = c.suggestionTitle;
    $('#sg-submit-label').value = c.submitLabel; $('#sg-up-label').value = c.upLabel; $('#sg-down-label').value = c.downLabel; $('#sg-max-length').value = c.maxLength;
    $('#sg-pending-color').value = c.pendingColor; $('#sg-accepted-color').value = c.acceptedColor; $('#sg-denied-color').value = c.deniedColor;
    $('#sg-moderator-roles').innerHTML = roleOptions(c.moderatorRoleIds);
    $('#sg-pending').textContent = state.counts.pending; $('#sg-accepted').textContent = state.counts.accepted; $('#sg-denied').textContent = state.counts.denied;
    renderList(); renderBlacklist();
  }
  function readConfig() { return { enabled: $('#sg-enabled').checked, channelId: $('#sg-channel').value, panelChannelId: $('#sg-panel-channel').value, panelDisplay: $('#sg-panel-display').value, suggestionDisplay: $('#sg-suggestion-display').value,
    showVoteBar: $('#sg-vote-bar').checked,
    panelTitle: $('#sg-panel-title').value, panelDescription: $('#sg-panel-description').value, suggestionTitle: $('#sg-suggestion-title').value, submitLabel: $('#sg-submit-label').value, upLabel: $('#sg-up-label').value, downLabel: $('#sg-down-label').value, maxLength: Number($('#sg-max-length').value),
    pendingColor: $('#sg-pending-color').value, acceptedColor: $('#sg-accepted-color').value, deniedColor: $('#sg-denied-color').value, moderatorRoleIds: [...$('#sg-moderator-roles').selectedOptions].map(o => o.value) }; }
  function renderList() {
    const filter = $('#sg-filter').value, rows = state.suggestions.filter(s => filter === 'all' || s.status === filter);
    $('#sg-list').innerHTML = rows.length ? rows.map(s => `<article class="sg-suggestion"><div class="sg-suggestion-body"><div class="sg-record-title"><span class="sg-status ${esc(s.status)}">${s.status === 'pending' ? 'Pendiente' : s.status === 'accepted' ? 'Aceptada' : 'Denegada'}</span><strong>${esc(s.authorName)}</strong><small>${esc(new Date(s.createdAt).toLocaleString())} · ID ${esc(s.id)}</small></div><p>${esc(s.content)}</p><div class="sg-votes">👍 ${s.upvotes} · 👎 ${s.downvotes}${s.reason ? ` · Motivo: ${esc(s.reason)}` : ''}</div></div><div class="sg-record-actions">${s.status === 'pending' ? `<div class="sg-moderate"><input data-reason="${esc(s.id)}" maxlength="300" placeholder="Motivo si se deniega"><button data-moderate="accepted" data-id="${esc(s.id)}">Aceptar</button><button class="danger" data-moderate="denied" data-id="${esc(s.id)}">Denegar</button></div>` : ''}<button class="sg-delete-button" type="button" data-delete="${esc(s.id)}">Eliminar</button></div></article>`).join('') : '<p class="sg-empty">No hay propuestas en este estado.</p>';
  }
  function renderBlacklist() { $('#sg-blacklist').innerHTML = state.blacklist.length ? state.blacklist.map(u => `<article class="sg-blocked"><span><strong>${esc(u.username || u.userId)}</strong><small>${esc(u.userId)}${u.reason ? ` · ${esc(u.reason)}` : ''}</small></span><button data-unblock="${esc(u.userId)}">Desbloquear</button></article>`).join('') : '<p class="sg-empty">La lista está vacía.</p>'; }
  async function load() { state = await request('/api/state'); fill(); }
  $('#sg-form').addEventListener('submit', async event => { event.preventDefault(); toast('Guardando configuración…', 'loading'); try { state = await request('/api/config', { method: 'PUT', body: { config: readConfig() } }); fill(); toast(state.panelUpdated === true ? 'Guardada y sincronizada en Discord.' : 'Configuración guardada.'); } catch (error) { toast(error.message, 'error'); } });
  $('#sg-publish').addEventListener('click', async () => { toast('Publicando panel…', 'loading'); try { await request('/api/config', { method: 'PUT', body: { config: readConfig() } }); const result = await request('/api/panel', { method: 'POST', body: {} }); toast(`Panel publicado: ${result.url}`); } catch (error) { toast(error.message, 'error'); } });
  $('#sg-refresh').addEventListener('click', () => load().then(() => toast('Lista actualizada.')).catch(error => toast(error.message, 'error'))); $('#sg-filter').addEventListener('change', renderList);
  $('#sg-list').addEventListener('click', async event => {
    const remove = event.target.closest('[data-delete]');
    if (remove) {
      pendingDeleteId = remove.dataset.delete;
      const suggestion = state.suggestions.find(item => item.id === pendingDeleteId);
      $('#sg-delete-copy').textContent = `Se eliminará “${suggestion?.authorName || 'esta persona'}: ${(suggestion?.content || '').slice(0, 180)}” y todos sus votos. Se intentará borrar también el mensaje de Discord.`;
      $('#sg-delete-dialog').showModal();
      return;
    }
    const button = event.target.closest('[data-moderate]'); if (!button) return;
    button.disabled = true;
    try { await request(`/api/suggestions/${encodeURIComponent(button.dataset.id)}/moderate`, { method: 'POST', body: { status: button.dataset.moderate, reason: $(`[data-reason="${CSS.escape(button.dataset.id)}"]`)?.value || '' } }); await load(); toast('Sugerencia moderada y actualizada en Discord.'); }
    catch (error) { button.disabled = false; toast(error.message, 'error'); }
  });
  $('#sg-delete-cancel').addEventListener('click', () => $('#sg-delete-dialog').close());
  $('#sg-delete-dialog').addEventListener('close', () => { pendingDeleteId = ''; });
  $('#sg-delete-confirm').addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    const button = $('#sg-delete-confirm'); button.disabled = true; toast('Eliminando sugerencia…', 'loading');
    try {
      const result = await request(`/api/suggestions/${encodeURIComponent(pendingDeleteId)}`, { method: 'DELETE' });
      $('#sg-delete-dialog').close(); await load();
      toast(result.messageDeleted ? 'Sugerencia eliminada de Discord y de la base de datos.' : 'Sugerencia y votos eliminados; el mensaje ya no estaba disponible en Discord.');
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; }
  });
  $('#sg-blacklist-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { await request('/api/blacklist', { method: 'POST', body: { userId: $('#sg-user-id').value.trim(), reason: $('#sg-block-reason').value.trim() } }); $('#sg-user-id').value = ''; $('#sg-block-reason').value = ''; await load(); toast('Usuario añadido a la lista de bloqueo.'); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; } });
  $('#sg-blacklist').addEventListener('click', async event => { const button = event.target.closest('[data-unblock]'); if (!button) return; button.disabled = true; try { await request(`/api/blacklist/${encodeURIComponent(button.dataset.unblock)}`, { method: 'DELETE' }); await load(); toast('Usuario desbloqueado.'); } catch (error) { button.disabled = false; toast(error.message, 'error'); } });
  try { await load(); } catch (error) { toast(error.message, 'error'); }
}
