import * as invoiceService from '../services/invoiceService.js';
import * as settingsService from '../services/settingsService.js';
import { toast } from './toast.js';
import { openModal } from './modal.js';
import { createDatePicker } from './datePicker.js';
import { addDays, formatDisplayDate, formatDateTime, todayISO } from '../utils/dateUtils.js';
import { formatIDR, formatNumber } from '../utils/format.js';
import { generateInvoicePdf } from '../utils/pdfGenerator.js';
import { validateGuestName, validateCheckIn, validateNights, validateVillaType } from '../utils/validators.js';

const VILLA_TYPES = ['3 Bedroom Villa', '2 Bedroom Villa'];
const ADD_NEW_GUEST_BY_VALUE = '__add_new__';

let els = {};
let state = null;
let pricingRequestId = 0;
let pricingDebounce = null;
// Kept outside `state` (unlike everything else) so it survives blankState()
// resets — it's a shared list, not per-invoice data, and re-fetching it on
// every new invoice would be wasteful.
let guestByOptions = [];
// Created once at mount and reused across resets — same reasoning as
// guestByOptions above (the picker instance itself isn't per-invoice state).
let checkInPicker = null;

function blankState() {
  return {
    invoiceNumber: null,
    invoiceNumberLoading: true,
    // True once invoiceNumber is a real, minted number (already saved, or
    // loaded/imported from an existing invoice) rather than just a preview
    // of what the next number would be — see handleDownload().
    invoiceNumberCommitted: false,
    guestName: '',
    guestBy: '',
    checkInDate: '',
    nights: '',
    villaType: VILLA_TYPES[0],
    pricing: { rows: [], total: 0, missingDates: [] },
    pricingLoading: false,
    revisions: [],
    saving: false
  };
}

export function mount(container) {
  container.innerHTML = template();
  cacheEls(container);
  checkInPicker = createDatePicker({
    // No disabledDates — unlike the Prices tab's pickers, nothing about an
    // invoice's check-in date is ever off-limits, including past dates.
    onChange: (value) => {
      state.checkInDate = value;
      clearFieldError('checkInDate');
      updateCheckOutAndPricing();
    }
  });
  els.checkInSlot.appendChild(checkInPicker.trigger);
  bindEvents();
  state = blankState();
  syncFormFromState();
  startNewInvoice();
  loadGuestByOptions();
}

function cacheEls(container) {
  els = {
    root: container,
    invoiceNumberValue: container.querySelector('#invoice-number-value'),
    guestName: container.querySelector('#guest-name'),
    errGuestName: container.querySelector('#err-guest-name'),
    fieldGuestName: container.querySelector('#field-guest-name'),
    guestBy: container.querySelector('#guest-by'),
    checkInSlot: container.querySelector('#check-in-slot'),
    errCheckIn: container.querySelector('#err-check-in'),
    fieldCheckIn: container.querySelector('#field-check-in'),
    nights: container.querySelector('#nights'),
    errNights: container.querySelector('#err-nights'),
    fieldNights: container.querySelector('#field-nights'),
    checkOut: container.querySelector('#check-out'),
    villaType: container.querySelector('#villa-type'),
    pricingContainer: container.querySelector('#pricing-container'),
    btnDownload: container.querySelector('#btn-download'),
    btnImport: container.querySelector('#btn-import'),
    revisionsContainer: container.querySelector('#revisions-container')
  };
}

