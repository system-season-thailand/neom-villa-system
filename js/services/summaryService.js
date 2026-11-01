import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';
import { addDays } from '../utils/dateUtils.js';

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
  const stays = invoiceErr ? [] : await buildStays(invoiceRows || []);

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

  // Every booked night keyed by its own date, for buildTimeline() below —
  // the per-booker aggregation above collapses dates away, but the report
  // needs to walk the period night by night.
  const nightsByDate = new Map();

  for (const row of bookedRows || []) {
    const bookedBy = (row.booked_by || '').trim();
    const rate = rateForDate(row.date);
    const revenue = rate ?? 0;
    if (rate == null) {
      missingPriceNights += 1;
      missingPriceDates.push(row.date);
    }

    const stay = findStayForNight(stays, row.date, bookedBy);
    nightsByDate.set(row.date, { bookedBy, stay });

    const bookerEntry = byBookerMap.get(bookedBy) || { bookedBy, nights: 0, revenue: 0, guestMap: new Map() };
    bookerEntry.nights += 1;
    bookerEntry.revenue += revenue;
    accumulateGuestNight(bookerEntry.guestMap, stay, revenue);
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

  const timeline = buildTimeline(startISO, endISO, nightsByDate);
  const emptyNights = timeline.reduce((sum, r) => sum + (r.kind === 'empty' ? r.nights : 0), 0);

  // What the unbooked nights would have been worth at their own nightly
  // rates — revenue *not* earned, never to be added to totalRevenue. An
  // unbooked night with no pricing rule can't be valued at all, so it
  // contributes nothing and is counted separately, the same way an unpriced
  // booked night is: better to under-report and say so than to guess a rate.
  let emptyNightsValue = 0;
  let emptyMissingPriceNights = 0;
  for (const row of timeline) {
    if (row.kind !== 'empty') continue;
    for (let date = row.start; date < row.end; date = addDays(date, 1)) {
      const rate = rateForDate(date);
      if (rate == null) emptyMissingPriceNights += 1;
      else emptyNightsValue += rate;
    }
  }

  const totalCommission = totalRevenue * BOOKER_COMMISSION_RATE;
  const totalAreaGuard = totalRevenue * AREA_GUARD_RATE;
  const totalVillaGuard = totalNights * VILLA_GUARD_PER_NIGHT;

  return {
    byBooker,
    byMonth,
    timeline,
    emptyNights,
    emptyNightsValue,
    emptyMissingPriceNights,
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
 * Walks the selected period night by night and turns it into one flat,
 * chronological list in which **every date belongs to exactly one row** —
 * the shape the report PDF prints.
 *
 * Three kinds of row come out of it:
 *
 * - `stay` — consecutive booked nights covered by the same invoice. The
 *   dates reported are the *invoice's* own check-in/check-out, not the run's
 *   bounds, so a stay running past either end of the period is still shown
 *   as the guest was actually billed for it. Emitted once per invoice even
 *   in the unlikely case its nights aren't contiguous.
 * - `unattributed` — consecutive booked nights by the same booker that no
 *   invoice covers. These are genuinely booked, so they must not be reported
 *   as empty; they simply have no guest, dates or payment of their own, so
 *   the run's own bounds stand in.
 * - `empty` — consecutive nights with no booking at all.
 *
 * Run bounds use the same checkout-exclusive convention as a stay: `end` is
 * the morning after the last night in the run. That's what makes the rows
 * tile — one row's `end` is the next row's `start` — so a reader can follow
 * the period straight down the table without arithmetic. (It also means a
 * run ending on the last night of the period reports an `end` one day into
 * the next month, which is correct: that's the morning the villa is free.)
 */
function buildTimeline(startISO, endISO, nightsByDate) {
  const rows = [];
  const seenInvoices = new Set();

  // What makes two adjacent nights part of the same run: the same invoice,
  // or the same booker with no invoice, or both being empty.
  const runKey = (dateISO) => {
    const night = nightsByDate.get(dateISO);
    if (!night) return 'empty';
    return night.stay ? `invoice:${night.stay.invoiceNumber}` : `booker:${night.bookedBy}`;
  };

  let cursor = startISO;
  while (cursor <= endISO) {
    const key = runKey(cursor);
    const runStart = cursor;
    let nights = 0;
    while (cursor <= endISO && runKey(cursor) === key) {
      nights += 1;
      cursor = addDays(cursor, 1);
    }
    const runEnd = cursor; // the morning after the run's last night

    if (key === 'empty') {
      rows.push({ kind: 'empty', start: runStart, end: runEnd, nights, sortDate: runStart });
      continue;
    }

    const night = nightsByDate.get(runStart);
    if (!night.stay) {
      rows.push({
        kind: 'unattributed',
        bookedBy: night.bookedBy,
        start: runStart,
        end: runEnd,
        nights,
        sortDate: runStart
      });
      continue;
    }

    if (seenInvoices.has(night.stay.invoiceNumber)) continue;
    seenInvoices.add(night.stay.invoiceNumber);
    rows.push({
      kind: 'stay',
      bookedBy: night.bookedBy,
      guestName: night.stay.guestName,
      invoiceNumber: night.stay.invoiceNumber,
      start: night.stay.checkIn,
      end: night.stay.checkOut,
      nights: night.stay.stayNights ?? nights,
      totalPayment: night.stay.totalPayment,
      confirmedAt: night.stay.confirmedAt,
      sortDate: night.stay.checkIn
    });
  }

  // Walking the period already produces near-order; this only matters for a
  // stay whose invoiced check-in precedes the period (and so precedes the
  // run that surfaced it).
  return rows.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
}

/**
 * Collapses raw neom_pdf rows into one stay per invoice number, carrying
 * everything the report prints about a guest.
 *
 * Two different revisions matter here, for two different reasons:
 *
 * - **The latest** supplies the guest name, dates, nights and total, since
 *   that's the version whose figures currently stand (earlier ones may have
 *   been corrected).
 * - **The first** supplies `confirmedAt` — the booking was confirmed when it
 *   was first invoiced, not when someone later fixed a typo in it.
 *
 * Revision 1 is fetched separately rather than picked out of `rows`, because
 * `rows` is filtered by the stay dates of each revision: if a correction
 * moved a stay into this range from outside it, revision 1 wouldn't be in
 * `rows` at all. If that lookup fails or finds nothing, this falls back to
 * the earliest revision that *was* fetched.
 */
async function buildStays(rows) {
  const latestByNumber = new Map();
  const earliestByNumber = new Map();
  for (const row of rows) {
    const latest = latestByNumber.get(row.invoice_number);
    if (!latest || row.revision_number > latest.revision_number) {
      latestByNumber.set(row.invoice_number, row);
    }
    const earliest = earliestByNumber.get(row.invoice_number);
    if (!earliest || row.revision_number < earliest.revision_number) {
      earliestByNumber.set(row.invoice_number, row);
    }
  }

  const firstRevisionDates = await fetchFirstRevisionDates(Array.from(latestByNumber.keys()));

  return Array.from(latestByNumber.values())
    .map((row) => {
      const d = row.invoice_data || {};
      return {
        invoiceNumber: row.invoice_number,
        guestName: (d.guestName || '').trim(),
        guestBy: (d.guestBy || '').trim(),
        checkIn: d.checkInDate || '',
        checkOut: d.checkOutDate || '',
        stayNights: Number(d.nights) || null,
        totalPayment: Number(d.total) || 0,
        createdAt: row.created_at || '',
        confirmedAt:
          firstRevisionDates.get(row.invoice_number) ||
          earliestByNumber.get(row.invoice_number)?.created_at ||
          null
      };
    })
    .filter((stay) => stay.checkIn && stay.checkOut && stay.guestName);
}

/** When each of these invoices was first raised. Non-fatal on failure — the
 * caller falls back to the earliest revision it already has. */
async function fetchFirstRevisionDates(invoiceNumbers) {
  if (!invoiceNumbers.length) return new Map();
  const { data, error } = await supabaseClient
    .from(INVOICE_TABLE)
    .select('invoice_number, created_at')
    .eq('revision_number', 1)
    .in('invoice_number', invoiceNumbers);
  if (error) return new Map();
  return new Map((data || []).map((r) => [r.invoice_number, r.created_at]));
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

/**
 * Adds one booked night onto its stay's running entry, keyed by invoice
 * number rather than guest name: a row now carries one stay's own check-in,
 * check-out and total, so a guest who stayed twice in the range has to read
 * as two rows — merging them would leave one date pair standing for two
 * different stays.
 *
 * Each entry ends up carrying two different night counts, deliberately:
 * `nights` is how many booked calendar nights inside the selected range were
 * attributed here (what the Summary tab's revenue and commission are
 * computed from), while `stayNights` is the invoice's own figure for the
 * whole stay — which is what belongs next to a check-in and check-out date,
 * even when part of that stay falls outside the range being reported on.
 */
function accumulateGuestNight(guestMap, stay, revenue) {
  const key = stay ? stay.invoiceNumber : UNATTRIBUTED_GUEST;
  let entry = guestMap.get(key);
  if (!entry) {
    entry = {
      guestName: stay ? stay.guestName : UNATTRIBUTED_GUEST,
      invoiceNumber: stay ? stay.invoiceNumber : null,
      checkIn: stay ? stay.checkIn : null,
      checkOut: stay ? stay.checkOut : null,
      stayNights: stay ? stay.stayNights : null,
      totalPayment: stay ? stay.totalPayment : null,
      confirmedAt: stay ? stay.confirmedAt : null,
      nights: 0,
      revenue: 0
    };
    guestMap.set(key, entry);
  }
  entry.nights += 1;
  entry.revenue += revenue;
}

/** Chronological by check-in — a report of who stayed when reads in date
 * order — with the unattributed bucket pinned last, since it's a data gap to
 * follow up on rather than a stay with a place in the sequence. */
function finalizeGuests(guestMap) {
  return Array.from(guestMap.values())
    .map((g) => ({ ...g, commission: g.revenue * BOOKER_COMMISSION_RATE }))
    .sort((a, b) => {
      if (a.guestName === UNATTRIBUTED_GUEST) return 1;
      if (b.guestName === UNATTRIBUTED_GUEST) return -1;
      return a.checkIn.localeCompare(b.checkIn);
    });
}
