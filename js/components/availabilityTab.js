import * as availabilityService from '../services/availabilityService.js';
import { STATUSES } from '../services/availabilityService.js';
import * as priceService from '../services/priceService.js';
import * as linkedStayService from '../services/linkedStayService.js';
import { toast } from './toast.js';
import { openModal, confirmDialog } from './modal.js';
import { buildMonthMatrix, monthLabel, todayISO, addDays, formatDisplayDate } from '../utils/dateUtils.js';
import { formatIDRShort } from '../utils/format.js';

const EDITABLE_STATUSES = ['available', 'booked', 'on_hold', 'blocked'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let els = {};
let state = null;
let activePopover = null;

export function mount(container, options = {}) {
  const today = new Date();
  state = {
    year: today.getFullYear(),
    month: today.getMonth(),
    statuses: new Map(),
    priceRules: [],
    linkedStays: [],
    loading: true,
    selectMode: false,
    selectedDates: new Set(),
    readOnly: Boolean(options.readOnly)
  };

  container.innerHTML = template(state.readOnly);
  els = {
    root: container,
    monthLabel: container.querySelector('#calendar-month-label'),
    grid: container.querySelector('#calendar-grid'),
    actions: container.querySelector('#calendar-actions'),
    btnPrev: container.querySelector('#calendar-prev'),
    btnNext: container.querySelector('#calendar-next'),
    btnToday: container.querySelector('#calendar-today'),
    btnSelectToggle: container.querySelector('#calendar-select-toggle')
  };

  els.btnPrev.addEventListener('click', () => navigate(-1));
  els.btnNext.addEventListener('click', () => navigate(1));
  els.btnToday.addEventListener('click', goToToday);
  els.btnSelectToggle?.addEventListener('click', toggleSelectMode);

  document.addEventListener('click', handleOutsideClick);
  document.addEventListener('keydown', handleEscape);

  load();
}

function navigate(delta) {
  state.month += delta;
  if (state.month < 0) {
    state.month = 11;
    state.year -= 1;
  } else if (state.month > 11) {
    state.month = 0;
    state.year += 1;
  }
  load();
}

function goToToday() {
  const today = new Date();
  state.year = today.getFullYear();
  state.month = today.getMonth();
  load();
}

async function load() {
  state.loading = true;
  render();

  const weeks = buildMonthMatrix(state.year, state.month);
  const startISO = weeks[0][0].iso;
  const endISO = weeks[weeks.length - 1][6].iso;

  try {
    const [statuses, priceRules] = await Promise.all([
      availabilityService.getStatusesInRange(startISO, endISO),
      // Only the read-only (User role) view shows per-date prices — admins
      // already have the full Prices tab, so skip this fetch for them.
      state.readOnly ? priceService.findRatesForRange(startISO, addDays(endISO, 1)) : Promise.resolve([])
    ]);
    state.statuses = statuses;
    state.priceRules = priceRules;
  } catch (err) {
    toast.error(err.message);
    state.statuses = new Map();
    state.priceRules = [];
  }

  // Fetched separately from the block above on purpose: this table is newer
  // than the rest of the schema, so until sql/005 has been run it 404s —
  // that should leave the calendar's actual statuses working as normal,
  // just without linked-stay markers, not take down the whole month view.
  try {
    state.linkedStays = await linkedStayService.findLinkedStaysForRange(startISO, endISO);
  } catch {
    state.linkedStays = [];
  }

  state.loading = false;
  render();
}

/** A linked-stay range never overlaps another (enforced in Postgres), so at most one can match. */
function findLinkedStayForDate(dateISO) {
  return state.linkedStays.find((g) => g.startDate <= dateISO && dateISO <= g.endDate) || null;
}

/** The `neom_price` exclusion constraint guarantees ranges never overlap, so at most one rule can match. */
function findPriceForDate(dateISO) {
  return state.priceRules.find((r) => r.startDate <= dateISO && dateISO <= r.endDate) || null;
}

function renderPriceLine(dateISO) {
  const rule = findPriceForDate(dateISO);
  return rule
    ? `<span class="cell-price">${formatIDRShort(rule.pricePerNight)}</span>`
    : `<span class="cell-price cell-price--missing">لا يوجد سعر</span>`;
}

// ---------------------------------------------------------------------------
// Bulk "select multiple" mode
// ---------------------------------------------------------------------------
function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  state.selectedDates.clear();
  closePopover();
  render();
}

