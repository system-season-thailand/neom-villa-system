import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';

const TABLE = 'neom_linked_stays';

function fromRow(row) {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** All linked-stay groups, oldest first. There's no per-tab search/sort UI for
 * these (unlike neom_price) — the list is small and only ever browsed via the
 * calendar itself, so a plain full list is enough. */
export async function listLinkedStays() {
  const { data, error } = await supabaseClient.from(TABLE).select('*').order('start_date', { ascending: true });
  if (error) throw friendlyDbError(error, 'Could not load linked-stay groups.');
  return (data || []).map(fromRow);
}

/** Every linked-stay group whose range overlaps [startISO, endISO], both inclusive — for rendering one visible calendar month. */
export async function findLinkedStaysForRange(startISO, endISO) {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .select('*')
    .lte('start_date', endISO)
    .gte('end_date', startISO);
  if (error) throw friendlyDbError(error, 'Could not load linked-stay groups.');
  return (data || []).map(fromRow);
}

export async function createLinkedStay({ startDate, endDate, note }) {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .insert({ start_date: startDate, end_date: endDate, note: note?.trim() || null })
    .select()
    .single();
  if (error) throw friendlyDbError(error, 'Could not link these dates.');
  return fromRow(data);
}

export async function deleteLinkedStay(id) {
  const { error } = await supabaseClient.from(TABLE).delete().eq('id', id);
  if (error) throw friendlyDbError(error, 'Could not unlink these dates.');
}
