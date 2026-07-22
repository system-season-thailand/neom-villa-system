import { supabaseClient } from '../config/supabase.js';
import * as availabilityService from '../services/availabilityService.js';
import { STATUSES } from '../services/availabilityService.js';
import * as priceService from '../services/priceService.js';
import * as linkedStayService from '../services/linkedStayService.js';
import * as settingsService from '../services/settingsService.js';
import { toast } from './toast.js';
import { openModal, confirmDialog } from './modal.js';
import { createOptionSelect } from './optionSelect.js';
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
    btnToday: container.querySelector('#calendar-today')
  };

  els.btnPrev.addEventListener('click', () => navigate(-1));
  els.btnNext.addEventListener('click', () => navigate(1));
  els.btnToday.addEventListener('click', goToToday);

  document.addEventListener('click', handleOutsideClick);
  document.addEventListener('keydown', handleEscape);

  subscribeRealtime();
  load();
}

/**
 * Live sync across devices — a status change made on one phone/laptop shows
 * up on every other device with this calendar open, no manual refresh
 * needed. Requires `neom_availability` to be added to the `supabase_realtime`
 * publication (see sql/007_enable_availability_realtime.sql); until that's
 * been run in Supabase this subscribes successfully but simply never
 * receives any events; the calendar still works fully via manual navigation
 * either way, since load() is unaffected by this. Never torn down: every tab
 * is mounted exactly once for the lifetime of the page (see app.js), so
 * there's no remount path that would stack up duplicate subscriptions.
 */
function subscribeRealtime() {
  supabaseClient
    .channel('neom_availability_live')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'neom_availability' },
      (payload) => {
        const dateISO = payload.eventType === 'DELETE' ? payload.old.date : payload.new.date;
        if (payload.eventType === 'DELETE') {
          state.statuses.delete(dateISO);
        } else {
          state.statuses.set(dateISO, fromRealtimeRow(payload.new));
        }
        // A change to a date outside the month currently on screen still
        // updates `state.statuses` above (so it's already fresh whenever
        // staff navigate there — though load() would refetch it fresh
        // anyway), but only actually redraws the grid when it would change
        // what's visible right now.
        if (!state.loading && isDateInView(dateISO)) render();
      }
    )
    .subscribe();
}

function fromRealtimeRow(row) {
  return {
    date: row.date,
    status: row.status,
    statusColor: row.status_color,
    notes: row.notes || '',
    bookedBy: row.booked_by || ''
  };
}

