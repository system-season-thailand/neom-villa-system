import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';
import { todayISO } from '../utils/dateUtils.js';

const TABLE = 'neom_availability';

export const STATUSES = {
  available: { label: 'Available', color: '#1a7f5a' },
  booked: { label: 'Booked', color: '#c1402c' },
  on_hold: { label: 'On Hold', color: '#7c5cbf' },
  blocked: { label: 'Blocked', color: '#454b56' },
  passed: { label: 'Passed', color: '#aeb2ba' }
};

function fromRow(row) {
  return {
    date: row.date,
    status: row.status,
    statusColor: row.status_color,
    notes: row.notes || ''
  };
}

/**
 * Returns a Map<dateISO, {date,status,statusColor,notes}> covering every day
 * in [startISO, endISO] inclusive. Dates without a stored row are filled in
 * with the implicit default: "passed" if the date is before today, otherwise
 * "available". This keeps the table sparse — staff only ever write a row
 * when a date actually changes state.
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
  let cursor = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    const stored = byDate.get(iso);
    if (stored) {
      result.set(iso, iso < today ? { ...stored, status: 'passed', statusColor: STATUSES.passed.color } : stored);
    } else {
      const isPassed = iso < today;
      result.set(iso, {
        date: iso,
        status: isPassed ? 'passed' : 'available',
        statusColor: isPassed ? STATUSES.passed.color : STATUSES.available.color,
        notes: ''
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

const EDITABLE_STATUSES = ['available', 'booked', 'on_hold', 'blocked'];

function assertEditable(dateISO, status) {
  if (dateISO < todayISO()) {
    throw new Error('Past dates are automatically marked as Passed and cannot be edited.');
  }
  if (!EDITABLE_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
}

/**
 * Sets the status for a single future/today date. Past dates cannot be
 * edited — the UI never offers this action, and we guard it here too.
 */
export async function setStatus(dateISO, status, notes = '') {
  assertEditable(dateISO, status);

  const { data, error } = await supabaseClient
    .from(TABLE)
    .upsert({ date: dateISO, status, notes: notes?.trim() || null }, { onConflict: 'date' })
    .select()
    .single();

  if (error) throw friendlyDbError(error, 'Could not update availability for this date.');
  return fromRow(data);
}

/**
 * Applies one status to many dates at once — the "Select multiple" bulk
 * action in the Availability tab. A single multi-row upsert, so it's one
 * request and one all-or-nothing statement rather than N round trips.
 */
export async function setStatusBulk(dateIsoList, status, notes = '') {
  if (!dateIsoList.length) return [];
  dateIsoList.forEach((dateISO) => assertEditable(dateISO, status));

  const rows = dateIsoList.map((date) => ({ date, status, notes: notes?.trim() || null }));
  const { data, error } = await supabaseClient.from(TABLE).upsert(rows, { onConflict: 'date' }).select();

  if (error) throw friendlyDbError(error, 'Could not update availability for the selected dates.');
  return (data || []).map(fromRow);
}
