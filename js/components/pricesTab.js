import * as priceService from '../services/priceService.js';
import { toast } from './toast.js';
import { openModal, confirmDialog } from './modal.js';
import { createDatePicker, closeActiveDatePicker } from './datePicker.js';
import { formatDisplayDate, addDays } from '../utils/dateUtils.js';
import { formatNumber } from '../utils/format.js';
import { validatePriceRange, validatePricePerNight } from '../utils/validators.js';

const NOTE_SUGGESTIONS = ['High Season', 'Low Season', 'Holiday', 'Ramadan', 'Weekend', 'Promotion'];
const SORT_COLUMNS = {
  start_date: 'Start Date',
  end_date: 'End Date',
  price_per_night: 'Price / Night',
  season_note: 'Season Note'
};

let els = {};
let state = {
  prices: [],
  loading: true,
  search: '',
  sortBy: 'start_date',
  sortDir: 'asc'
};
let searchDebounce = null;

export function mount(container) {
  container.innerHTML = template();
  els = {
    root: container,
    search: container.querySelector('#prices-search'),
    btnAdd: container.querySelector('#btn-add-price'),
    tableHost: container.querySelector('#prices-table-host')
  };

  els.search.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.search = els.search.value;
      load();
    }, 260);
  });

  els.btnAdd.addEventListener('click', () => openPriceForm());

  load();
}

async function load() {
  state.loading = true;
  render();
  try {
    state.prices = await priceService.listPrices({
      search: state.search,
      sortBy: state.sortBy,
      sortDir: state.sortDir
    });
  } catch (err) {
    toast.error(err.message);
    state.prices = [];
  } finally {
    state.loading = false;
    render();
  }
}

function setSort(column) {
  if (state.sortBy === column) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortBy = column;
    state.sortDir = 'asc';
  }
  load();
}

function render() {
  const host = els.tableHost;

  if (state.loading) {
    host.innerHTML = `
      <div class="skeleton" style="height:36px;margin-bottom:8px;"></div>
      <div class="skeleton" style="height:36px;margin-bottom:8px;"></div>
      <div class="skeleton" style="height:36px;"></div>
    `;
    return;
  }

  if (!state.prices.length) {
    host.innerHTML = `
      <div class="state-block">
        <div class="state-icon">📅</div>
        <div class="state-title">${state.search ? 'No matching pricing rules' : 'No pricing rules yet'}</div>
      </div>
    `;
    return;
  }

  const headerCells = Object.entries(SORT_COLUMNS)
    .map(([col, label]) => {
      const isActive = state.sortBy === col;
      const arrow = isActive ? (state.sortDir === 'asc' ? '↑' : '↓') : '↕';
      return `<th class="sortable${isActive ? ' is-active' : ''}" data-sort="${col}">${label} <span class="sort-icon">${arrow}</span></th>`;
    })
    .join('');

  const rows = state.prices
    .map(
      (p) => `
      <tr>
        <td class="num">${formatDisplayDate(p.startDate)}</td>
        <td class="num">${formatDisplayDate(p.endDate)}</td>
        <td class="num">${formatNumber(p.pricePerNight)}</td>
        <td>${p.seasonNote ? `<span class="price-note-pill">${escapeHtml(p.seasonNote)}</span>` : '<span class="text-muted">—</span>'}</td>
        <td class="cell-actions">
          <button class="btn btn-sm btn-secondary" data-action="edit" data-id="${p.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-id="${p.id}">Delete</button>
        </td>
      </tr>`
    )
    .join('');

  host.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${headerCells}<th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  host.querySelectorAll('[data-sort]').forEach((th) => th.addEventListener('click', () => setSort(th.dataset.sort)));
  host.querySelectorAll('[data-action="edit"]').forEach((btn) =>
    btn.addEventListener('click', () => openPriceForm(state.prices.find((p) => p.id === btn.dataset.id)))
  );
  host.querySelectorAll('[data-action="delete"]').forEach((btn) =>
    btn.addEventListener('click', () => handleDelete(btn.dataset.id))
  );
}

