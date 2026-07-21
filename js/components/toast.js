let counter = 0;

function container() {
  return document.getElementById('toast-container');
}

function iconFor(type) {
  switch (type) {
    case 'success':
      return '✓';
    case 'error':
      return '✕';
    case 'warning':
      return '!';
    default:
      return 'ℹ';
  }
}

export function showToast(message, { type = 'info', duration = 4200 } = {}) {
  const host = container();
  if (!host) return;

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.id = `toast-${++counter}`;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = iconFor(type);

  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => dismiss(el));

  el.append(icon, text, close);
  host.appendChild(el);

  if (duration) setTimeout(() => dismiss(el), duration);
  return el.id;
}

function dismiss(el) {
  if (!el || !el.parentElement) return;
  el.classList.add('is-leaving');
  setTimeout(() => el.remove(), 160);
}

export const toast = {
  success: (message, opts) => showToast(message, { ...opts, type: 'success' }),
  error: (message, opts) => showToast(message, { ...opts, type: 'error' }),
  warning: (message, opts) => showToast(message, { ...opts, type: 'warning' }),
  info: (message, opts) => showToast(message, { ...opts, type: 'info' })
};
