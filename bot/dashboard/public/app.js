let session;
let activeViewId = null;
let viewCleanup = null;
let viewSequence = 0;
let viewDisposal = Promise.resolve();
const $ = id => document.getElementById(id);
const materialIcons = Object.freeze({
  module: 'extension', extension: 'extension', anuncios: 'campaign', campaign: 'campaign', grid: 'dashboard', dashboard: 'dashboard',
  people: 'group', group: 'group', server: 'dns', dns: 'dns', settings: 'settings', chart: 'monitoring', monitoring: 'monitoring',
  shield: 'shield', crown: 'workspace_premium', sword: 'military_tech', arrow: 'arrow_forward', logout: 'logout', menu: 'menu',
  plus: 'add', up: 'arrow_upward', down: 'arrow_downward', remove: 'delete', refresh: 'sync', sync: 'sync', upload: 'upload',
  history: 'history', logs: 'history', warning: 'warning', info: 'info', add: 'add', delete: 'delete', sync_alt: 'sync_alt',
  save: 'save', check_circle: 'check_circle', chevron_right: 'chevron_right', progress_activity: 'progress_activity',
});

function icon(name) {
  const symbol = document.createElement('span');
  symbol.classList.add('material-symbols-outlined', 'icon');
  symbol.setAttribute('aria-hidden', 'true');
  symbol.textContent = materialIcons[name] || 'extension';
  return symbol;
}
function updateMenuAccess() {
  const mobile = matchMedia('(max-width:760px)').matches;
  $('sidebar').inert = mobile && !document.body.classList.contains('menu-open');
}
function closeMenu() {
  document.body.classList.remove('menu-open');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
  $('nav-toggle').setAttribute('aria-label', 'Abrir menú');
  $('nav-overlay').hidden = true;
  if (matchMedia('(max-width:760px)').matches && $('sidebar').contains(document.activeElement)) $('nav-toggle').focus();
  updateMenuAccess();
}
function selectNavigation(id) {
  document.querySelectorAll('.nav-link').forEach(button => {
    const selected = button.dataset.id === id;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  closeMenu();
}
function disposeView() {
  viewSequence++;
  if (typeof viewCleanup === 'function') {
    const cleanup = viewCleanup;
    viewDisposal = Promise.resolve().then(cleanup).catch(() => {});
  }
  viewCleanup = null;
  activeViewId = null;
  $('extension-view').replaceChildren();
}
async function mountView(module) {
  disposeView();
  const sequence = ++viewSequence;
  await viewDisposal;
  if (sequence !== viewSequence) return;
  activeViewId = module.id;
  const target = $('extension-view');
  target.replaceChildren();
  const stylesheets = [];
  try {
    const prefix = '/extensions/' + encodeURIComponent(module.id) + '/';
    if (typeof module.client !== 'string' || !module.client.startsWith(prefix) || !module.client.endsWith('.js')) throw Error();
    for (const href of Array.isArray(module.styles) ? module.styles : []) {
      if (typeof href !== 'string' || !href.startsWith(prefix) || !href.endsWith('.css')) continue;
      const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = href; document.head.append(stylesheet); stylesheets.push(stylesheet);
    }
    const extension = await import(module.client);
    if (sequence !== viewSequence) { stylesheets.forEach(item => item.remove()); return; }
    if (typeof extension.mount !== 'function') throw Error();
    const api = async (endpoint, options = {}) => {
      if (typeof endpoint !== 'string' || !endpoint || endpoint.includes(String.fromCharCode(92))) throw Error('Ruta del módulo no válida');
      const url = new URL(endpoint.replace(/^\/+/, ''), location.origin + prefix);
      if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) throw Error('Ruta del módulo no válida');
      const form = typeof FormData !== 'undefined' && options.body instanceof FormData;
      const headers = { Accept: 'application/json', 'X-CSRF-Token': session.csrf, ...options.headers };
      if (options.body && !form && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
      const type = response.headers.get('content-type') || '';
      const body = type.includes('application/json') ? await response.json() : await response.text();
      if (!response.ok) throw Error(typeof body === 'object' && body?.error ? body.error : 'No se pudo completar la solicitud.');
      return body;
    };
    const cleanup = await extension.mount(target, { api, icon, module: { id: module.id, title: module.title, description: module.description } });
    if (sequence !== viewSequence) { if (typeof cleanup === 'function') await cleanup(); stylesheets.forEach(item => item.remove()); return; }
    viewCleanup = async () => { stylesheets.forEach(item => item.remove()); if (typeof cleanup === 'function') await cleanup(); };
  } catch {
    if (sequence !== viewSequence) return;
    stylesheets.forEach(item => item.remove());
    activeViewId = null;
    const error = document.createElement('p');
    error.className = 'extension-error';
    error.setAttribute('role', 'alert');
    error.textContent = 'No se pudo abrir este módulo.';
    target.replaceChildren(error);
  }
}
function navigate() {
  const requested = location.hash.slice(1) || 'inicio';
  const module = session?.modules?.find(item => item.id === requested);
  if (module) {
    $('welcome').hidden = true;
    $('title').textContent = module.title;
    if (module.client) {
      $('extension').hidden = true;
      $('extension').removeAttribute('src');
      $('extension-view').hidden = false;
      if (activeViewId !== module.id) void mountView(module);
    } else {
      if (activeViewId) disposeView();
      $('extension-view').hidden = true;
      $('extension').hidden = false;
      const target = '/extensions/' + encodeURIComponent(module.id) + '/';
      if ($('extension').getAttribute('src') !== target) $('extension').src = target;
      $('extension').title = module.title;
    }
    selectNavigation(module.id);
  } else {
    if (requested !== 'inicio') history.replaceState(null, '', location.pathname + location.search);
    if (activeViewId) disposeView();
    $('extension-view').hidden = true;
    $('extension').hidden = true;
    $('extension').removeAttribute('src');
    $('welcome').hidden = false;
    $('title').textContent = 'Inicio';
    selectNavigation('inicio');
  }
  document.title = ($('title').textContent === 'Inicio' ? 'Inicio' : $('title').textContent) + ' · Millennia Fenix Bot';
}
function notice(text) { $('message').textContent = text; $('message').hidden = !text; }
function addModule(module, navigationTarget) {
  const button = document.createElement('button');
  button.className = 'nav-link nav-item';
  button.dataset.id = module.id;
  button.append(icon(module.icon));
  const label = document.createElement('span');
  label.textContent = module.title;
  button.append(label);
  button.addEventListener('click', () => { location.hash = module.id; });
  navigationTarget.append(button);

  const card = document.createElement('button');
  card.className = 'module-card';
  card.type = 'button';
  card.setAttribute('aria-label', module.description ? module.title + ': ' + module.description : module.title);
  const symbol = document.createElement('span');
  symbol.className = 'module-icon';
  symbol.append(icon(module.icon));
  const body = document.createElement('span');
  body.className = 'module-card-body';
  const title = document.createElement('span');
  title.className = 'module-card-title';
  title.textContent = module.title;
  body.append(title);
  if (module.description) {
    const description = document.createElement('span');
    description.className = 'module-card-description';
    description.textContent = module.description;
    body.append(description);
  }
  card.append(symbol, body, icon('arrow'));
  card.addEventListener('click', () => { location.hash = module.id; });
  $('cards').append(card);
}
function addModulesBySection(modules) {
  const sections = [
    { title: 'Comunidad', ids: ['welcome', 'anuncios'] },
    { title: 'Administración', ids: ['rolemanager'] },
    { title: 'Registros', ids: ['logs'] },
    { title: 'Herramientas', ids: [] },
  ];
  const assigned = new Set(sections.flatMap(section => section.ids));
  for (const section of sections) {
    const items = section.ids.length
      ? modules.filter(module => section.ids.includes(module.id))
      : modules.filter(module => !assigned.has(module.id));
    if (!items.length) continue;
    const group = document.createElement('div');
    group.className = 'nav-group';
    const heading = document.createElement('p');
    heading.className = 'nav-title';
    heading.textContent = section.title;
    group.append(heading);
    $('modules').append(group);
    for (const module of items) addModule(module, group);
  }
}
async function initialize() {
  try {
    const response = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    session = await response.json();
    if (!response.ok || !session.loggedIn) { location.replace('/login'); return; }
    session.modules = Array.isArray(session.modules) ? session.modules : [];
    $('account').textContent = session.displayName || session.username || 'Discord';
    const image = $('avatar-image'), fallback = $('avatar-fallback');
    fallback.textContent = String(session.displayName || session.username || 'D').trim().slice(0, 2).toUpperCase() || 'D';
    if (session.avatarUrl) {
      image.onload = () => { image.hidden = false; fallback.hidden = true; };
      image.onerror = () => { image.hidden = true; fallback.hidden = false; };
      image.src = session.avatarUrl;
    }
    $('account-label').textContent = 'Cuenta de Discord';
    $('logout').hidden = false;
    $('module-count').textContent = session.modules.length + ' ' + (session.modules.length === 1 ? 'módulo' : 'módulos');
    $('module-count').hidden = false;
    addModulesBySection(session.modules);
    $('empty-state').hidden = session.modules.length > 0;
    navigate();
  } catch {
    notice('No se pudo cargar el panel. Actualiza la página para volver a intentarlo.');
  }
}

$('home').addEventListener('click', () => { location.hash = 'inicio'; });
$('nav-toggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  $('nav-toggle').setAttribute('aria-expanded', String(open));
  $('nav-toggle').setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
  $('nav-overlay').hidden = !open;
  updateMenuAccess();
  if (open) $('home').focus();
});
$('nav-overlay').addEventListener('click', closeMenu);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
window.addEventListener('hashchange', navigate);
matchMedia('(max-width:760px)').addEventListener('change', () => { closeMenu(); updateMenuAccess(); });
updateMenuAccess();
$('main').tabIndex = -1;
document.querySelector('.skip-link').addEventListener('click', event => { event.preventDefault(); $('main').focus(); });
$('logout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf } });
    if (!response.ok) throw Error();
    location.assign('/login');
  } catch { notice('No se pudo cerrar la sesión. Inténtalo de nuevo.'); }
});
initialize();
