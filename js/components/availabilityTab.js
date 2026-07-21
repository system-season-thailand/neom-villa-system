import * as availabilityService from '../services/availabilityService.js';
import { STATUSES } from '../services/availabilityService.js';
import { toast } from './toast.js';
import { buildMonthMatrix, monthLabel, todayISO } from '../utils/dateUtils.js';

const EDITABLE_STATUSES = ['available', 'booked', 'on_hold', 'blocked'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

let els = {};
let state = null;
let activePopover = null;

export function mount(container) {
  const today = new Date();
  state = {
    year: today.getFullYear(),
    month: today.getMonth(),
    statuses: new Map(),
    loading: true
  };

  container.innerHTML = template();
  els = {
    root: container,
    monthLabel: container.querySelector('#calendar-month-label'),
    grid: container.querySelector('#calendar-grid'),
    btnPrev: container.querySelector('#calendar-prev'),
    btnNext: container.querySelector('#calendar-next'),
    btnToday: container.querySelector('#calendar-today')
  };

  els.btnPrev.addEventListener('click', () => navigate(-1));
  els.btnNext.addEventListener('click', () => navigate(1));
  els.btnToday.addEventListener('click', goToToday);

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
    state.statuses = await availabilityService.getStatusesInRange(startISO, endISO);
  } catch (err) {
    toast.error(err.message);
    state.statuses = new Map();
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  els.monthLabel.textContent = monthLabel(state.year, state.month);
  closePopover();

  if (state.loading) {
    els.grid.innerHTML = Array.from({ length: 35 })
      .map(() => `<div class="skeleton" style="height:78px;"></div>`)
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
      const editable = day.inCurrentMonth && info.status !== 'passed';
      const statusMeta = STATUSES[info.status] || STATUSES.available;
      return `
        <button
          type="button"
          class="calendar-cell${day.inCurrentMonth ? '' : ' is-empty'}${day.iso === today ? ' is-today' : ''}${editable ? ' is-editable' : ''}"
          data-date="${day.iso}"
          ${day.inCurrentMonth ? `data-status="${info.status}"` : ''}
          ${editable ? '' : 'tabindex="-1" aria-disabled="true"'}
          ${day.inCurrentMonth ? '' : 'disabled'}
        >
          <span class="cell-date">${day.day}</span>
          ${
            day.inCurrentMonth
              ? `<span class="cell-status-pill">${statusMeta.label}</span>
                 ${info.notes ? `<span class="cell-note" title="${escapeAttr(info.notes)}">${escapeHtml(info.notes)}</span>` : ''}`
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
      openPopover(cell);
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
      <input class="input" type="text" id="popover-notes" placeholder="Optional note" value="${escapeAttr(info.notes)}" style="height:32px;font-size:12px;" />
    </div>
  `;

  document.body.appendChild(popover);

  const top = Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 10);
  const left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 10);
  popover.style.top = `${Math.max(10, top)}px`;
  popover.style.left = `${Math.max(10, left)}px`;

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

function template() {
  return `
    <div class="page">
      <div class="page-header">
        <div>
          <div class="page-title">توافرات <span class="text-muted" style="font-size:13px;font-weight:500;">Availability</span></div>
          <div class="page-subtitle">Click any future date to update its status</div>
        </div>
      </div>

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
                .map(
                  ([, meta]) =>
                    `<span class="legend-item"><span class="legend-swatch" style="background:${meta.color}"></span>${meta.label}</span>`
                )
                .join('')}
            </div>
          </div>
          <div class="calendar-grid" id="calendar-grid"></div>
        </div>
      </div>
    </div>
  `;
}