function toggleDateSelection(dateISO) {
  if (state.selectedDates.has(dateISO)) {
    state.selectedDates.delete(dateISO);
  } else {
    state.selectedDates.add(dateISO);
  }
  render();
}

async function applyBulkStatus(status) {
  const dates = Array.from(state.selectedDates);
  if (!dates.length) return;

  try {
    await availabilityService.setStatusBulk(dates, status);
    toast.success(`${dates.length} date${dates.length === 1 ? '' : 's'} marked as ${STATUSES[status].label}.`);
    state.selectedDates.clear();
    load();
  } catch (err) {
    toast.error(err.message);
  }
}

function datesAreContiguous(sortedIsoDates) {
  for (let i = 1; i < sortedIsoDates.length; i++) {
    if (addDays(sortedIsoDates[i - 1], 1) !== sortedIsoDates[i]) return false;
  }
  return true;
}

/**
 * "Link" here is purely a visual/informational marker (a distinct border,
 * badge, and tooltip on the calendar cell — see is-linked in availability.css)
 * saying these dates must be booked as one stay. There's no guest-facing
 * booking flow in this app for it to actually enforce — staff still set
 * each date's status independently — so this is a heads-up for whoever's
 * reading the calendar, not a hard lock.
 */
function openLinkDatesModal() {
  const dates = Array.from(state.selectedDates).sort();
  if (!datesAreContiguous(dates)) {
    toast.error('Selected dates must be consecutive (no gaps) to link them as one stay.');
    return;
  }

  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const body = document.createElement('div');
  body.innerHTML = `
    <p style="font-size:13.5px;color:var(--text-secondary);margin:0 0 12px;">
      ${formatDisplayDate(startDate)} – ${formatDisplayDate(endDate)} (${dates.length} nights) will be marked
      as one linked stay — the calendar will clearly flag that these dates can't be booked separately.
    </p>
    <div class="field">
      <label class="field-label" for="link-note">Note (optional)</label>
      <input class="input" type="text" id="link-note" placeholder="e.g. Min 3 nights — New Year's package" />
    </div>
  `;

  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.gap = '8px';
  footer.innerHTML = `
    <button type="button" class="btn btn-secondary" id="link-cancel">Cancel</button>
    <button type="button" class="btn btn-primary" id="link-confirm">Link These Dates</button>
  `;

  const dialog = openModal({ title: '🔗 Link Dates as One Stay', bodyEl: body, footerEl: footer });
  footer.querySelector('#link-cancel').addEventListener('click', () => dialog.close());
  footer.querySelector('#link-confirm').addEventListener('click', async () => {
    const note = body.querySelector('#link-note').value;
    try {
      await linkedStayService.createLinkedStay({ startDate, endDate, note });
      toast.success(`${formatDisplayDate(startDate)} – ${formatDisplayDate(endDate)} linked as one stay.`);
      dialog.close();
      state.selectedDates.clear();
      load();
    } catch (err) {
      toast.error(err.message);
    }
  });
}

function renderActionsBar() {
  if (!state.selectMode) {
    els.actions.hidden = true;
    els.actions.innerHTML = '';
    return;
  }

  els.actions.hidden = false;
  const count = state.selectedDates.size;

  els.actions.innerHTML = `
    <div class="bulk-actions-bar">
      <span class="bulk-actions-count">${count} selected</span>
      <div class="bulk-actions-buttons">
        ${EDITABLE_STATUSES.map(
          (key) => `
          <button type="button" class="btn btn-sm btn-secondary bulk-action-btn" data-status="${key}" ${count ? '' : 'disabled'}>
            <span class="legend-swatch" style="background:${STATUSES[key].color}"></span>
            ${STATUSES[key].label}
          </button>`
        ).join('')}
        <button type="button" class="btn btn-sm btn-secondary bulk-action-btn" id="bulk-link" ${count < 2 ? 'disabled' : ''}>
          🔗 Link Nights
        </button>
        <button type="button" class="btn btn-sm btn-ghost" id="bulk-clear" ${count ? '' : 'disabled'}>Clear</button>
        <button type="button" class="btn btn-sm btn-ghost" id="bulk-done">Done</button>
      </div>
    </div>
  `;

  els.actions.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      applyBulkStatus(btn.dataset.status);
    });
  });
  els.actions.querySelector('#bulk-link').addEventListener('click', (event) => {
    event.stopPropagation();
    openLinkDatesModal();
  });
  els.actions.querySelector('#bulk-clear').addEventListener('click', (event) => {
    event.stopPropagation();
    state.selectedDates.clear();
    render();
  });
  els.actions.querySelector('#bulk-done').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelectMode();
  });
}