function isDateInView(dateISO) {
  const weeks = buildMonthMatrix(state.year, state.month);
  const startISO = weeks[0][0].iso;
  const endISO = weeks[weeks.length - 1][6].iso;
  return dateISO >= startISO && dateISO <= endISO;
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

/** Existing linked-stay groups that overlap OR directly touch [startISO, endISO] —
 * either way, inserting a new range spanning both would collide with the
 * database's own exclusion constraint (which only allows one row to occupy
 * any given date). openLinkDatesModal() uses this to fold such groups into
 * one merged stay instead of failing with that constraint's error. */
function findMergeableLinkedStays(startISO, endISO) {
  return state.linkedStays.filter(
    (g) => g.startDate <= addDays(endISO, 1) && startISO <= addDays(g.endDate, 1)
  );
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

/** Admin-only equivalent of renderPriceLine above — the same cell-price
 * styling, but showing who booked this date rather than its nightly rate
 * (admins already have the full Prices tab for rates). */
function renderBookerLine(info) {
  if (info.status !== 'booked' || !info.bookedBy) return '';
  return `<span class="cell-price">${escapeHtml(info.bookedBy)}</span>`;
}

// ---------------------------------------------------------------------------
// Bulk "select multiple" mode — entered via a long-press (touch) or
// double-click (mouse) on any editable cell rather than a dedicated toggle
// button; exited via the ✕ button in the actions bar or by deselecting back
// down to zero dates.
// ---------------------------------------------------------------------------
function enterSelectModeWithDate(dateISO) {
  state.selectMode = true;
  state.selectedDates.add(dateISO);
  closePopover();
  render();
}

function toggleDateSelection(dateISO) {
  if (state.selectedDates.has(dateISO)) {
    state.selectedDates.delete(dateISO);
  } else {
    state.selectedDates.add(dateISO);
  }
  if (state.selectedDates.size === 0) {
    state.selectMode = false;
  }
  render();
}

function clearSelection() {
  state.selectedDates.clear();
  state.selectMode = false;
}

/** Every ISO date from startISO to endISO, inclusive. */
function datesInRange(startISO, endISO) {
  const dates = [];
  let cursor = startISO;
  while (cursor <= endISO) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

/**
 * Applies one status to every selected date at once — plus every date in
 * any linked-stay group a selected date belongs to, even if not itself
 * selected, so a status change never leaves part of a linked group behind.
 * Merges the rows the upsert itself returns straight into local state and
 * repaints synchronously — no follow-up fetch, so there's no loading-
 * skeleton flash for what's already-known data. Linked-stay markers and
 * price rules are untouched by a status change, so nothing else needs to be
 * refetched either.
 */
async function applyBulkStatus(status, bookedBy = '') {
  const selected = Array.from(state.selectedDates);
  if (!selected.length) return;

  const dateSet = new Set(selected);
  for (const dateISO of selected) {
    const linked = findLinkedStayForDate(dateISO);
    if (linked) {
      for (const d of datesInRange(linked.startDate, linked.endDate)) dateSet.add(d);
    }
  }
  const dates = Array.from(dateSet);

  try {
    const updatedRows = await availabilityService.setStatusBulk(dates, status, '', bookedBy);
    for (const row of updatedRows) {
      state.statuses.set(row.date, row);
    }
    toast.success(`${dates.length} date${dates.length === 1 ? '' : 's'} marked as ${STATUSES[status].label}.`);
    clearSelection();
    render();
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
 *
 * If the selection overlaps or directly touches one or more existing linked
 * groups, this merges them all into one bigger group spanning the full
 * range instead of trying (and failing, on the database's own exclusion
 * constraint) to insert a second, colliding row. That's also why a single
 * selected date is enough to open this — extending an existing stay by one
 * night at either end is exactly this same "merge" case.
 */
function openLinkDatesModal() {
  const dates = Array.from(state.selectedDates).sort();
  if (!datesAreContiguous(dates)) {
    toast.error('Selected dates must be consecutive (no gaps) to link them as one stay.');
    return;
  }

  const selectedStart = dates[0];
  const selectedEnd = dates[dates.length - 1];
  const mergeable = findMergeableLinkedStays(selectedStart, selectedEnd);
  const isMerge = mergeable.length > 0;

  const startDate = mergeable.reduce((min, g) => (g.startDate < min ? g.startDate : min), selectedStart);
  const endDate = mergeable.reduce((max, g) => (g.endDate > max ? g.endDate : max), selectedEnd);
  const nightCount = datesInRange(startDate, endDate).length;
  const existingNote = mergeable.find((g) => g.note)?.note || '';

  const body = document.createElement('div');
  body.innerHTML = `
    <p style="font-size:13.5px;color:var(--text-secondary);margin:0 0 12px;">
      ${
        isMerge
          ? `This touches ${mergeable.length === 1 ? 'an existing linked stay' : `${mergeable.length} existing linked stays`} — they'll be merged into one: `
          : ''
      }${formatDisplayDate(startDate)} – ${formatDisplayDate(endDate)} (${nightCount} nights) will be marked
      as one linked stay — the calendar will clearly flag that these dates can't be booked separately.
    </p>
    <div class="field">
      <label class="field-label" for="link-note">Note (optional)</label>
      <input class="input" type="text" id="link-note" placeholder="e.g. Min 3 nights — New Year's package" value="${escapeAttr(existingNote)}" />
    </div>
  `;

  const footer = document.createElement('div');
  footer.style.display = 'flex';
  footer.style.gap = '8px';
  footer.innerHTML = `
    <button type="button" class="btn btn-secondary" id="link-cancel">Cancel</button>
    <button type="button" class="btn btn-primary" id="link-confirm">${isMerge ? 'Merge & Link' : 'Link These Dates'}</button>
  `;

  const dialog = openModal({ title: '🔗 Link Dates as One Stay', bodyEl: body, footerEl: footer });
  footer.querySelector('#link-cancel').addEventListener('click', () => dialog.close());
  footer.querySelector('#link-confirm').addEventListener('click', async () => {
    const note = body.querySelector('#link-note').value;
    try {
      if (isMerge) {
        // The exclusion constraint would reject the merged insert below
        // while any of these still exist, so they have to go first.
        await Promise.all(mergeable.map((g) => linkedStayService.deleteLinkedStay(g.id)));
        const mergedIds = new Set(mergeable.map((g) => g.id));
        state.linkedStays = state.linkedStays.filter((g) => !mergedIds.has(g.id));
      }
      const created = await linkedStayService.createLinkedStay({ startDate, endDate, note });
      state.linkedStays.push(created);
      toast.success(
        isMerge
          ? `Merged into one linked stay: ${formatDisplayDate(startDate)} – ${formatDisplayDate(endDate)}.`
          : `${formatDisplayDate(startDate)} – ${formatDisplayDate(endDate)} linked as one stay.`
      );
      dialog.close();
      clearSelection();
      render();
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
  const selected = Array.from(state.selectedDates);
  const count = selected.length;
  // Normally linking needs 2+ dates, but a single selected date is also
  // enough when it touches/overlaps an existing linked stay — that's just
  // extending that stay by one night, the same "merge" openLinkDatesModal()
  // already handles.
  const canLink =
    count >= 2 || (count === 1 && findMergeableLinkedStays(selected[0], selected[0]).length > 0);

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
        <button type="button" class="btn btn-sm btn-secondary bulk-action-btn" id="bulk-link" ${canLink ? '' : 'disabled'}>
          🔗 Link Nights
        </button>
      </div>
      <button type="button" class="btn btn-icon btn-ghost" id="bulk-cancel" aria-label="Cancel selection" title="Cancel selection">✕</button>
    </div>
  `;

  els.actions.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (btn.dataset.status === 'booked') {
        openBookedByPopover(btn, { onPick: (value) => applyBulkStatus('booked', value) });
        return;
      }
      applyBulkStatus(btn.dataset.status);
    });
  });
  els.actions.querySelector('#bulk-link').addEventListener('click', (event) => {
    event.stopPropagation();
    openLinkDatesModal();
  });
  els.actions.querySelector('#bulk-cancel').addEventListener('click', (event) => {
    event.stopPropagation();
    clearSelection();
    render();
  });
}

