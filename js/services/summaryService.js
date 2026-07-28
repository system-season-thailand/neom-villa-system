import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';

const AVAILABILITY_TABLE = 'neom_availability';
const PRICE_TABLE = 'neom_price';

// Cut of each booked night's price — 9% to whoever booked it, 1% to the
// villa guard (a flat share of every booking, not tied to any one booker).
export const BOOKER_COMMISSION_RATE = 0.09;
export const GUARD_COMMISSION_RATE = 0.01;

/**
 * Aggregates booked nights and revenue between startISO/endISO (inclusive),
 * grouped by booker and by calendar month — the data behind the ملخص
 * (Summary) tab. Revenue for a given night comes from whichever neom_price
 * rule covers that date; a booked night with no matching rule still counts
 * toward nights (both per-booker and per-month) but contributes 0 revenue,
 * and is counted in `missingPriceNights` so the UI can flag it rather than
 * silently understating revenue. Every booked row is required (at the point
 * it's saved — see availabilityService.js's assertBookedByPresent) to carry
 * a real `booked_by`, so there's no "Unspecified" fallback bucket here.
 * Each booker's `commission`/`guardCut` are
 * just BOOKER_COMMISSION_RATE/GUARD_COMMISSION_RATE of *their own* revenue —
 * the guard's cut is a per-booking share, not one lump sum, so it still adds
 * up correctly to `totalGuardCut` across bookers. `missingPriceDates` carries
 * the actual dates behind `missingPriceNights` so the UI can name them
 * directly instead of just flagging a count — see summaryTab.js.
 */
export async function getBookingSummary(startISO, endISO) {
  const [{ data: bookedRows, error: bookedErr }, { data: priceRows, error: priceErr }] = await Promise.all([
    supabaseClient
      .from(AVAILABILITY_TABLE)
      .select('date, booked_by')
      .eq('status', 'booked')
      .gte('date', startISO)
      .lte('date', endISO)
      .order('date', { ascending: true }),
    supabaseClient
      .from(PRICE_TABLE)
      .select('start_date, end_date, price_per_night')
      .lte('start_date', endISO)
      .gte('end_date', startISO)
  ]);

  if (bookedErr) throw friendlyDbError(bookedErr, 'Could not load booked dates.');
  if (priceErr) throw friendlyDbError(priceErr, 'Could not load pricing rules.');

  const priceRules = (priceRows || []).map((r) => ({
    startDate: r.start_date,
    endDate: r.end_date,
    pricePerNight: Number(r.price_per_night)
  }));

  // Pricing ranges never overlap (enforced in Postgres), so at most one rule
  // can match any given date.
  function rateForDate(dateISO) {
    const rule = priceRules.find((p) => p.startDate <= dateISO && dateISO <= p.endDate);
    return rule ? rule.pricePerNight : null;
  }

  const byBookerMap = new Map();
  const byMonthMap = new Map();
  let totalNights = 0;
  let totalRevenue = 0;
  let missingPriceNights = 0;
  const missingPriceDates = [];

  for (const row of bookedRows || []) {
    const bookedBy = (row.booked_by || '').trim();
    const rate = rateForDate(row.date);
    const revenue = rate ?? 0;
    if (rate == null) {
      missingPriceNights += 1;
      missingPriceDates.push(row.date);
    }

    const bookerEntry = byBookerMap.get(bookedBy) || { bookedBy, nights: 0, revenue: 0 };
    bookerEntry.nights += 1;
    bookerEntry.revenue += revenue;
    byBookerMap.set(bookedBy, bookerEntry);

    const monthKey = row.date.slice(0, 7); // 'YYYY-MM'
    const monthEntry = byMonthMap.get(monthKey) || { month: monthKey, nights: 0, revenue: 0 };
    monthEntry.nights += 1;
    monthEntry.revenue += revenue;
    byMonthMap.set(monthKey, monthEntry);

    totalNights += 1;
    totalRevenue += revenue;
  }

  const byBooker = Array.from(byBookerMap.values())
    .map((b) => ({
      ...b,
      commission: b.revenue * BOOKER_COMMISSION_RATE,
      guardCut: b.revenue * GUARD_COMMISSION_RATE
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    byBooker,
    byMonth: Array.from(byMonthMap.values()).sort((a, b) => a.month.localeCompare(b.month)),
    totalNights,
    totalRevenue,
    totalCommission: totalRevenue * BOOKER_COMMISSION_RATE,
    totalGuardCut: totalRevenue * GUARD_COMMISSION_RATE,
    missingPriceNights,
    missingPriceDates
  };
}