async function handleDelete(id) {
  const price = state.prices.find((p) => p.id === id);
  const ok = await confirmDialog({
    title: 'Delete pricing rule?',
    message: `This will remove the ${price ? formatNumber(price.pricePerNight) + ' IDR/night' : ''} rule permanently. This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) return;

  try {
    await priceService.deletePrice(id);
    toast.success('Pricing rule deleted.');
    load();
  } catch (err) {
    toast.error(err.message);
  }
}

/** Every date from startISO to endISO, inclusive — ranges here are always a handful of weeks/months, never large enough to matter. */
function expandDateRange(startISO, endISO) {
  const dates = [];
  let cursor = startISO;
  while (cursor <= endISO) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/**
 * Dates already covered by some other pricing rule — used to grey these out
 * in the Add/Edit form's date pickers so staff can spot non-priced gaps at a
 * glance instead of cross-checking the table. The rule being edited (if any)
 * is excluded so its own current range stays pickable.
 */
function buildDisabledDateSet(rules, excludeId) {
  const disabled = new Set();
  for (const rule of rules) {
    if (excludeId && rule.id === excludeId) continue;
    for (const iso of expandDateRange(rule.startDate, rule.endDate)) disabled.add(iso);
  }
  return disabled;
}

async function openPriceForm(existing) {
  const isEdit = Boolean(existing);

  // Fetch the full, unfiltered rule list for the disabled-dates set — the
  // table's own state.prices can be narrowed by an active search term.
  let allRules = state.prices;
  try {
    allRules = await priceService.listPrices();
  } catch (err) {
    toast.error(err.message);
  }
  const disabledDates = buildDisabledDateSet(allRules, existing?.id);

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field-row">
      <div class="field" id="f-start">
        <label class="field-label" for="price-start">Start Date <span class="required">*</span></label>
        <div id="price-start-slot"></div>
      </div>
      <div class="field" id="f-end">
        <label class="field-label" for="price-end">End Date <span class="required">*</span></label>
        <div id="price-end-slot"></div>
      </div>
    </div>
    <div class="field" id="f-amount">
      <label class="field-label" for="price-amount">Price per Night (IDR) <span class="required">*</span></label>
      <input class="input" type="text" inputmode="numeric" id="price-amount" value="${existing ? formatNumber(existing.pricePerNight) : ''}" placeholder="e.g. 2.500.000" />
    </div>
    <div class="field">
      <label class="field-label" for="price-note">Season Note</label>
      <input class="input" type="text" id="price-note" value="${escapeHtml(existing?.seasonNote || '')}" placeholder="e.g. High Season" />
      <div class="note-suggestions">
        ${NOTE_SUGGESTIONS.map((n) => `<button type="button" class="note-suggestion" data-note="${n}">${n}</button>`).join('')}
      </div>
    </div>
    <div class="field-error" id="price-form-error" style="display:none;"></div>
  `;

  const startPicker = createDatePicker({
    value: existing?.startDate || '',
    disabledDates,
    // Jump straight into End Date's picker right after Start Date is
    // picked — one fewer click for the common case of picking both ends of
    // a range back to back.
    onChange: () => endPicker.open()
  });
  const endPicker = createDatePicker({
    value: existing?.endDate || '',
    disabledDates,
    getReferenceValue: () => startPicker.getValue()
  });
  body.querySelector('#price-start-slot').appendChild(startPicker.trigger);
  body.querySelector('#price-end-slot').appendChild(endPicker.trigger);

  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.gap = '8px';
  footer.innerHTML = `
    <button type="button" class="btn btn-secondary" id="price-cancel">Cancel</button>
    <button type="button" class="btn btn-primary" id="price-save">${isEdit ? 'Save Changes' : 'Add Pricing Rule'}</button>
  `;

  const dialog = openModal({
    title: isEdit ? 'Edit Pricing Rule' : 'Add Pricing Rule',
    bodyEl: body,
    footerEl: footer,
    // Closing via the Escape key (handled inside modal.js) doesn't generate
    // a document click, so an open popover needs to be force-closed here —
    // the click-outside case is already covered by datePicker.js's own
    // permanent listener.
    onClose: () => closeActiveDatePicker()
  });

  body.querySelectorAll('.note-suggestion').forEach((btn) =>
    btn.addEventListener('click', () => {
      body.querySelector('#price-note').value = btn.dataset.note;
    })
  );
  footer.querySelector('#price-cancel').addEventListener('click', () => dialog.close());

  // Reformats with thousands separators as the user types — e.g. typing
  // "2500000" displays as "2.500.000" — matching the same grouping used
  // everywhere else in the app (pricing table, invoice PDF). Re-inserting
  // the value moves the caret to the end by default, which makes editing
  // in the middle of a number impossible (every keystroke would land at
  // the end instead), so the caret is placed back by digit count rather
  // than character index — separators shift around it, digits don't.
  const amountInput = body.querySelector('#price-amount');
  amountInput.addEventListener('input', () => {
    const caret = amountInput.selectionStart;
    const digitsBeforeCaret = amountInput.value.slice(0, caret).replace(/\D/g, '').length;

    const digits = amountInput.value.replace(/\D/g, '');
    amountInput.value = digits ? formatNumber(Number(digits)) : '';

    let newCaret = amountInput.value.length;
    if (digitsBeforeCaret === 0) {
      newCaret = 0;
    } else {
      let seen = 0;
      for (let i = 0; i < amountInput.value.length; i++) {
        if (/\d/.test(amountInput.value[i])) {
          seen++;
          if (seen === digitsBeforeCaret) {
            newCaret = i + 1;
            break;
          }
        }
      }
    }
    amountInput.setSelectionRange(newCaret, newCaret);
  });

  const errorEl = body.querySelector('#price-form-error');
  const saveBtn = footer.querySelector('#price-save');

  saveBtn.addEventListener('click', async () => {
    const startDate = startPicker.getValue();
    const endDate = endPicker.getValue();
    const pricePerNight = amountInput.value.replace(/\D/g, '');
    const seasonNote = body.querySelector('#price-note').value;

    const rangeError = validatePriceRange(startDate, endDate);
    const priceError = validatePricePerNight(pricePerNight);
    ['f-start', 'f-end', 'f-amount'].forEach((id) => body.querySelector(`#${id}`)?.classList.remove('has-error'));

    if (rangeError || priceError) {
      if (rangeError) {
        body.querySelector('#f-start').classList.add('has-error');
        body.querySelector('#f-end').classList.add('has-error');
      }
      if (priceError) body.querySelector('#f-amount').classList.add('has-error');
      errorEl.textContent = rangeError || priceError;
      errorEl.style.display = 'block';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.classList.add('is-loading');
    try {
      const payload = { startDate, endDate, pricePerNight: Number(pricePerNight), seasonNote };
      if (isEdit) {
        await priceService.updatePrice(existing.id, payload);
        toast.success('Pricing rule updated.');
      } else {
        await priceService.createPrice(payload);
        toast.success('Pricing rule added.');
      }
      dialog.close();
      load();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      saveBtn.disabled = false;
      saveBtn.classList.remove('is-loading');
    }
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function template() {
  return `
    <div class="page">
        <div class="page-actions">
          <button class="btn btn-primary" id="btn-add-price" type="button">+ Add Pricing Rule</button>
        </div>

      <div class="prices-toolbar">
        <input class="input search-box" type="search" id="prices-search" placeholder="Search by season note…" />
      </div>

      <div class="card">
        <div class="card-body" id="prices-table-host"></div>
      </div>
    </div>
  `;
}
