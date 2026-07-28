import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';
import { addDays } from '../utils/dateUtils.js';

const TABLE = 'neom_price';

function toRow(price) {
  return {
    start_date: price.startDate,
    end_date: price.endDate,
    price_per_night: price.pricePerNight,
    season_note: price.seasonNote?.trim() || null
  };
}

function fromRow(row) {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    pricePerNight: Number(row.price_per_night),
    seasonNote: row.season_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * List all pricing rules, optionally filtered by a free-text search across
 * the season note, and sorted by any column.
 */
export async function listPrices({ search = '', sortBy = 'start_date', sortDir = 'asc' } = {}) {
  let query = supabaseClient.from(TABLE).select('*');

  if (search.trim()) {
    query = query.ilike('season_note', `%${search.trim()}%`);
  }

  query = query.order(sortBy, { ascending: sortDir === 'asc' });

  const { data, error } = await query;
  if (error) throw friendlyDbError(error, 'Could not load pricing rules.');
  return (data || []).map(fromRow);
}

/**
 * Fetch every pricing rule whose date range overlaps [startDate, endDateExclusive).
 * endDateExclusive is the checkout date (not itself a booked night).
 */
export async function findRatesForRange(startDate, endDateExclusive) {
  const lastNight = addDays(endDateExclusive, -1);
  const { data, error } = await supabaseClient
    .from(TABLE)
    .select('*')
    .lte('start_date', lastNight)
    .gte('end_date', startDate)
    .order('start_date', { ascending: true });

  if (error) throw friendlyDbError(error, 'Could not load pricing rules for this stay.');
  return (data || []).map(fromRow);
}

export async function createPrice(price) {
  const { data, error } = await supabaseClient.from(TABLE).insert(toRow(price)).select().single();
  if (error) throw friendlyDbError(error, 'Could not create the pricing rule.');
  return fromRow(data);
}

export async function updatePrice(id, price) {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .update(toRow(price))
    .eq('id', id)
    .select()
    .single();
  if (error) throw friendlyDbError(error, 'Could not update the pricing rule.');
  return fromRow(data);
}

export async function deletePrice(id) {
  const { error } = await supabaseClient.from(TABLE).delete().eq('id', id);
  if (error) throw friendlyDbError(error, 'Could not delete the pricing rule.');
}
