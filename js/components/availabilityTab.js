import { supabaseClient } from '../config/supabase.js';
import * as availabilityService from '../services/availabilityService.js';
import { STATUSES } from '../services/availabilityService.js';
import * as priceService from '../services/priceService.js';
import * as linkedStayService from '../services/linkedStayService.js';
import * as settingsService from '../services/settingsService.js';
import { toast } from './toast.js';
import { openModal, confirmDialog } from './modal.js';
import { createOptionSelect } from './optionSelect.js';
import { buildMonthMatrix, monthLabel, todayISO, addDays, formatDisplayDate, formatDateTime } from '../utils/dateUtils.js';
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
    selectAnchor: null,
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
    bookedBy: row.booked_by || '',
    bookedAt: row.booked_at || null,
    onHoldAt: row.on_hold_at || null
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
      // Both roles show per-date prices now — admins get them right on the
      // calendar too, not just via the separate Prices tab.
      priceService.findRatesForRange(startISO, addDays(endISO, 1))
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

/** Admin view's equivalent of the read-only calendar's price line — same
 * price, same "2.5 JT" style (and the same "لا يوجد سعر" for a date with no
 * pricing rule), on every date — plus, when the date is actually booked,
 * who booked it right above it. Admins already have the full Prices tab for
 * managing rates, but seeing them right on the calendar too (not just the
 * price-per-night table) means one less tab switch to check "what would
 * this night cost". */
function renderAdminLine(dateISO, info) {
  const bookerLine = info.status === 'booked' && info.bookedBy ? `<span class="cell-price">${escapeHtml(info.bookedBy)}</span>` : '';
  return `${bookerLine}${renderPriceLine(dateISO)}`;
}

// ---------------------------------------------------------------------------
// Bulk "select multiple" mode — entered via a long-press (touch) or
// double-click (mouse) on any editable cell rather than a dedicated toggle
// button; exited via the ✕ button in the actions bar or by deselecting back
// down to zero dates. The cell that entered select mode becomes the anchor:
// every plain click on another cell afterwards re-selects the whole inclusive
// range between the anchor and whichever cell was just clicked (replacing
// the previous selection, not adding to it) — two clicks pick a whole range
// instead of clicking every night in it one at a time.
// ---------------------------------------------------------------------------
function enterSelectModeWithDate(dateISO) {
  state.selectMode = true;
  state.selectAnchor = dateISO;
  state.selectedDates = new Set([dateISO]);
  closePopover();
  render();
}

function selectRangeTo(dateISO) {
  if (!state.selectAnchor) state.selectAnchor = dateISO;
  const start = state.selectAnchor < dateISO ? state.selectAnchor : dateISO;
  const end = state.selectAnchor < dateISO ? dateISO : state.selectAnchor;
  state.selectedDates = new Set(datesInRange(start, end));
  render();
}

