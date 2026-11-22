export async function mount(target, { api, icon }) {
  target.innerHTML = `
    <div class="community-app">
      <header class="community-header">
        <div class="community-heading-icon"></div>
        <div><span class="community-eyebrow">ARKMILLENNIA FENIX · COMUNIDAD</span><h1>Bienvenidas y acceso</h1><p>Automatiza los primeros pasos de cada miembro.</p></div>
        <span class="community-server"><i></i><span id="community-server-name">Servidor principal</span></span>
      </header>
      <div class="community-tabs" role="tablist" aria-label="Ajustes de comunidad">
        <button class="community-tab selected" type="button" role="tab" aria-selected="true" data-tab="messages">Mensajes y roles</button>
        <button class="community-tab" type="button" role="tab" aria-selected="false" data-tab="verification">Verificación</button>
      </div>
      <p id="community-notice" class="community-notice" role="status" hidden></p>
      <section id="community-panel-messages" class="community-panel" role="tabpanel">
        <div class="community-grid">
          <div class="community-settings">
            <section class="community-card">
              <div class="community-card-heading"><div><span class="community-kicker">01 · AL ENTRAR</span><h2>Bienvenida</h2></div><label class="community-toggle"><input id="welcome-enabled" type="checkbox"><span>Activa</span></label></div>
              <div id="welcome-fields" class="community-fields" data-section="welcome">
                <label class="community-field" for="welcome-channel">Canal<select id="welcome-channel"><option value="">Elige un canal</option></select></label>
                <label class="community-field" for="welcome-message">Mensaje<textarea id="welcome-message" rows="4" maxlength="3000"></textarea><small>Variables: {user}, {username}, {server}, {count}</small></label>
                <button id="test-welcome" class="community-button secondary" type="button">Enviar prueba</button>
              </div>
            </section>
            <section class="community-card">
              <div class="community-card-heading"><div><span class="community-kicker">02 · AL SALIR</span><h2>Despedida</h2></div><label class="community-toggle"><input id="goodbye-enabled" type="checkbox"><span>Activa</span></label></div>
              <div id="goodbye-fields" class="community-fields" data-section="goodbye">
                <label class="community-field" for="goodbye-channel">Canal<select id="goodbye-channel"><option value="">Elige un canal</option></select></label>
                <label class="community-field" for="goodbye-message">Mensaje<textarea id="goodbye-message" rows="3" maxlength="3000"></textarea><small>Variables: {username}, {server}, {count}</small></label>
                <button id="test-goodbye" class="community-button secondary" type="button">Enviar prueba</button>
              </div>
            </section>
            <section class="community-card">
              <div class="community-card-heading"><div><span class="community-kicker">03 · AUTOMATIZACIÓN</span><h2>Mensaje privado y roles</h2></div></div>
              <div class="community-fields">
                <label class="community-toggle full"><input id="dm-enabled" type="checkbox"><span>Enviar bienvenida por mensaje privado</span></label>
                <label id="dm-fields" class="community-field" for="dm-message">Mensaje privado<textarea id="dm-message" rows="3" maxlength="1800"></textarea><small>Variables: {username}, {server}, {count}</small></label>
                <label class="community-field" for="auto-roles">Roles automáticos<select id="auto-roles" multiple size="5" aria-describedby="auto-role-help"></select><small id="auto-role-help">Mantén Ctrl o ⌘ para seleccionar varios. El bot solo muestra roles que puede asignar.</small></label>
              </div>
            </section>
            <div class="community-actions"><span>Guarda los cambios antes de probar o publicar.</span><button id="save-messages" class="community-button primary" type="button">Guardar cambios</button></div>
          </div>
          <aside class="community-preview-column">
            <div class="community-preview-label">VISTA PREVIA</div>
            <article class="discord-message-preview"><div class="discord-message-avatar">D</div><div class="discord-message-body"><div class="discord-message-author">Millennia Fenix Bot <span>BOT</span></div><div id="welcome-preview" class="discord-message-text"></div></div></article>
            <p class="community-preview-help">La vista previa muestra el formato del mensaje. La prueba real se envía al canal seleccionado.</p>
            <div class="community-info-card"><span class="material-symbols-outlined" aria-hidden="true">shield</span><p>El bot solo asigna los roles que estén por debajo de su rol más alto.</p></div>
          </aside>
        </div>
      </section>
      <section id="community-panel-verification" class="community-panel" role="tabpanel" hidden>
        <div class="verification-layout">
          <section class="community-card verification-card">
            <div class="community-card-heading"><div><span class="community-kicker">CONTROL DE ACCESO</span><h2>Verificación con botón</h2><p>Publica o actualiza un mensaje que asigna un rol al pulsar “Verificarme”.</p></div><label class="community-toggle"><input id="verify-enabled" type="checkbox"><span>Activa</span></label></div>
            <div class="community-fields">
              <label class="community-field" for="verify-channel">Canal de verificación<select id="verify-channel"><option value="">Elige un canal</option></select></label>
              <label class="community-field" for="verify-role">Rol que se asignará<select id="verify-role"><option value="">Elige un rol</option></select></label>
              <label class="community-field" for="verify-message">Instrucciones<textarea id="verify-message" rows="4" maxlength="1800"></textarea></label>
              <label class="community-field" for="verify-button-label">Texto del botón<input id="verify-button-label" maxlength="80"></label>
              <div class="verification-actions"><button id="publish-verification" class="community-button secondary" type="button">Publicar o actualizar mensaje</button><button id="save-verification" class="community-button primary" type="button">Guardar cambios</button></div>
              <p class="community-preview-help">Al volver a publicarlo, el bot actualizará su mensaje anterior si sigue disponible.</p>
            </div>
          </section>
          <aside class="verification-aside"><div class="community-preview-label">ORDEN RECOMENDADO</div><ol><li>Activa la verificación.</li><li>Elige el canal visible para nuevos miembros.</li><li>Selecciona el rol que desbloquea el resto del servidor.</li><li>Guarda y publica el mensaje.</li></ol><div class="community-info-card"><span class="material-symbols-outlined" aria-hidden="true">info</span><p>El rol elegido debe estar por debajo del rol del bot y este necesita permiso para administrar roles.</p></div></aside>
        </div>
      </section>
    </div>`;

  const $ = id => target.querySelector(`#${id}`);
  const notice = message => { const box = $('community-notice'); box.textContent = message || ''; box.hidden = !message; };
  const headingIcon = target.querySelector('.community-heading-icon'); headingIcon.append(icon('campaign'));
  let config, resources;

  function addOptions(select, values, selected, placeholder, multiple = false) {
    select.replaceChildren();
    if (!multiple) { const empty = document.createElement('option'); empty.value = ''; empty.textContent = placeholder; select.append(empty); }
    for (const item of values) {
      const option = document.createElement('option'); option.value = item.id;
      option.textContent = item.category ? `# ${item.name} · ${item.category}` : item.name;
      option.selected = multiple ? selected.includes(item.id) : selected === item.id;
      select.append(option);
    }
  }
  function fillForm() {
    $('community-server-name').textContent = resources.guildName || 'Servidor principal';
    addOptions($('welcome-channel'), resources.channels, config.welcomeChannelId, 'Elige un canal');
    addOptions($('goodbye-channel'), resources.channels, config.goodbyeChannelId, 'Elige un canal');
    addOptions($('verify-channel'), resources.channels, config.verificationChannelId, 'Elige un canal');
    addOptions($('verify-role'), resources.roles, config.verificationRoleId, 'Elige un rol');
    addOptions($('auto-roles'), resources.roles, config.autoRoleIds || [], '', true);
    $('welcome-enabled').checked = config.welcomeEnabled;
    $('welcome-message').value = config.welcomeMessage;
    $('goodbye-enabled').checked = config.goodbyeEnabled;
    $('goodbye-message').value = config.goodbyeMessage;
    $('dm-enabled').checked = config.welcomeDmEnabled;
    $('dm-message').value = config.welcomeDmMessage;
    $('verify-enabled').checked = config.verificationEnabled;
    $('verify-message').value = config.verificationMessage;
    $('verify-button-label').value = config.verificationButtonText;
    updateControls(); updatePreview();
  }
  function updateControls() {
    $('welcome-fields').querySelectorAll('select,textarea,button').forEach(control => { control.disabled = !$('welcome-enabled').checked; });
    $('goodbye-fields').querySelectorAll('select,textarea,button').forEach(control => { control.disabled = !$('goodbye-enabled').checked; });
    $('dm-message').disabled = !$('dm-enabled').checked;
    $('verify-channel').disabled = !$('verify-enabled').checked;
    $('verify-role').disabled = !$('verify-enabled').checked;
    $('verify-message').disabled = !$('verify-enabled').checked;
    $('verify-button-label').disabled = !$('verify-enabled').checked;
    $('publish-verification').disabled = !$('verify-enabled').checked;
  }
  function fill(template) {
    const user = '@Usuario';
    return String(template || '').replaceAll('{user}', user).replaceAll('{username}', 'Usuario')
      .replaceAll('{server}', resources.guildName || 'ArkMillennia Fenix').replaceAll('{count}', '101');
  }
  function updatePreview() {
    $('welcome-preview').textContent = fill($('welcome-message').value || config.welcomeMessage);
  }
  function collect() {
    return {
      ...config,
      welcomeEnabled: $('welcome-enabled').checked,
      welcomeChannelId: $('welcome-channel').value,
      welcomeMessage: $('welcome-message').value,
      goodbyeEnabled: $('goodbye-enabled').checked,
      goodbyeChannelId: $('goodbye-channel').value,
      goodbyeMessage: $('goodbye-message').value,
      welcomeDmEnabled: $('dm-enabled').checked,
      welcomeDmMessage: $('dm-message').value,
      autoRoleIds: [...$('auto-roles').selectedOptions].map(option => option.value),
      verificationEnabled: $('verify-enabled').checked,
      verificationChannelId: $('verify-channel').value,
      verificationRoleId: $('verify-role').value,
      verificationMessage: $('verify-message').value,
      verificationButtonText: $('verify-button-label').value,
    };
  }
  async function save(button) {
    button.disabled = true; notice('');
    try {
      const result = await api('api/config', { method: 'PUT', body: JSON.stringify(collect()) });
      config = result.config; notice('Cambios guardados.'); fillForm();
    } finally { button.disabled = false; }
  }
  async function sendTest(kind, button) {
    button.disabled = true; notice('');
    try { await api(`api/test/${kind}`, { method: 'POST', body: '{}' }); notice(kind === 'welcome' ? 'Prueba de bienvenida enviada.' : 'Prueba de despedida enviada.'); }
    finally { button.disabled = false; }
  }
  function reportError(error) { notice(error?.message || 'No se pudo completar la acción.'); }

  target.querySelectorAll('.community-tab').forEach(button => button.addEventListener('click', () => {
    target.querySelectorAll('.community-tab').forEach(tab => { const selected = tab === button; tab.classList.toggle('selected', selected); tab.setAttribute('aria-selected', String(selected)); });
    target.querySelectorAll('.community-panel').forEach(panel => { panel.hidden = panel.id !== `community-panel-${button.dataset.tab}`; });
    notice('');
  }));
  ['welcome-enabled','goodbye-enabled','dm-enabled','verify-enabled'].forEach(id => $(id).addEventListener('change', updateControls));
  ['welcome-message','goodbye-message'].forEach(id => $(id).addEventListener('input', updatePreview));
  $('save-messages').addEventListener('click', () => save($('save-messages')).catch(reportError));
  $('save-verification').addEventListener('click', () => save($('save-verification')).catch(reportError));
  $('test-welcome').addEventListener('click', () => sendTest('welcome', $('test-welcome')).catch(reportError));
  $('test-goodbye').addEventListener('click', () => sendTest('goodbye', $('test-goodbye')).catch(reportError));
  $('publish-verification').addEventListener('click', async () => {
    const button = $('publish-verification'); button.disabled = true; notice('');
    try {
      await api('api/config', { method: 'PUT', body: JSON.stringify(collect()) });
      const result = await api('api/verification/publish', { method: 'POST', body: '{}' });
      config = await api('api/config'); fillForm();
      notice(result.updated ? 'Mensaje de verificación actualizado.' : 'Mensaje de verificación publicado.');
    } catch (error) { reportError(error); }
    finally { button.disabled = !$('verify-enabled').checked; }
  });
  target.addEventListener('input', updatePreview);

  try {
    [config, resources] = await Promise.all([api('api/config'), api('api/resources')]);
    fillForm();
  } catch (error) { notice(error.message || 'No se pudo cargar la configuración.'); }
  return () => { target.replaceChildren(); };
}
