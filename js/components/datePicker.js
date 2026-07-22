import { buildMonthMatrix, monthLabel, todayISO, parseISO, formatDisplayDate } from '../utils/dateUtils.js';

const WEEKDAY_LETTERS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

// Only one date-picker popover is ever open at a time across the whole app
// (Prices tab's Start/End fields, Invoice tab's Check-in field) — opening
// one closes any other. The click-outside listener is installed once, here,
// rather than per-caller: closeActiveDatePicker() is a no-op when nothing is
// open, so there's no cost to leaving it permanently attached.
let activeDatePicker = null;
export function closeActiveDatePicker() {
  activeDatePicker?.close();
  activeDatePicker = null;
}
document.addEventListener('click', closeActiveDatePicker);

/**
 * A small inline calendar popover standing in for `<input type="date">` —
 * native date inputs have no way to grey out arbitrary dates, only a
 * min/max bound. Pass `disabledDates` (a Set of ISO date strings) to grey
 * out specific dates, e.g. ones some other pricing rule already covers —
 * omit it (or pass an empty Set) for a picker that should allow every date,
 * like the Invoice tab's check-in field.
 *
 * Pass `getReferenceValue` (a function returning an ISO date string, or a
 * falsy value) for a picker that should open on *another* field's month
 * rather than today's — e.g. the Prices tab's End Date picker opens on
 * Start Date's month, so staff picking a multi-week range don't have to
 * page forward manually every time. Only takes effect while this picker's
 * own value is still empty — once it has a value, opening it always shows
 * its own selected month, same as before.
 */
export function createDatePicker({ value: initialValue, disabledDates = new Set(), onChange, getReferenceValue } = {}) {
  let value = initialValue || '';
  const refDate = value ? parseISO(value) : new Date();
  let year = refDate.getFullYear();
  let month = refDate.getMonth();
  let popoverEl = null;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'input date-picker-trigger';
  syncTriggerLabel();

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (popoverEl) close();
    else open();
  });

  function syncTriggerLabel() {
    trigger.textContent = value ? formatDisplayDate(value) : 'Select date';
    trigger.classList.toggle('is-placeholder', !value);
  }

  function open() {
    closeActiveDatePicker();
    if (!value) {
      const ref = getReferenceValue?.();
      const refDate = ref ? parseISO(ref) : new Date();
      year = refDate.getFullYear();
      month = refDate.getMonth();
    }
    popoverEl = document.createElement('div');
    popoverEl.className = 'date-picker-popover';
    popoverEl.addEventListener('click', (event) => event.stopPropagation());
    document.body.appendChild(popoverEl);
    renderCalendar();

    const rect = trigger.getBoundingClientRect();
    const top = Math.min(rect.bottom + 6, window.innerHeight - popoverEl.offsetHeight - 10);
    const left = Math.min(rect.left, window.innerWidth - popoverEl.offsetWidth - 10);
    popoverEl.style.top = `${Math.max(10, top)}px`;
    popoverEl.style.left = `${Math.max(10, left)}px`;

    activeDatePicker = { close };
  }

  function close() {
    popoverEl?.remove();
    popoverEl = null;
    if (activeDatePicker && activeDatePicker.close === close) activeDatePicker = null;
  }

  function renderCalendar() {
    const weeks = buildMonthMatrix(year, month);
    const today = todayISO();

    popoverEl.innerHTML = `
      <div class="date-picker-nav">
        <button type="button" class="btn btn-icon btn-secondary btn-sm" data-nav="prev" aria-label="Previous month">‹</button>
        <div class="date-picker-month-label">${monthLabel(year, month)}</div>
        <button type="button" class="btn btn-icon btn-secondary btn-sm" data-nav="next" aria-label="Next month">›</button>
      </div>
      <div class="date-picker-grid">
        ${WEEKDAY_LETTERS.map((w) => `<div class="date-picker-weekday">${w}</div>`).join('')}
        ${weeks
          .flat()
          .map((day) => {
            const isDisabled = !day.inCurrentMonth || disabledDates.has(day.iso);
            const classes = ['date-picker-day'];
            if (!day.inCurrentMonth) classes.push('is-empty');
            if (day.iso === today) classes.push('is-today');
            if (day.iso === value) classes.push('is-selected');
            if (isDisabled) classes.push('is-disabled');
            return `<button type="button" class="${classes.join(' ')}" data-date="${day.iso}" ${isDisabled ? 'disabled' : ''}>${day.day}</button>`;
          })
          .join('')}
      </div>
    `;

    popoverEl.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        month += btn.dataset.nav === 'next' ? 1 : -1;
        if (month < 0) {
          month = 11;
          year -= 1;
        } else if (month > 11) {
          month = 0;
          year += 1;
        }
        renderCalendar();
      });
    });

    popoverEl.querySelectorAll('.date-picker-day:not(.is-disabled):not(.is-empty)').forEach((btn) => {
      btn.addEventListener('click', () => {
        value = btn.dataset.date;
        syncTriggerLabel();
        close();
        onChange?.(value);
      });
    });
  }

  return {
    trigger,
    getValue: () => value,
    setValue: (v) => {
      value = v || '';
      syncTriggerLabel();
    }
  };
}
