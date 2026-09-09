import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';

const AVAILABILITY_TABLE = 'neom_availability';
const PRICE_TABLE = 'neom_price';
const INVOICE_TABLE = 'neom_pdf';

// Cuts taken out of each booked night. The first two are percentages of that
// night's own rate; the third is a flat per-night amount that doesn't scale
// with the rate at all.
export const BOOKER_COMMISSION_RATE = 0.09;
// The area guard's share — a flat percentage of every booking, not tied to
// any one booker. (Named GUARD_COMMISSION_RATE before the villa guard below
// existed and the two needed telling apart.)
export const AREA_GUARD_RATE = 0.01;
// The villa guard is paid a flat 50,000 IDR per booked night regardless of
// what that night sold for. Deliberately NOT part of any per-booker
// percentage: it never reduces a booker's revenue, commission, or the area
// guard's 1% — it's only deducted once, at the month level, to arrive at
// net revenue (see byMonth's `netRevenue` below).
export const VILLA_GUARD_PER_NIGHT = 50000;

/** The bucket a booked night falls into when no saved invoice covers it — see attributeGuests(). */
export const UNATTRIBUTED_GUEST = null;

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
 *
 * Money, per booker: `commission` and `areaGuard` are
 * BOOKER_COMMISSION_RATE/AREA_GUARD_RATE of *their own* revenue, and
 * `villaGuard` is VILLA_GUARD_PER_NIGHT times their own booked nights. Since
 * the first two are flat percentages of revenue and the third is a flat
 * per-night amount, summing any of them across bookers is equivalent to
 * computing it once off the totals — which is exactly what the byMonth rows
 * and the `total*` fields below do.
 *
 * Money, per month: `revenue` is gross (every booked night's own rate, the
 * same figure the per-booker rows sum to), and `netRevenue` is what's
 * actually left after all three cuts — gross minus the 9%, minus the 1%,
 * minus 50,000 per night. The villa guard is subtracted here and nowhere
 * else, so it never double-counts.
 *
 * `byBooker[].guests` breaks each booker's nights down by the guest who
 * actually stayed them — see attributeGuests() for how a night is matched to
 * a saved invoice, and why some nights legitimately end up unattributed.
 */