function render() {
  els.monthLabel.textContent = monthLabel(state.year, state.month);
  closePopover();

  if (!state.readOnly) {
    els.btnSelectToggle.textContent = state.selectMode ? 'Cancel Selecting' : 'Select Multiple';
    els.btnSelectToggle.classList.toggle('btn-primary', state.selectMode);
    els.btnSelectToggle.classList.toggle('btn-secondary', !state.selectMode);
    renderActionsBar();
  }

  if (state.loading) {
    els.grid.innerHTML = Array.from({ length: 35 })
      .map(() => `<div class="skeleton" style="height:84px;"></div>`)
      .join('');
    return;
  }

  const weeks = buildMonthMatrix(state.year, state.month);
  const today = todayISO();

  const cellsHtml = weeks
    .flat()
    .map((day) => {
      const fallbackStatus = day.iso < today ? 'passed' : 'available';
      const info = state.statuses.get(day.iso) || { status: fallbackStatus, notes: '' };
      const editable = day.inCurrentMonth && info.status !== 'passed' && !state.readOnly;
      const selected = state.selectedDates.has(day.iso);
      const statusMeta = STATUSES[info.status] || STATUSES.available;
      const linked = day.inCurrentMonth ? findLinkedStayForDate(day.iso) : null;
      const linkedTitle = linked
        ? `Must be booked together: ${formatDisplayDate(linked.startDate)} – ${formatDisplayDate(linked.endDate)}${linked.note ? ' — ' + linked.note : ''}`
        : '';
      return `
        <button
          type="button"
          class="calendar-cell${day.inCurrentMonth ? '' : ' is-empty'}${day.iso === today ? ' is-today' : ''}${editable ? ' is-editable' : ''}${selected ? ' is-selected' : ''}${linked ? ' is-linked' : ''}"
          data-date="${day.iso}"
          ${day.inCurrentMonth ? `data-status="${info.status}"` : ''}
          ${linkedTitle ? `title="${escapeAttr(linkedTitle)}"` : ''}
          ${editable ? '' : 'tabindex="-1" aria-disabled="true"'}
          ${day.inCurrentMonth ? '' : 'disabled'}
        >
          <span class="cell-date">${day.day}</span>
          ${
            day.inCurrentMonth
              ? `<div class="cell-bottom">
                   ${state.readOnly ? renderPriceLine(day.iso) : ''}
                   <span class="cell-status-pill">${statusMeta.label}</span>
                   ${info.notes ? `<span class="cell-note" title="${escapeAttr(info.notes)}">${escapeHtml(info.notes)}</span>` : ''}
                 </div>`
              : ''
          }
        </button>`;
    })
    .join('');

  els.grid.innerHTML =
    WEEKDAYS.map((w) => `<div class="calendar-weekday">${w}</div>`).join('') + cellsHtml;

  els.grid.querySelectorAll('.calendar-cell.is-editable').forEach((cell) => {
    cell.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.selectMode) {
        toggleDateSelection(cell.dataset.date);
      } else {
        openPopover(cell);
      }
    });
  });
}

