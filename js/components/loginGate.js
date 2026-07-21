import { login } from '../auth/authService.js';

const EYE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>
`;

const EYE_OFF_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.53 18.53 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
    <line x1="1" y1="1" x2="23" y2="23"></line>
  </svg>
`;

/** Replaces #app with a password form. Reloads the page on success so the
 * normal startup path (app.js -> getRole()) picks the session back up fresh,
 * rather than trying to hand-wire the real app together from here. */
export function renderLoginGate() {
  const app = document.getElementById('app');
  app.innerHTML = template();

  const form = app.querySelector('#login-form');
  const input = app.querySelector('#login-password');
  const errorEl = app.querySelector('#login-error');
  const toggleBtn = app.querySelector('#password-toggle');

  toggleBtn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggleBtn.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
    toggleBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    toggleBtn.setAttribute('aria-pressed', String(!showing));
    input.focus();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const role = login(input.value);
    if (!role) {
      errorEl.textContent = 'Incorrect password. Please try again.';
      errorEl.style.display = 'block';
      input.value = '';
      input.focus();
      return;
    }
    location.reload();
  });

  input.focus();
}

function template() {
  return `
    <div class="auth-gate">
      <div class="auth-card">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">NV</span>
          <div>
            <div class="auth-brand-name">NEOM VILLA</div>
            <div class="auth-brand-sub">Staff Console</div>
          </div>
        </div>
        <form id="login-form">
          <div class="field">
            <label class="field-label" for="login-password">Staff Password</label>
            <div class="password-field">
              <input class="input" type="password" id="login-password" placeholder="Enter password" />
              <button type="button" class="password-toggle" id="password-toggle" aria-label="Show password" aria-pressed="false">
                ${EYE_ICON}
              </button>
            </div>
          </div>
          <div class="field-error" id="login-error" style="display:none;"></div>
          <button type="submit" class="btn btn-primary btn-block">Enter</button>
        </form>
      </div>
    </div>
  `;
}
