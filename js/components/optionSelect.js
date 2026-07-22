import * as settingsService from '../services/settingsService.js';
import { toast } from './toast.js';
import { openModal, confirmDialog } from './modal.js';

const ADD_NEW_VALUE = '__add_new__';
const MANAGE_VALUE = '__manage__';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/**
 * A `<select>` backed by a staff-editable `neom_system_settings` list (see
 * settingsService.js) — used for both the Invoice tab's Guest By field and
 * the Availability tab's Booked By field, each pointed at a different `key`.
 * Besides the plain option values, the dropdown carries two standing
 * entries: "+ Add new…" for the fast path, and "✎ Manage list…" for
 * renaming/removing existing ones — see openManageModal below.
 */
export function createOptionSelect({ key, label, value: initialValue = '', onChange } = {}) {
  let value = initialValue || '';
  let options = []; // [{ id, value }]

  const el = document.createElement('select');
  el.className = 'input';

  async function load() {
    try {
      options = await settingsService.listOptions(key);
    } catch (err) {
      toast.error(err.message);
      options = [];
    }
    render();
  }

  const loadPromise = load();

  function render() {
    const values = options.map((o) => o.value);
    // A value loaded from an older record might not be in the current
    // (possibly since-edited) options list — show it anyway rather than
    // silently blanking the field.
    const extra = value && !values.includes(value) ? [value] : [];
    const allValues = [...extra, ...values];

    el.innerHTML = `
      <option value="">— Select —</option>
      ${allValues
        .map((v) => `<option value="${escapeHtml(v)}"${v === value ? ' selected' : ''}>${escapeHtml(v)}</option>`)
        .join('')}
      <option value="${ADD_NEW_VALUE}">+ Add new…</option>
      <option value="${MANAGE_VALUE}">✎ Manage list…</option>
    `;
  }

  el.addEventListener('change', () => {
    if (el.value === ADD_NEW_VALUE) {
      openAddModal();
      return;
    }
    if (el.value === MANAGE_VALUE) {
      openManageModal();
      return;
    }
    value = el.value;
    onChange?.(value);
  });

  function openAddModal() {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="field">
        <label class="field-label" for="option-select-new-value">Name</label>
        <input class="input" type="text" id="option-select-new-value" placeholder="e.g. Faisal" autocomplete="off" />
      </div>
      <div class="field-error" id="option-select-new-error" style="display:none;"></div>
    `;

    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.innerHTML = `
      <button type="button" class="btn btn-secondary" id="option-select-new-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="option-select-new-save">Add</button>
    `;

    const dialog = openModal({
      title: `Add ${label} Option`,
      bodyEl: body,
      footerEl: footer,
      // Covers Cancel and backing out via Escape/backdrop click alike — the
      // select must fall back off "+ Add new…" to whatever was actually
      // chosen before (`value` itself is untouched in that case).
      onClose: () => render()
    });

    const nameInput = body.querySelector('#option-select-new-value');
    const errorEl = body.querySelector('#option-select-new-error');
    const saveBtn = footer.querySelector('#option-select-new-save');

    footer.querySelector('#option-select-new-cancel').addEventListener('click', () => dialog.close());

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) {
        errorEl.textContent = 'Enter a name first.';
        errorEl.style.display = 'block';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.classList.add('is-loading');
      try {
        const added = await settingsService.addOption(key, name);
        options = [...options, added];
        value = added.value;
        toast.success(`"${added.value}" added to ${label}.`);
        onChange?.(value);
        dialog.close();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      } finally {
        saveBtn.disabled = false;
        saveBtn.classList.remove('is-loading');
      }
    });

    nameInput.focus();
  }

  function openManageModal() {
    const body = document.createElement('div');
    const listEl = document.createElement('div');
    listEl.className = 'option-manage-list';
    body.appendChild(listEl);

    const addRow = document.createElement('div');
    addRow.className = 'option-manage-add-row';
    addRow.innerHTML = `
      <input class="input" type="text" id="option-manage-new-value" placeholder="Add a new ${escapeHtml(label)} value" autocomplete="off" />
      <button type="button" class="btn btn-primary btn-sm" id="option-manage-add-btn">Add</button>
    `;
    body.appendChild(addRow);

    function renderList() {
      listEl.innerHTML = options.length
        ? options
            .map(
              (opt) => `
          <div class="option-manage-row" data-id="${opt.id}">
            <input class="input option-manage-input" type="text" value="${escapeHtml(opt.value)}" />
            <button type="button" class="btn btn-sm btn-secondary" data-action="save" title="Save">Save</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="delete" title="Delete">Delete</button>
          </div>`
            )
            .join('')
        : `<div class="state-block"><div class="state-title">No options yet</div></div>`;

      listEl.querySelectorAll('[data-action="save"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.option-manage-row');
          const id = row.dataset.id;
          const input = row.querySelector('.option-manage-input');
          const newValue = input.value.trim();
          if (!newValue) {
            toast.error('Enter a name first.');
            return;
          }
          btn.disabled = true;
          try {
            const updated = await settingsService.updateOption(id, newValue);
            const idx = options.findIndex((o) => o.id === id);
            if (idx !== -1) options[idx] = updated;
            toast.success('Updated.');
          } catch (err) {
            toast.error(err.message);
          } finally {
            btn.disabled = false;
          }
        });
      });

      listEl.querySelectorAll('[data-action="delete"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.option-manage-row');
          const id = row.dataset.id;
          const opt = options.find((o) => o.id === id);
          // openModal() (which confirmDialog uses) always tears down whatever
          // modal is currently open before showing a new one — this app never
          // stacks modals — so this manage-list modal is gone the instant the
          // confirm dialog appears, onClose included. Reopening it fresh once
          // the confirm dialog resolves (confirmed or not) is what actually
          // brings it back, rather than trying to keep updating DOM nodes
          // that already aren't on the page anymore.
          const confirmed = await confirmDialog({
            title: 'Delete Option',
            message: `Remove "${opt.value}" from the ${label} list? This won't change any record that already used it.`,
            confirmLabel: 'Delete',
            danger: true
          });
          if (!confirmed) {
            openManageModal();
            return;
          }
          try {
            await settingsService.deleteOption(id);
            options = options.filter((o) => o.id !== id);
            toast.success('Deleted.');
          } catch (err) {
            toast.error(err.message);
          }
          openManageModal();
        });
      });
    }

    renderList();

    addRow.querySelector('#option-manage-add-btn').addEventListener('click', async () => {
      const input = addRow.querySelector('#option-manage-new-value');
      const name = input.value.trim();
      if (!name) {
        toast.error('Enter a name first.');
        return;
      }
      try {
        const added = await settingsService.addOption(key, name);
        options = [...options, added];
        input.value = '';
        renderList();
        toast.success(`"${added.value}" added.`);
      } catch (err) {
        toast.error(err.message);
      }
    });

    const footer = document.createElement('div');
    footer.innerHTML = `<button type="button" class="btn btn-secondary" id="option-manage-close">Close</button>`;

    const dialog = openModal({
      title: `Manage ${label} List`,
      bodyEl: body,
      footerEl: footer,
      // Refresh the <select> on the way out so it reflects anything renamed
      // or removed while the manager was open.
      onClose: () => render()
    });
    footer.querySelector('#option-manage-close').addEventListener('click', () => dialog.close());
  }

  return {
    el,
    getValue: () => value,
    setValue: (v) => {
      value = v || '';
      render();
    },
    // Programmatically pops the native dropdown open — used when this picker
    // is revealed as the very next step after some other action (e.g.
    // clicking "Booked" in the Availability calendar), so staff don't need
    // an extra click just to open it themselves. Waits for the options to
    // finish loading first — opening onto a still-empty <select> would show
    // a blank list for a moment. showPicker() is only supported on newer
    // browsers, so this quietly falls back to just focusing the field.
    open: async () => {
      await loadPromise;
      el.focus();
      if (typeof el.showPicker === 'function') {
        try {
          el.showPicker();
        } catch {
          // Not called within the browser's user-activation window, or
          // unsupported — focus() above still gets the field ready either way.
        }
      }
    }
  };
}