function openPopover(cellEl) {
  const dateISO = cellEl.dataset.date;
  if (activePopover && activePopover.dateISO === dateISO) {
    closePopover();
    return;
  }
  closePopover();

  const info = state.statuses.get(dateISO) || { status: 'available', notes: '' };
  const linked = findLinkedStayForDate(dateISO);
  const rect = cellEl.getBoundingClientRect();

  const popover = document.createElement('div');
  popover.className = 'status-popover';
  popover.innerHTML = `
    <div class="status-popover-title">${dateISO}</div>
    ${EDITABLE_STATUSES.map(
      (key) => `
      <button type="button" class="status-option" data-status="${key}">
        <span class="legend-swatch" style="background:${STATUSES[key].color}"></span>
        ${STATUSES[key].label}
      </button>`
    ).join('')}
    <div class="status-popover-notes">
      <input class="input status-popover-notes-input" type="text" id="popover-notes" placeholder="Optional note" value="${escapeAttr(info.notes)}" />
    </div>
    ${
      linked
        ? `<div class="status-popover-linked">
             🔗 ${escapeHtml(formatDisplayDate(linked.startDate))} – ${escapeHtml(formatDisplayDate(linked.endDate))}${linked.note ? ' — ' + escapeHtml(linked.note) : ''}
             <button type="button" class="btn btn-sm btn-ghost" id="popover-unlink">Unlink</button>
           </div>`
        : ''
    }
  `;

  document.body.appendChild(popover);

  const top = Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 10);
  const left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 10);
  popover.style.top = `${Math.max(10, top)}px`;
  popover.style.left = `${Math.max(10, left)}px`;

  popover.querySelector('#popover-unlink')?.addEventListener('click', (event) => {
    event.stopPropagation();
    unlinkStay(linked);
  });

  popover.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const notes = popover.querySelector('#popover-notes').value;
      await saveStatus(dateISO, btn.dataset.status, notes);
    });
  });

  popover.addEventListener('click', (event) => event.stopPropagation());

  activePopover = { el: popover, dateISO };
}

function closePopover() {
  if (activePopover) {
    activePopover.el.remove();
    activePopover = null;
  }
}

function handleOutsideClick() {
  closePopover();
}

function handleEscape(event) {
  if (event.key === 'Escape') closePopover();
}

async function saveStatus(dateISO, status, notes) {
  try {
    await availabilityService.setStatus(dateISO, status, notes);
    toast.success(`${dateISO} marked as ${STATUSES[status].label}.`);
    closePopover();
    load();
  } catch (err) {
    toast.error(err.message);
  }
}

async function unlinkStay(linked) {
  const confirmed = await confirmDialog({
    title: 'Unlink These Dates',
    message: `Remove the "must be booked together" link for ${formatDisplayDate(linked.startDate)} – ${formatDisplayDate(linked.endDate)}? Each date's own status is unaffected — only the linking goes away.`,
    confirmLabel: 'Unlink',
    danger: true
  });
  if (!confirmed) return;

  try {
    await linkedStayService.deleteLinkedStay(linked.id);
    toast.success('Dates unlinked.');
    closePopover();
    load();
  } catch (err) {
    toast.error(err.message);
  }
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

function escapeAttr(value) {
  return escapeHtml(value);
}

function template(readOnly) {
  return `
    <div class="page">
      <div class="card">
        <div class="card-body">
          <div class="calendar-toolbar">
            <div class="calendar-nav">
              <button class="btn btn-icon btn-secondary" id="calendar-prev" type="button" aria-label="Previous month">‹</button>
              <div class="calendar-month-label" id="calendar-month-label"></div>
              <button class="btn btn-icon btn-secondary" id="calendar-next" type="button" aria-label="Next month">›</button>
              <button class="btn btn-sm btn-ghost" id="calendar-today" type="button">Today</button>
            </div>
            <div class="calendar-legend">
              ${Object.entries(STATUSES)
                // Passed dates are hidden outright in the read-only (User)
                // view below, so the legend swatch explaining them would be
                // pointing at nothing — dropping it frees up a bit more
                // room for the swatches that still apply.
                .filter(([key]) => !(readOnly && key === 'passed'))
                .map(
                  ([, meta]) =>
                    `<span class="legend-item"><span class="legend-swatch" style="background:${meta.color}"></span>${meta.label}</span>`
                )
                .join('')}
              <span class="legend-item">🔗 Must book together</span>
            </div>
          </div>
          ${
            readOnly
              ? ''
              : `
          <div class="calendar-select-row">
            <button class="btn btn-sm btn-secondary" id="calendar-select-toggle" type="button">Select Multiple</button>
          </div>
          <div class="calendar-actions" id="calendar-actions" hidden></div>
          `
          }
          <div class="calendar-grid${readOnly ? ' calendar-grid--priced' : ''}" id="calendar-grid"></div>
        </div>
      </div>
    </div>
  `;
}
