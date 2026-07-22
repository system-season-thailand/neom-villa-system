import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';

const TABLE = 'neom_system_settings';

// The two staff-editable lists currently backed by this table — see
// js/components/optionSelect.js, which drives both the Invoice tab's Guest
// By field and the Availability tab's Booked By field from the same generic
// CRUD below, just pointed at a different key.
export const GUEST_BY_KEY = 'guest_by';
export const BOOKED_BY_KEY = 'booked_by';

function fromRow(row) {
  return { id: row.id, value: row.setting_value };
}

/** A staff-editable option list (by key), in display order. */
export async function listOptions(key) {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .select('id, setting_value')
    .eq('setting_key', key)
    .order('sort_order', { ascending: true })
    .order('setting_value', { ascending: true });
  if (error) throw friendlyDbError(error, 'Could not load this list.');
  return (data || []).map(fromRow);
}

/** Adds a new option to the end of the list for `key`. */
export async function addOption(key, value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a name first.');

  const { data, error } = await supabaseClient
    .from(TABLE)
    .insert({ setting_key: key, setting_value: trimmed, sort_order: 999 })
    .select('id, setting_value')
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`"${trimmed}" is already in the list.`);
    throw friendlyDbError(error, 'Could not add this option.');
  }
  return fromRow(data);
}

/** Renames an existing option. Free text, not a foreign key, so dates/invoices already using the old value are unaffected — see sql/006_add_booked_by.sql. */
export async function updateOption(id, value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a name first.');

  const { data, error } = await supabaseClient
    .from(TABLE)
    .update({ setting_value: trimmed })
    .eq('id', id)
    .select('id, setting_value')
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`"${trimmed}" is already in the list.`);
    throw friendlyDbError(error, 'Could not update this option.');
  }
  return fromRow(data);
}

export async function deleteOption(id) {
  const { error } = await supabaseClient.from(TABLE).delete().eq('id', id);
  if (error) throw friendlyDbError(error, 'Could not delete this option.');
}
