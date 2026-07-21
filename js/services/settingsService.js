import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';

const TABLE = 'neom_system_settings';
const GUEST_BY_KEY = 'guest_by';

/** The staff-editable "Guest By" list, in display order. */
export async function listGuestByOptions() {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .select('setting_value')
    .eq('setting_key', GUEST_BY_KEY)
    .order('sort_order', { ascending: true })
    .order('setting_value', { ascending: true });
  if (error) throw friendlyDbError(error, 'Could not load the Guest By list.');
  return (data || []).map((row) => row.setting_value);
}

/** Adds a new option to the end of the "Guest By" list. */
export async function addGuestByOption(value) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Enter a name first.');

  const { data, error } = await supabaseClient
    .from(TABLE)
    .insert({ setting_key: GUEST_BY_KEY, setting_value: trimmed, sort_order: 999 })
    .select('setting_value')
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`"${trimmed}" is already in the list.`);
    throw friendlyDbError(error, 'Could not add this Guest By option.');
  }
  return data.setting_value;
}
