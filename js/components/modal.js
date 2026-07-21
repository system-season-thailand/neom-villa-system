function root() {
  return document.getElementById('modal-root');
}

export function closeModal() {
  const host = root();
  if (host) host.innerHTML = '';
}

/**
 * Opens a single modal (any previous modal is closed first — this app never
 * needs to stack them). Pass DOM elements for `bodyEl`/`footerEl` so callers
 * keep full control of their own event wiring.
 */
export function openModal({ title, bodyEl, footerEl, size = 'md', onClose } = {}) {
  closeModal();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = `modal${size === 'lg' ? ' modal-lg' : ''}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'modal-header';
  const h2 = document.createElement('h2');
  h2.textContent = title || '';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-icon btn-ghost';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  header.append(h2, closeBtn);

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (bodyEl) body.appendChild(bodyEl);

  modal.append(header, body);

  if (footerEl) {
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.appendChild(footerEl);
    modal.appendChild(footer);
  }

  backdrop.appendChild(modal);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown);
    backdrop.remove();
    if (onClose) onClose();
  }
  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  root().appendChild(backdrop);
  return { close, modalEl: modal, bodyEl: body };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = document.createElement('p');
    body.style.fontSize = '13.5px';
    body.style.color = 'var(--text-secondary)';
    body.textContent = message;

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.gap = '8px';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    okBtn.textContent = confirmLabel;

    footer.append(cancelBtn, okBtn);

    const dialog = openModal({ title, bodyEl: body, footerEl: footer, onClose: () => settle(false) });
    cancelBtn.addEventListener('click', () => dialog.close());
    okBtn.addEventListener('click', () => {
      settle(true);
      dialog.close();
    });
  });
}
