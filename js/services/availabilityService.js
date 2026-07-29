import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';
import { todayISO, addDays } from '../utils/dateUtils.js';

const TABLE = 'neom_availability';

// Swatch/dot colors for the legend and status-popover option buttons — kept
// in sync with the actual cell colors in css/availability.css. Available's
// dot is a neutral gray rather than literal white, which wouldn't read as a
// visible dot at all against the legend/popover's own light background.
export const STATUSES = {
  available: { label: 'Available', color: '#93959e' },
  booked: { label: 'Booked', color: '#1a7f5a' },
  on_hold: { label: 'On Hold', color: '#d9730d' },
  blocked: { label: 'Blocked', color: '#454b56' },
  passed: { label: 'Passed', color: '#aeb2ba' }
};

function fromRow(row) {
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

/** How long an On Hold date stays on hold before it's treated as Available
 * again — see ON_HOLD_MS's two enforcement points: the pg_cron sweep in
 * sql/011_on_hold_auto_revert.sql (the real, always-on backstop, since it
 * runs whether or not anyone has the app open), and isExpiredOnHold below
 * (an immediate, client-side "don't wait for the next cron tick" check so
 * the calendar reflects the revert the instant someone actually looks). */
export const ON_HOLD_MS = 24 * 60 * 60 * 1000;

function isExpiredOnHold(row) {
  return row.status === 'on_hold' && row.onHoldAt && Date.now() - new Date(row.onHoldAt).getTime() >= ON_HOLD_MS;
}

/** The implicit default for a date with no (or no longer relevant) stored
 * row: "passed" if the date is before today, otherwise "available". */
function fallbackFor(iso, today) {
  const isPassed = iso < today;
  return {
    date: iso,
    status: isPassed ? 'passed' : 'available',
    statusColor: isPassed ? STATUSES.passed.color : STATUSES.available.color,
    notes: '',
    bookedBy: '',
    bookedAt: null,
    onHoldAt: null
  };
}

/**
 * Returns a Map<dateISO, {date,status,statusColor,notes,bookedBy,bookedAt,onHoldAt}>
 * covering every day in [startISO, endISO] inclusive. Dates without a stored
 * row are filled in with the implicit default (see fallbackFor). This keeps
 * the table sparse — staff only ever write a row when a date actually
 * changes state.
 *
 * A stored row's real status (booked/on_hold/blocked) is always preserved
 * as-is, even for a date in the past — the UI layer (see availabilityTab.js)
 * is the one that decides how to *label* a past date that still carries a
 * real status (e.g. "Passed & Booked"), so an admin can still see and
 * correct what actually happened on that date. The one exception is an On
 * Hold row whose 24 hours are already up: see isExpiredOnHold above.
 */
export async function getStatusesInRange(startISO, endISO) {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .select('*')
    .gte('date', startISO)
    .lte('date', endISO);

  if (error) throw friendlyDbError(error, 'Could not load the availability calendar.');

  const byDate = new Map();
  for (const row of data || []) {
    byDate.set(row.date, fromRow(row));
  }

  const today = todayISO();
  const result = new Map();
  let iso = startISO;
  while (iso <= endISO) {
    const stored = byDate.get(iso);
    result.set(iso, stored && !isExpiredOnHold(stored) ? stored : fallbackFor(iso, today));
    iso = addDays(iso, 1);
  }
  return result;
}

const EDITABLE_STATUSES = ['available', 'booked', 'on_hold', 'blocked'];

function assertEditable(status) {
  if (!EDITABLE_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
}

/** Backstops the UI's own "pick a name before it'll save as Booked" flow
 * (see availabilityTab.js) — every booked date must have a booker, so the
 * Summary tab's per-booker breakdown never needs an "Unspecified" bucket. */
function assertBookedByPresent(status, bookedBy) {
  if (status === 'booked' && !bookedBy?.trim()) {
    throw new Error('A Booked By name is required to mark a date as Booked.');
  }
}

/** The object shape a fresh/never-stored date has — same as fallbackFor's
 * non-passed case above. Used to hand back a consistent result after
 * deleting a row for 'available', since there's no upserted row to read one
 * back from. */
function availableFallback(dateISO) {
  return { date: dateISO, status: 'available', statusColor: STATUSES.available.color, notes: '', bookedBy: '', bookedAt: null, onHoldAt: null };
}

/**
 * Sets the status for a single date, past or future — admins can go back
 * and correct a passed date they forgot to update (e.g. mark it Booked
 * after the fact), same as any upcoming date. `bookedBy` is only ever
 * actually stored when `status` is 'booked' — for every other status it's
 * cleared, so a booker's name never lingers on a date that's no longer
 * booked. 'available' is never written as a row at all — most dates are
 * Available, so the table stays sparse by deleting the row outright instead
 * (same as clearStatus/'passed'), discarding any notes on it in the process.
 */
export async function setStatus(dateISO, status, notes = '', bookedBy = '') {
  assertEditable(status);
  assertBookedByPresent(status, bookedBy);

  if (status === 'available') {
    await clearStatus(dateISO);
    return availableFallback(dateISO);
  }

  const { data, error } = await supabaseClient
    .from(TABLE)
    .upsert(
      { date: dateISO, status, notes: notes?.trim() || null, booked_by: status === 'booked' ? bookedBy?.trim() || null : null },
      { onConflict: 'date' }
    )
    .select()
    .single();

  if (error) throw friendlyDbError(error, 'Could not update availability for this date.');
  return fromRow(data);
}

/**
 * Applies one status to many dates at once — the "Select multiple" bulk
 * action in the Availability tab. A single multi-row upsert, so it's one
 * request and one all-or-nothing statement rather than N round trips.
 * `bookedBy` applies to every selected date alike — the UI collects it once,
 * right after "Booked" is clicked, same requirement as the single-date flow.
 */
export async function setStatusBulk(dateIsoList, status, notes = '', bookedBy = '') {
  if (!dateIsoList.length) return [];
  assertEditable(status);
  assertBookedByPresent(status, bookedBy);

  if (status === 'available') {
    const { error } = await supabaseClient.from(TABLE).delete().in('date', dateIsoList);
    if (error) throw friendlyDbError(error, 'Could not update availability for the selected dates.');
    return dateIsoList.map(availableFallback);
  }

  const rows = dateIsoList.map((date) => ({
    date,
    status,
    notes: notes?.trim() || null,
    booked_by: status === 'booked' ? bookedBy?.trim() || null : null
  }));
  const { data, error } = await supabaseClient.from(TABLE).upsert(rows, { onConflict: 'date' }).select();

  if (error) throw friendlyDbError(error, 'Could not update availability for the selected dates.');
  return (data || []).map(fromRow);
}

/**
 * Reverts a date back to the table's implicit sparse default by deleting its
 * row outright — used to undo an explicit status (e.g. Booked) set on a
 * passed date, since 'passed' can never be written directly (the check
 * constraint only allows the four staff-settable statuses). A no-op if the
 * date has no stored row to begin with.
 */
export async function clearStatus(dateISO) {
  const { error } = await supabaseClient.from(TABLE).delete().eq('date', dateISO);
  if (error) throw friendlyDbError(error, 'Could not revert this date.');
}