function clearSelection() {
  state.selectedDates.clear();
  state.selectMode = false;
  state.selectAnchor = null;
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
      const isPassedDate = day.iso < today;
      const fallbackStatus = isPassedDate ? 'passed' : 'available';
      const info = state.statuses.get(day.iso) || { status: fallbackStatus, notes: '' };
      // Admins can edit any date, passed or not — a passed date is only ever
      // visually distinct (dimmed, "Passed & X" label below), never locked
      // out, so a forgotten/incorrect date can always be corrected.
      const editable = day.inCurrentMonth && !state.readOnly;
      // The read-only User calendar has no editing at all, but an On Hold
      // date is still clickable there — the only thing it opens is a
      // read-only countdown to when it reverts to Available (see
      // attachReadOnlyOnHoldClick), never the admin's status-changing popover.
      const readOnlyClickable = state.readOnly && day.inCurrentMonth && info.status === 'on_hold';
      const focusable = editable || readOnlyClickable;
      // Never true for the empty padding cells that fill out the grid with
      // adjacent months' dates — those aren't real cells of the month on
      // screen and have no click handler wired up at all (see the
      // .is-editable-only querySelectorAll below), so they must never show
      // the selected checkmark even when their date happens to fall inside a
      // range selected while browsing a different month.
      const selected = day.inCurrentMonth && state.selectedDates.has(day.iso);
      const statusMeta = STATUSES[info.status] || STATUSES.available;
      // Only "Booked" gets called out specially once a date is passed — "it
      // was booked, and it's now in the past" is the one combination worth
      // flagging in the label (revenue/booker history an admin might need to
      // fix). A passed Available/On Hold/Blocked date still keeps its real
      // status's color/data-status (dimmed via .is-passed), but the label
      // just reads "Passed" — there's nothing about "it was on hold" that's
      // worth a compound label the way "it was booked" is.
      const statusLabel = isPassedDate ? (info.status === 'booked' ? `Passed & ${statusMeta.label}` : 'Passed') : statusMeta.label;
      const linked = day.inCurrentMonth ? findLinkedStayForDate(day.iso) : null;
      const linkedTitle = linked
        ? `Must be booked together: ${formatDisplayDate(linked.startDate)} – ${formatDisplayDate(linked.endDate)}${linked.note ? ' — ' + linked.note : ''}`
        : '';
      return `
        <button
          type="button"
          class="calendar-cell${day.inCurrentMonth ? '' : ' is-empty'}${day.iso === today ? ' is-today' : ''}${isPassedDate ? ' is-passed' : ''}${editable ? ' is-editable' : ''}${readOnlyClickable ? ' is-clickable' : ''}${selected ? ' is-selected' : ''}${linked ? ' is-linked' : ''}"
          data-date="${day.iso}"
          ${day.inCurrentMonth ? `data-status="${info.status}"` : ''}
          ${linkedTitle ? `title="${escapeAttr(linkedTitle)}"` : ''}
          ${focusable ? '' : 'tabindex="-1" aria-disabled="true"'}
        >
          <span class="cell-date">${day.day}</span>
          ${
            day.inCurrentMonth
              ? `<div class="cell-bottom">
                   ${state.readOnly ? renderPriceLine(day.iso) : renderAdminLine(day.iso, info)}
                   <span class="cell-status-pill">${statusLabel}</span>
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
  if (state.readOnly) {
    els.grid.querySelectorAll('.calendar-cell.is-clickable').forEach(attachReadOnlyOnHoldClick);
  }
}

const LONG_PRESS_MS = 500;

/**
 * Wires up a calendar cell's whole interaction set: a plain click (open the
 * status popover; or, if already in select mode, extend the selection — see
 * selectRangeTo — to the full range between this cell and the anchor that
 * started select mode, unless this cell *is* that anchor, in which case the
 * click instead turns select mode back off), a long-press (touch devices —
 * enters select mode with this date as the anchor), and a double-click (mouse — same, for
 * desktop). There's no dedicated "Select Multiple" button any more; this is
 * the only way in. The long-press/double-click path briefly opens (and, for
 * double-click, immediately closes again via the popover's own same-cell
 * toggle) the status popover before entering select mode — a harmless side
 * effect of layering this on top of the plain click handler rather than a
 * real bug.
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
      if (dateISO === state.selectAnchor) {
        // Clicking the very cell that started select mode again is the
        // "undo" gesture — turns select mode back off rather than
        // re-selecting that same single date.
        clearSelection();
        render();
      } else {
        selectRangeTo(dateISO);
      }
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
  // "Available" means "open for a future booking" — meaningless for a date
  // that's already happened, so a passed date gets "Passed" in its place
  // instead: the only way to undo an explicit status (e.g. Booked) set on a
  // passed date and let it fall back to a plain "Passed" again, since
  // 'passed' itself can never be stored directly (see the table's CHECK
  // constraint) — picking it just deletes the row (see revertToPassed).
  const isPassedDate = dateISO < todayISO();
  const statusOptions = isPassedDate
    ? ['passed', 'booked', 'on_hold', 'blocked']
    : EDITABLE_STATUSES;

  const popover = document.createElement('div');
  popover.className = 'status-popover';
  popover.innerHTML = `
    ${statusOptions.map((key) => {
      // Only the Booked option ever carries a "Booked on …" note — it's
      // this date's own current status that's relevant, not whichever
      // option the admin might switch it to.
      const bookedNote =
        key === 'booked' && info.status === 'booked' && info.bookedAt
          ? `<span class="status-option-sub">Booked on ${escapeHtml(formatDateTime(info.bookedAt))}</span>`
          : '';
      return `
      <button type="button" class="status-option" data-status="${key}">
        <span class="legend-swatch" style="background:${STATUSES[key].color}"></span>
        <span class="status-option-label">
          <span>${STATUSES[key].label}</span>
          ${bookedNote}
        </span>
      </button>`;
    }).join('')}
    <div class="status-popover-notes">
      <input class="input status-popover-notes-input" type="text" id="popover-notes" placeholder="Optional note" value="${escapeAttr(info.notes)}" />
    </div>
    ${
      info.status === 'on_hold' && info.onHoldAt
        ? `<div class="status-popover-countdown">⏳ Hold End in <strong id="popover-countdown-time"></strong></div>`
        : ''
    }
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
  // Started before positioning — same reasoning as openBookedByPopover's own
  // comment below: this popover's final height depends on the countdown
  // text actually being filled in, not the empty <strong> it starts as.
  const countdownIntervalId =
    info.status === 'on_hold' && info.onHoldAt ? startOnHoldCountdown(popover, dateISO, info.onHoldAt) : null;
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
      if (btn.dataset.status === 'passed') {
        await revertToPassed(dateISO);
        return;
      }
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

  activePopover = { el: popover, dateISO, intervalId: countdownIntervalId };
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
    if (activePopover.intervalId) clearInterval(activePopover.intervalId);
    activePopover.el.remove();
    activePopover = null;
  }
}

/** "23h 59m 09s" — deliberately not compacted to omit the hours once they
 * hit 0, so the format never visually reflows partway through the count. */