export async function getBookingSummary(startISO, endISO) {
  const [
    { data: bookedRows, error: bookedErr },
    { data: priceRows, error: priceErr },
    { data: invoiceRows, error: invoiceErr }
  ] = await Promise.all([
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
      .gte('end_date', startISO),
    // Every saved invoice whose stay overlaps this range, for the per-guest
    // breakdown. A stay runs checkInDate .. checkOutDate exclusive (the
    // checkout day isn't a night), hence `gt` rather than `gte` on the far
    // end. Both are ISO 'YYYY-MM-DD' strings inside jsonb, so plain text
    // comparison is chronologically correct.
    supabaseClient
      .from(INVOICE_TABLE)
      .select('invoice_number, revision_number, created_at, invoice_data')
      .lte('invoice_data->>checkInDate', endISO)
      .gt('invoice_data->>checkOutDate', startISO)
  ]);

  if (bookedErr) throw friendlyDbError(bookedErr, 'Could not load booked dates.');
  if (priceErr) throw friendlyDbError(priceErr, 'Could not load pricing rules.');
  // Deliberately not fatal: the per-guest breakdown is an enrichment on top
  // of the numbers, so if invoices can't be read the tab still reports every
  // night, revenue and commission figure correctly — each booker's "More
  // Details" just has nothing to show.
  const stays = invoiceErr ? [] : latestRevisionStays(invoiceRows || []);

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

    const bookerEntry = byBookerMap.get(bookedBy) || { bookedBy, nights: 0, revenue: 0, guestMap: new Map() };
    bookerEntry.nights += 1;
    bookerEntry.revenue += revenue;
    accumulateGuestNight(bookerEntry.guestMap, findStayForNight(stays, row.date, bookedBy), revenue);
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
    .map(({ guestMap, ...b }) => ({
      ...b,
      commission: b.revenue * BOOKER_COMMISSION_RATE,
      areaGuard: b.revenue * AREA_GUARD_RATE,
      villaGuard: b.nights * VILLA_GUARD_PER_NIGHT,
      guests: finalizeGuests(guestMap)
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const byMonth = Array.from(byMonthMap.values())
    .map((m) => {
      const commission = m.revenue * BOOKER_COMMISSION_RATE;
      const areaGuard = m.revenue * AREA_GUARD_RATE;
      const villaGuard = m.nights * VILLA_GUARD_PER_NIGHT;
      return {
        ...m,
        commission,
        areaGuard,
        villaGuard,
        netRevenue: m.revenue - commission - areaGuard - villaGuard
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));

  const totalCommission = totalRevenue * BOOKER_COMMISSION_RATE;
  const totalAreaGuard = totalRevenue * AREA_GUARD_RATE;
  const totalVillaGuard = totalNights * VILLA_GUARD_PER_NIGHT;

  return {
    byBooker,
    byMonth,
    totalNights,
    totalRevenue,
    totalCommission,
    totalAreaGuard,
    totalVillaGuard,
    totalNetRevenue: totalRevenue - totalCommission - totalAreaGuard - totalVillaGuard,
    missingPriceNights,
    missingPriceDates
  };
}

/**
 * Collapses raw neom_pdf rows to one stay per invoice number — the latest
 * revision, since that's the version whose dates and guest name currently
 * stand (earlier revisions may have been corrected). Rows with an incomplete
 * date pair are dropped: they can't cover a night either way.
 */
function latestRevisionStays(rows) {
  const latestByNumber = new Map();
  for (const row of rows) {
    const current = latestByNumber.get(row.invoice_number);
    if (!current || row.revision_number > current.revision_number) {
      latestByNumber.set(row.invoice_number, row);
    }
  }

  return Array.from(latestByNumber.values())
    .map((row) => ({
      invoiceNumber: row.invoice_number,
      guestName: (row.invoice_data?.guestName || '').trim(),
      guestBy: (row.invoice_data?.guestBy || '').trim(),
      checkIn: row.invoice_data?.checkInDate || '',
      checkOut: row.invoice_data?.checkOutDate || '',
      createdAt: row.created_at || ''
    }))
    .filter((stay) => stay.checkIn && stay.checkOut && stay.guestName);
}

/**
 * Which saved invoice a given booked night belongs to.
 *
 * Bookings and invoices are independent tables with no foreign key between
 * them (see DATABASE.md) — marking a date Booked doesn't create an invoice,
 * and creating an invoice doesn't mark dates Booked. So the link is the one
 * that genuinely exists in the data: a night belongs to the invoice whose
 * stay covers that date (check-in inclusive, check-out exclusive — the
 * checkout day isn't a night).
 *
 * Nothing stops two invoices covering the same night (a stay re-issued under
 * a new invoice number, say), so when several match: prefer one whose own
 * "Guest By" is the very staff member this night is credited to, then fall
 * back to the most recently created. A night no invoice covers returns null
 * and is reported honestly as unattributed rather than being guessed at.
 */
function findStayForNight(stays, dateISO, bookedBy) {
  const covering = stays.filter((s) => s.checkIn <= dateISO && dateISO < s.checkOut);
  if (!covering.length) return null;

  const sameBooker = bookedBy ? covering.filter((s) => s.guestBy && s.guestBy === bookedBy) : [];
  const pool = sameBooker.length ? sameBooker : covering;
  return pool.reduce((latest, s) => (s.createdAt > latest.createdAt ? s : latest));
}

/** Adds one night's nights/revenue onto its guest's running entry, keyed by
 * guest name so a guest who stayed twice in the range reads as one row (with
 * both invoice numbers listed) rather than two look-alike ones. */
function accumulateGuestNight(guestMap, stay, revenue) {
  const key = stay ? stay.guestName : UNATTRIBUTED_GUEST;
  const entry = guestMap.get(key) || { guestName: key, invoiceNumbers: [], nights: 0, revenue: 0 };
  entry.nights += 1;
  entry.revenue += revenue;
  if (stay && !entry.invoiceNumbers.includes(stay.invoiceNumber)) {
    entry.invoiceNumbers.push(stay.invoiceNumber);
  }
  guestMap.set(key, entry);
}

/** Highest-earning guest first, with the unattributed bucket (if any) pinned
 * last — it's a data gap to follow up on, not a result to rank. */
function finalizeGuests(guestMap) {
  return Array.from(guestMap.values())
    .map((g) => ({ ...g, commission: g.revenue * BOOKER_COMMISSION_RATE }))
    .sort((a, b) => {
      if (a.guestName === UNATTRIBUTED_GUEST) return 1;
      if (b.guestName === UNATTRIBUTED_GUEST) return -1;
      return b.revenue - a.revenue;
    });
}