function render() {
  els.monthLabel.textContent = monthLabel(state.year, state.month);
  closePopover();

  if (!state.readOnly) {
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
        >
          <span class="cell-date">${day.day}</span>
          ${
            day.inCurrentMonth
              ? `<div class="cell-bottom">
                   ${state.readOnly ? renderPriceLine(day.iso) : renderBookerLine(info)}
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

  els.grid.querySelectorAll('.calendar-cell.is-editable').forEach(attachCellInteractions);
}

const LONG_PRESS_MS = 500;

/**
 * Wires up a calendar cell's whole interaction set: a plain click (open the
 * status popover, or toggle this date's selection if already in select
 * mode), a long-press (touch devices — enters select mode with this date
 * selected), and a double-click (mouse — same, for desktop). There's no
 * dedicated "Select Multiple" button any more; this is the only way in.
 * The long-press/double-click path briefly opens (and, for double-click,
 * immediately closes again via the popover's own same-cell toggle) the
 * status popover before entering select mode — a harmless side effect of
 * layering this on top of the plain click handler rather than a real bug.
 */
function attachCellInteractions(cell) {
  const dateISO = cell.dataset.date;
  let longPressTimer = null;
  let longPressFired = false;

  cell.addEventListener(
    'touchstart',
    () => {
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        enterSelectModeWithDate(dateISO);
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );

  const cancelLongPress = () => clearTimeout(longPressTimer);
  cell.addEventListener('touchmove', cancelLongPress);
  cell.addEventListener('touchcancel', cancelLongPress);
  cell.addEventListener('touchend', (event) => {
    cancelLongPress();
    if (longPressFired) {
      // The long-press already handled this tap — swallow the click the
      // touch gesture would otherwise still fire once the finger lifts.
      event.preventDefault();
    }
  });

  cell.addEventListener('click', (event) => {
    event.stopPropagation();
    if (longPressFired) {
      longPressFired = false;
      return;
    }
    if (state.selectMode) {
      toggleDateSelection(dateISO);
    } else {
      openPopover(cell);
    }
  });

  cell.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    if (!state.selectMode) enterSelectModeWithDate(dateISO);
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
  positionPopover(popover, rect);

  popover.querySelector('#popover-unlink')?.addEventListener('click', (event) => {
    event.stopPropagation();
    // Hide the status-popover first — the confirm dialog it triggers is a
    // modal, and having the popover still visible behind/alongside it is
    // just visual noise once the user's focus has moved to that modal.
    closePopover();
    unlinkStay(linked);
  });

  popover.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (btn.dataset.status === 'booked') {
        // Booked By replaces this whole popover with its own standalone one
        // (see openBookedByPopover) rather than expanding inline — fewer
        // clicks to pick a name, since it opens already-expanded and, where
        // the browser supports it, with its dropdown already popped open.
        const notes = popover.querySelector('#popover-notes').value;
        openBookedByPopover(cellEl, {
          currentValue: info.bookedBy || '',
          onPick: (value) => saveStatus(dateISO, 'booked', notes, value)
        });
        return;
      }
      const notes = popover.querySelector('#popover-notes').value;
      await saveStatus(dateISO, btn.dataset.status, notes, '');
    });
  });

  popover.addEventListener('click', (event) => event.stopPropagation());

  activePopover = { el: popover, dateISO };
}

/**
 * A standalone popover holding just the Booked By picker — shown in place of
 * whatever triggered it (the single-date status-popover, or the bulk actions
 * bar's "Booked" button) the instant "Booked" is chosen, so picking a name
 * is the very next action rather than something nested a click deeper.
 * Reuses the same activePopover/closePopover plumbing as the status popover,
 * so outside-click/Escape/re-render all close it exactly the same way.
 */
function openBookedByPopover(anchorEl, { currentValue = '', onPick }) {
  closePopover();

  const popover = document.createElement('div');
  popover.className = 'status-popover';
  popover.innerHTML = `
    <div class="status-popover-title">Booked By</div>
    <div class="status-popover-booked-by">
      <div id="popover-booked-by-slot"></div>
    </div>
  `;
  document.body.appendChild(popover);
  popover.addEventListener('click', (event) => event.stopPropagation());

  const picker = createOptionSelect({
    key: settingsService.BOOKED_BY_KEY,
    label: 'Booked By',
    value: currentValue,
    onChange: (value) => {
      if (!value) return;
      closePopover();
      onPick(value);
    }
  });
  popover.querySelector('#popover-booked-by-slot').appendChild(picker.el);
  // Positioned only once the picker's <select> is actually in the DOM — this
  // popover's final height depends on it, and sizing off the pre-append
  // (shorter) height could clamp it to sit too low and run off-screen.
  positionPopover(popover, anchorEl.getBoundingClientRect());

  activePopover = { el: popover, dateISO: anchorEl.dataset.date || null };
  picker.open();
}

function positionPopover(popover, rect) {
  const top = Math.min(rect.bottom + 6, window.innerHeight - popover.offsetHeight - 10);
  const left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 10);
  popover.style.top = `${Math.max(10, top)}px`;
  popover.style.left = `${Math.max(10, left)}px`;
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

/**
 * Merges the upsert's own returned row(s) straight into local state and
 * repaints synchronously — no follow-up fetch, so there's no loading-
 * skeleton flash for data the mutation itself already handed back. If this
 * date is part of a linked-stay group, the same status/notes/bookedBy is
 * applied to every date in that group, not just the one that was clicked —
 * a linked group is meant to move as one, so a status change on any single
 * night in it shouldn't leave the rest behind.
 */
async function saveStatus(dateISO, status, notes, bookedBy) {
  try {
    const linked = findLinkedStayForDate(dateISO);
    if (linked) {
      const dates = datesInRange(linked.startDate, linked.endDate);
      const updatedRows = await availabilityService.setStatusBulk(dates, status, notes, bookedBy);
      for (const row of updatedRows) {
        state.statuses.set(row.date, row);
      }
      toast.success(`${dates.length} linked dates marked as ${STATUSES[status].label}.`);
    } else {
      const updated = await availabilityService.setStatus(dateISO, status, notes, bookedBy);
      state.statuses.set(dateISO, updated);
      toast.success(`${dateISO} marked as ${STATUSES[status].label}.`);
    }
    closePopover();
    render();
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
    state.linkedStays = state.linkedStays.filter((g) => g.id !== linked.id);
    toast.success('Dates unlinked.');
    closePopover();
    render();
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
          <div class="calendar-grid${readOnly ? ' calendar-grid--priced' : ''}" id="calendar-grid"></div>
        </div>
        ${readOnly ? '' : `<div class="calendar-actions" id="calendar-actions" hidden></div>`}
      </div>
    </div>
  `;
}