function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Wires up a live, once-a-second "time remaining" countdown inside an
 * already-appended popover — shared by the admin status-popover and the
 * read-only User's countdown-only popover (see openOnHoldCountdownPopover).
 * The moment it reaches zero, this proactively deletes the row itself
 * (rather than waiting for the next sql/011_on_hold_auto_revert.sql cron
 * sweep, which can lag up to 5 minutes) so whoever's actually watching sees
 * the revert happen immediately; the pg_cron sweep remains the real
 * backstop for every date nobody happens to be looking at. Returns the
 * interval id so the caller can stash it on activePopover for closePopover
 * to clear.
 */
function startOnHoldCountdown(popoverEl, dateISO, onHoldAt) {
  const timeEl = popoverEl.querySelector('#popover-countdown-time');
  if (!timeEl) return null;
  const deadline = new Date(onHoldAt).getTime() + availabilityService.ON_HOLD_MS;
  let intervalId = null;

  const tick = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (intervalId) clearInterval(intervalId);
      try {
        await availabilityService.clearStatus(dateISO);
        state.statuses.delete(dateISO);
      } catch {
        // Best-effort — the pg_cron sweep still catches this shortly even
        // if this immediate revert attempt fails (e.g. offline).
      }
      closePopover();
      render();
      return;
    }
    timeEl.textContent = formatCountdown(remaining);
  };

  tick();
  intervalId = setInterval(tick, 1000);
  return intervalId;
}

/**
 * The only click behavior the read-only User calendar offers at all: an On
 * Hold date opens a countdown-only popover (no status options, no notes —
 * a normal user can't change any date's status) showing when it reverts to
 * Available.
 */
function openOnHoldCountdownPopover(cellEl) {
  const dateISO = cellEl.dataset.date;
  if (activePopover && activePopover.dateISO === dateISO) {
    closePopover();
    return;
  }
  closePopover();

  const info = state.statuses.get(dateISO);
  if (!info?.onHoldAt) return;

  const popover = document.createElement('div');
  popover.className = 'status-popover';
  popover.innerHTML = `
    <div class="status-popover-countdown">⏳ Hold End in <strong id="popover-countdown-time"></strong></div>
  `;
  document.body.appendChild(popover);
  popover.addEventListener('click', (event) => event.stopPropagation());

  const intervalId = startOnHoldCountdown(popover, dateISO, info.onHoldAt);
  positionPopover(popover, cellEl.getBoundingClientRect());

  activePopover = { el: popover, dateISO, intervalId };
}

function attachReadOnlyOnHoldClick(cell) {
  cell.addEventListener('click', (event) => {
    event.stopPropagation();
    openOnHoldCountdownPopover(cell);
  });
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

/**
 * Undoes whatever explicit status a passed date carries (most usefully
 * Booked) by deleting its row entirely, letting it fall back to the
 * sparse-table default — which, for a date before today, is always "Passed"
 * again. Only ever offered in the popover for a date that's already passed
 * (see openPopover), so there's no risk of this accidentally clearing a
 * future date's status.
 */
async function revertToPassed(dateISO) {
  try {
    await availabilityService.clearStatus(dateISO);
    state.statuses.delete(dateISO);
    toast.success(`${dateISO} reverted to Passed.`);
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
        <div class="card-body" style="background: rgb(230, 230, 230) !important; padding: 5px !important;">
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