function bindEvents() {
  els.guestName.addEventListener('input', () => {
    state.guestName = els.guestName.value;
    clearFieldError('guestName');
  });

  els.guestBy.addEventListener('change', () => {
    if (els.guestBy.value === ADD_NEW_GUEST_BY_VALUE) {
      openAddGuestByModal();
      return;
    }
    state.guestBy = els.guestBy.value;
  });

  els.nights.addEventListener('input', () => {
    state.nights = els.nights.value;
    clearFieldError('nights');
    updateCheckOutAndPricing();
  });

  els.villaType.addEventListener('change', () => {
    state.villaType = els.villaType.value;
  });

  els.btnDownload.addEventListener('click', handleDownload);
  els.btnImport.addEventListener('click', openImportModal);
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------
function currentCheckOut() {
  const n = Number(state.nights);
  if (!state.checkInDate || !Number.isInteger(n) || n <= 0) return '';
  return addDays(state.checkInDate, n);
}

function updateCheckOutAndPricing() {
  const checkOut = currentCheckOut();
  els.checkOut.value = checkOut ? formatDisplayDate(checkOut) : '';

  // Invalidate immediately (not just after the debounce fires) so a fast
  // type-then-click can never submit a PDF whose totals still reflect the
  // previous check-in/nights value.
  pricingRequestId++;
  state.pricing = { rows: [], total: 0, missingDates: [] };
  state.pricingLoading = Boolean(state.checkInDate && checkOut);
  renderPricing();

  if (pricingDebounce) clearTimeout(pricingDebounce);
  pricingDebounce = setTimeout(recalculatePricing, 280);
}

async function recalculatePricing() {
  const checkOut = currentCheckOut();
  if (!state.checkInDate || !checkOut) {
    state.pricing = { rows: [], total: 0, missingDates: [] };
    renderPricing();
    return;
  }

  const requestId = ++pricingRequestId;
  state.pricingLoading = true;
  renderPricing();

  try {
    const result = await invoiceService.calculateStayPricing(state.checkInDate, checkOut);
    if (requestId !== pricingRequestId) return; // a newer request superseded this one
    state.pricing = result;
  } catch (err) {
    if (requestId !== pricingRequestId) return;
    state.pricing = { rows: [], total: 0, missingDates: [] };
    toast.error(err.message);
  } finally {
    if (requestId === pricingRequestId) {
      state.pricingLoading = false;
      renderPricing();
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function syncFormFromState() {
  els.invoiceNumberValue.textContent = state.invoiceNumberLoading
    ? 'Generating…'
    : state.invoiceNumber || '—';
  els.guestName.value = state.guestName;
  renderGuestBySelect();
  checkInPicker.setValue(state.checkInDate);
  els.nights.value = state.nights;
  els.villaType.value = state.villaType;
  els.checkOut.value = currentCheckOut() ? formatDisplayDate(currentCheckOut()) : '';
  renderPricing();
  renderRevisions();
}

// ---------------------------------------------------------------------------
// Guest By — a staff-editable option list stored in neom_system_settings
// (see settingsService.js) rather than hardcoded, so new names don't need a
// code change.
// ---------------------------------------------------------------------------
async function loadGuestByOptions() {
  try {
    guestByOptions = await settingsService.listGuestByOptions();
  } catch (err) {
    toast.error(err.message);
    guestByOptions = [];
  }
  renderGuestBySelect();
}

function renderGuestBySelect() {
  const current = state.guestBy;
  // A value loaded from an older revision might not be in the current
  // (possibly since-edited) options list — show it anyway rather than
  // silently blanking the field.
  const options = current && !guestByOptions.includes(current) ? [current, ...guestByOptions] : guestByOptions;

  els.guestBy.innerHTML = `
    <option value="">— Select —</option>
    ${options
      .map((opt) => `<option value="${escapeHtml(opt)}"${opt === current ? ' selected' : ''}>${escapeHtml(opt)}</option>`)
      .join('')}
    <option value="${ADD_NEW_GUEST_BY_VALUE}">+ Add new…</option>
  `;
}

function openAddGuestByModal() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="field">
      <label class="field-label" for="new-guest-by-name">Name</label>
      <input class="input" type="text" id="new-guest-by-name" placeholder="e.g. Faisal" autocomplete="off" />
    </div>
    <div class="field-error" id="new-guest-by-error" style="display:none;"></div>
  `;

  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.gap = '8px';
  footer.innerHTML = `
    <button type="button" class="btn btn-secondary" id="new-guest-by-cancel">Cancel</button>
    <button type="button" class="btn btn-primary" id="new-guest-by-save">Add</button>
  `;

  const dialog = openModal({
    title: 'Add Guest By Option',
    bodyEl: body,
    footerEl: footer,
    // Covers both Cancel and backing out via Escape/backdrop click — either
    // way, the select must fall back off "+ Add new…" to whatever was
    // actually chosen before (state.guestBy is untouched in that case).
    onClose: () => renderGuestBySelect()
  });

  const nameInput = body.querySelector('#new-guest-by-name');
  const errorEl = body.querySelector('#new-guest-by-error');
  const saveBtn = footer.querySelector('#new-guest-by-save');

  footer.querySelector('#new-guest-by-cancel').addEventListener('click', () => dialog.close());

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
      const added = await settingsService.addGuestByOption(name);
      guestByOptions = [...guestByOptions, added];
      state.guestBy = added;
      toast.success(`"${added}" added to Guest By.`);
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

function renderPricing() {
  const { rows, total, missingDates } = state.pricing;
  const host = els.pricingContainer;

  if (state.pricingLoading) {
    host.innerHTML = `
      <div class="skeleton" style="height:14px;width:100%;margin-bottom:8px;"></div>
      <div class="skeleton" style="height:14px;width:80%;"></div>
    `;
    els.btnDownload.disabled = true;
    return;
  }

  if (!state.checkInDate || !currentCheckOut()) {
    host.innerHTML = `<div class="pricing-empty">Enter a check-in date and number of nights to calculate pricing.</div>`;
    els.btnDownload.disabled = true;
    return;
  }

  if (missingDates.length) {
    const preview = missingDates.slice(0, 3).map(formatDisplayDate).join(', ');
    const more = missingDates.length > 3 ? ` and ${missingDates.length - 3} more` : '';
    host.innerHTML = `
      <div class="pricing-warning">⚠ No pricing rule covers ${preview}${more}. Add it on the Prices tab first.</div>
    `;
    els.btnDownload.disabled = true;
    return;
  }

  if (!rows.length) {
    host.innerHTML = `<div class="pricing-empty">Enter a check-in date and number of nights to calculate pricing.</div>`;
    els.btnDownload.disabled = true;
    return;
  }

  const rowsHtml = rows
    .map(
      (row) => `
      <tr>
        <td data-label="Period">${row.nights === 1 ? formatDisplayDate(row.startDate) : `${formatDisplayDate(row.startDate)} – ${formatDisplayDate(row.endDate)}`}</td>
        <td data-label="Season">${escapeHtml(row.seasonNote || '—')}</td>
        <td class="text-right num" data-label="Nights">${row.nights}</td>
        <td class="text-right num" data-label="Rate / Night">${formatNumber(row.pricePerNight)}</td>
        <td class="text-right num" data-label="Amount">${formatNumber(row.subtotal)}</td>
      </tr>`
    )
    .join('');

  host.innerHTML = `
    <div class="table-wrap">
      <table class="data-table pricing-table">
        <thead>
          <tr><th>Period</th><th>Season</th><th class="text-right">Nights</th><th class="text-right">Rate / Night</th><th class="text-right">Amount</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr><td colspan="4" class="pricing-total-label">Total</td><td class="text-right" data-label="Total">${formatIDR(total)}</td></tr>
        </tfoot>
      </table>
    </div>
  `;
  els.btnDownload.disabled = false;
}

function renderRevisions() {
  const host = els.revisionsContainer;
  if (!state.invoiceNumber || state.invoiceNumberLoading) {
    host.innerHTML = `<div class="state-block"><div class="state-title">No revisions yet</div></div>`;
    return;
  }

  if (!state.revisions.length) {
    host.innerHTML = `<div class="state-block"><div class="state-title">No revisions yet</div></div>`;
    return;
  }

  host.innerHTML = `<div class="revision-list">${state.revisions
    .map(
      (rev) => `
      <div class="revision-item">
        <div class="revision-item-main">
          <div class="revision-item-title">Revision ${rev.revisionNumber}</div>
          <div class="revision-item-sub">${formatDateTime(rev.createdAt)}</div>
        </div>
        <div class="revision-item-actions">
          <button class="btn btn-sm btn-secondary" data-action="load" data-id="${rev.id}">Load</button>
          <button class="btn btn-sm btn-ghost" data-action="pdf" data-id="${rev.id}">PDF</button>
        </div>
      </div>`
    )
    .join('')}</div>`;

  host.querySelectorAll('[data-action="load"]').forEach((btn) =>
    btn.addEventListener('click', () => loadRevisionById(btn.dataset.id))
  );
  host.querySelectorAll('[data-action="pdf"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const rev = state.revisions.find((r) => r.id === btn.dataset.id);
      if (rev) regenerateRevisionPdf(rev);
    })
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function startNewInvoice() {
  state = blankState();
  syncFormFromState();
  try {
    // A read-only preview — invoiceNumberCommitted stays false, so this
    // number is never actually consumed unless this invoice is downloaded.
    state.invoiceNumber = await invoiceService.peekNextInvoiceNumber();
  } catch (err) {
    toast.error(err.message);
  } finally {
    state.invoiceNumberLoading = false;
    syncFormFromState();
  }
}

function clearFieldError(field) {
  const map = {
    guestName: [els.fieldGuestName, els.errGuestName],
    checkInDate: [els.fieldCheckIn, els.errCheckIn],
    nights: [els.fieldNights, els.errNights]
  };
  const [fieldEl, errEl] = map[field] || [];
  if (fieldEl) fieldEl.classList.remove('has-error');
  if (errEl) errEl.textContent = '';
}

function setFieldError(field, message) {
  const map = {
    guestName: [els.fieldGuestName, els.errGuestName],
    checkInDate: [els.fieldCheckIn, els.errCheckIn],
    nights: [els.fieldNights, els.errNights]
  };
  const [fieldEl, errEl] = map[field] || [];
  if (fieldEl) fieldEl.classList.add('has-error');
  if (errEl) errEl.textContent = message;
}

function validateForm() {
  const fieldErrors = {
    guestName: validateGuestName(state.guestName),
    checkInDate: validateCheckIn(state.checkInDate),
    nights: validateNights(state.nights)
  };

  let valid = true;
  for (const [field, message] of Object.entries(fieldErrors)) {
    if (message) {
      setFieldError(field, message);
      valid = false;
    } else {
      clearFieldError(field);
    }
  }

  const villaTypeError = validateVillaType(state.villaType);
  if (villaTypeError) {
    toast.error(villaTypeError);
    valid = false;
  }

  return valid;
}

async function handleDownload() {
  if (state.invoiceNumberLoading || !state.invoiceNumber) {
    toast.warning('Still generating the invoice number, please wait a moment.');
    return;
  }
  if (!validateForm()) {
    toast.error('Please fix the highlighted fields before continuing.');
    return;
  }
  if (state.pricing.missingDates.length || !state.pricing.rows.length) {
    toast.error('Pricing is incomplete for this stay.');
    return;
  }

  setSaving(true);
  try {
    const checkOutDate = currentCheckOut();
    const wasCommitted = state.invoiceNumberCommitted;

    // Everything needed to regenerate this exact PDF later — including the
    // generation date — so re-downloading an old revision (see
    // regenerateRevisionPdf below) reproduces it faithfully rather than
    // stamping it with today's date. No PDF file is stored anywhere.
    const invoiceData = {
      guestName: state.guestName.trim(),
      guestBy: state.guestBy || '',
      checkInDate: state.checkInDate,
      checkOutDate,
      nights: Number(state.nights),
      villaType: state.villaType,
      priceRows: state.pricing.rows,
      total: state.pricing.total,
      generatedAt: todayISO()
    };

    // Persist before generating/triggering the download — a downloaded
    // invoice must always exist as a saved revision, never the other way
    // around. For a brand-new invoice (never saved before), pass null so
    // the real invoice number is minted here — at the moment it's actually
    // used — rather than back when this form was first opened or reloaded.
    const saved = await invoiceService.saveInvoiceRevision({
      invoiceNumber: wasCommitted ? state.invoiceNumber : null,
      invoiceData
    });

    state.invoiceNumber = saved.invoiceNumber;
    state.invoiceNumberCommitted = true;

    const { blob, fileName } = await generateInvoicePdf({
      invoiceNumber: saved.invoiceNumber,
      revisionNumber: saved.revisionNumber,
      ...invoiceData
    });

    triggerBrowserDownload(blob, fileName);
    toast.success(`Invoice ${saved.invoiceNumber} — Revision ${saved.revisionNumber} saved and downloaded.`);

    if (wasCommitted) {
      state.revisions = await invoiceService.listRevisions(state.invoiceNumber);
      renderRevisions();
    } else {
      // The "New Invoice" button was removed — reaching a blank form is now
      // only possible by actually downloading one, which is what just
      // happened. Revising an already-committed invoice instead stays on
      // the same form, so multi-round edits (e.g. fixing a typo and
      // re-downloading) don't lose context.
      startNewInvoice();
    }
  } catch (err) {
    toast.error(err.message);
  } finally {
    setSaving(false);
  }
}

function setSaving(isSaving) {
  state.saving = isSaving;
  els.btnDownload.classList.toggle('is-loading', isSaving);
  els.btnDownload.disabled = isSaving || state.pricing.missingDates.length > 0 || !state.pricing.rows.length;
}

function triggerBrowserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function loadRevisionById(id) {
  try {
    const rev = await invoiceService.getRevisionById(id);
    applyLoadedRevision(rev);
    toast.success(`Loaded revision ${rev.revisionNumber} of ${rev.invoiceNumber}.`);
  } catch (err) {
    toast.error(err.message);
  }
}

function applyLoadedRevision(rev) {
  const d = rev.invoiceData;
  state.invoiceNumber = rev.invoiceNumber;
  state.invoiceNumberLoading = false;
  state.invoiceNumberCommitted = true;
  state.guestName = d.guestName || '';
  state.guestBy = d.guestBy || '';
  state.checkInDate = d.checkInDate || '';
  state.nights = d.nights || '';
  state.villaType = d.villaType || VILLA_TYPES[0];
  state.pricing = { rows: d.priceRows || [], total: d.total || 0, missingDates: [] };
  state.pricingLoading = false;
  syncFormFromState();
  invoiceService
    .listRevisions(state.invoiceNumber)
    .then((revisions) => {
      state.revisions = revisions;
      renderRevisions();
    })
    .catch((err) => toast.error(err.message));
}

/**
 * No PDF file is ever stored — re-downloading a past revision regenerates
 * it client-side from its saved `invoice_data` snapshot (including the
 * original generation date), which reproduces the exact same PDF that was
 * downloaded at the time.
 */
async function regenerateRevisionPdf(rev) {
  try {
    const { blob, fileName } = await generateInvoicePdf({
      invoiceNumber: rev.invoiceNumber,
      revisionNumber: rev.revisionNumber,
      ...rev.invoiceData
    });
    triggerBrowserDownload(blob, fileName);
  } catch (err) {
    toast.error(err.message);
  }
}

// ---------------------------------------------------------------------------
// Import invoice modal
// ---------------------------------------------------------------------------
async function openImportModal() {
  const body = document.createElement('div');
  body.innerHTML = `
    <input class="input search-box" type="search" placeholder="Search by guest name or invoice number…" id="import-search" />
    <div class="invoice-group-list" id="import-results">
      <div class="state-block"><div class="spinner" style="width:18px;height:18px;border-color:var(--border-strong);border-top-color:var(--accent);"></div></div>
    </div>
  `;
  const dialog = openModal({ title: 'Import Invoice', bodyEl: body, size: 'lg' });

  const searchInput = body.querySelector('#import-search');
  const resultsHost = body.querySelector('#import-results');

  let debounceTimer = null;
  const runSearch = async () => {
    resultsHost.innerHTML = `<div class="state-block"><div class="spinner" style="width:18px;height:18px;border-color:var(--border-strong);border-top-color:var(--accent);"></div></div>`;
    try {
      const groups = await invoiceService.listInvoiceGroups({ search: searchInput.value });
      renderImportResults(resultsHost, groups, dialog);
    } catch (err) {
      resultsHost.innerHTML = `<div class="state-block"><div class="state-title">Could not load invoices</div><div class="state-desc">${escapeHtml(err.message)}</div></div>`;
    }
  };

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 260);
  });

  runSearch();
  searchInput.focus();
}

function renderImportResults(host, groups, dialog) {
  if (!groups.length) {
    host.innerHTML = `<div class="state-block"><div class="state-title">No invoices found</div></div>`;
    return;
  }

  host.innerHTML = groups
    .map(
      (group, idx) => `
      <div class="invoice-group-item">
        <div class="invoice-group-header" data-toggle="${idx}">
          <div>
            <div class="invoice-group-title">${escapeHtml(group.invoiceNumber)} — ${escapeHtml(group.latest.invoiceData.guestName || 'Unnamed guest')}</div>
            <div class="invoice-group-sub">${group.revisions.length} revision${group.revisions.length === 1 ? '' : 's'} · latest ${formatDateTime(group.latest.createdAt)}</div>
          </div>
          <span class="text-muted">▾</span>
        </div>
        <div class="invoice-group-body" hidden id="group-body-${idx}">
          ${group.revisions
          .map(
            (rev) => `
            <div class="revision-item">
              <div class="revision-item-main">
                <div class="revision-item-title">Revision ${rev.revisionNumber}</div>
                <div class="revision-item-sub">${formatDateTime(rev.createdAt)}</div>
              </div>
              <div class="revision-item-actions">
                <button class="btn btn-sm btn-primary" data-import-id="${rev.id}">Load for editing</button>
              </div>
            </div>`
          )
          .join('')}
        </div>
      </div>`
    )
    .join('');

  host.querySelectorAll('[data-toggle]').forEach((headerEl) => {
    headerEl.addEventListener('click', () => {
      const idx = headerEl.dataset.toggle;
      const bodyEl = host.querySelector(`#group-body-${idx}`);
      bodyEl.hidden = !bodyEl.hidden;
    });
  });

  host.querySelectorAll('[data-import-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const rev = await invoiceService.getRevisionById(btn.dataset.importId);
        applyLoadedRevision(rev);
        toast.success(`Loaded ${rev.invoiceNumber} (Revision ${rev.revisionNumber}) for editing.`);
        dialog.close();
      } catch (err) {
        toast.error(err.message);
      }
    });
  });
}

