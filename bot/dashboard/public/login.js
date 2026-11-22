const message = document.getElementById('login-message');
const button = document.getElementById('login');
const errors = {
  oauth_failed: 'No se pudo iniciar sesión. Inténtalo de nuevo.',
  oauth_state: 'La solicitud expiró. Inicia sesión otra vez.',
  no_permission: 'Tu cuenta de Discord no tiene acceso a este panel.',
};
const code = new URLSearchParams(location.search).get('error');
if (errors[code]) { message.textContent = errors[code]; message.hidden = false; }
fetch('/api/me').then(response => response.json()).then(session => {
  if (session.loggedIn) { location.replace('/'); return; }
  if (!session.oauthConfigured) {
    button.removeAttribute('href');
    button.setAttribute('aria-disabled', 'true');
    message.textContent = 'El inicio de sesión con Discord no está configurado.';
    message.hidden = false;
  }
}).catch(() => {
  message.textContent = 'No se pudo conectar con el servicio de acceso.';
  message.hidden = false;
});