// ---------------------------------------------------------------------------
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
    <div class="page invoice-page">
      <div class="page-actions">
        <button class="btn btn-secondary" id="btn-import" type="button">Import Invoice</button>
      </div>

      <div class="layout-grid">
        <div class="card">
          <div class="card-header"><h2>Invoice Details</h2></div>
          <div class="card-body">
            <div class="invoice-meta-row">
              <div class="invoice-meta-box">
                <div class="kv-label">Invoice Number</div>
                <div class="kv-value" id="invoice-number-value">—</div>
              </div>
            </div>

            <div class="field" id="field-guest-name">
              <label class="field-label" for="guest-name">Guest Name <span class="required">*</span></label>
              <input class="input" id="guest-name" type="text" placeholder="Type guest name" autocomplete="off" />
              <div class="field-error" id="err-guest-name"></div>
            </div>

            <div class="field" id="field-guest-by">
              <label class="field-label" for="guest-by">Guest By</label>
              <select class="input" id="guest-by"></select>
            </div>

            <div class="field-group-title">Stay</div>
            <div class="field-row">
              <div class="field" id="field-check-in">
                <label class="field-label" for="check-in">Check-in Date <span class="required">*</span></label>
                <div id="check-in-slot"></div>
                <div class="field-error" id="err-check-in"></div>
              </div>
              <div class="field" id="field-nights">
                <label class="field-label" for="nights">Number of Nights <span class="required">*</span></label>
                <input class="input" id="nights" type="number" min="1" step="1" placeholder="e.g. 5" />
                <div class="field-error" id="err-nights"></div>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label class="field-label" for="check-out">Check-out Date</label>
                <input class="input" id="check-out" type="text" readonly placeholder="Auto-calculated" />
                <div class="field-hint">Check-in + nights. Never edited directly.</div>
              </div>
              <div class="field">
                <label class="field-label" for="villa-type">Villa Type <span class="required">*</span></label>
                <select class="input" id="villa-type">
                  ${VILLA_TYPES.map((v, i) => `<option value="${v}"${i === 0 ? ' selected' : ''}>${v}</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="field-group-title">Pricing</div>
            <div id="pricing-container"></div>

            <hr class="divider" />
            <button class="btn btn-primary btn-block" id="btn-download" type="button" disabled>
              <span class="spinner"></span>
              <span class="btn-label">Download Invoice PDF</span>
            </button>
          </div>
        </div>

        <div class="card revision-panel">
          <div class="card-header"><h2>Revisions</h2></div>
          <div class="card-body" id="revisions-container"></div>
        </div>
      </div>
    </div>
  `;
}
