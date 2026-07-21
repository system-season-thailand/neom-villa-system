import { supabaseClient } from '../config/supabase.js';
import { friendlyDbError } from '../utils/dbErrors.js';
import { findRatesForRange } from './priceService.js';
import { addDays, daysBetween } from '../utils/dateUtils.js';

const TABLE = 'neom_pdf';

function fromRow(row) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    revisionNumber: row.revision_number,
    invoiceData: row.invoice_data,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Read-only preview of what the next invoice number *would* be — it does
 * not consume it. The real number is only minted at the moment an invoice
 * is actually first saved (see `saveInvoiceRevision` and
 * `insert_invoice_revision()` in SQL), so refreshing the page or importing
 * an old invoice to look at it can never burn a number that's never used.
 */
export async function peekNextInvoiceNumber() {
  const { data, error } = await supabaseClient.rpc('peek_next_invoice_number');
  if (error) throw friendlyDbError(error, 'Could not preview the next invoice number.');
  return data;
}

/**
 * Splits a stay into one row per pricing period, in chronological order.
 * Throws if any night in the stay has no matching pricing rule — invoice
 * totals must never silently default to zero or guess a rate.
 */
export async function calculateStayPricing(checkInISO, checkOutISO) {
  const totalNights = daysBetween(checkInISO, checkOutISO);
  if (totalNights <= 0) return { rows: [], total: 0, missingDates: [] };

  const rates = await findRatesForRange(checkInISO, checkOutISO);

  const nightRates = [];
  const missingDates = [];
  for (let i = 0; i < totalNights; i++) {
    const nightDate = addDays(checkInISO, i);
    const rule = rates.find((r) => r.startDate <= nightDate && nightDate <= r.endDate);
    if (!rule) {
      missingDates.push(nightDate);
      nightRates.push(null);
    } else {
      nightRates.push(rule);
    }
  }

  if (missingDates.length) {
    return { rows: [], total: 0, missingDates };
  }

  const rows = [];
  let segmentStart = 0;
  for (let i = 1; i <= nightRates.length; i++) {
    const sameAsPrev = i < nightRates.length && nightRates[i].id === nightRates[segmentStart].id;
    if (!sameAsPrev) {
      const rule = nightRates[segmentStart];
      const nights = i - segmentStart;
      rows.push({
        startDate: addDays(checkInISO, segmentStart),
        endDate: addDays(checkInISO, i - 1),
        nights,
        pricePerNight: rule.pricePerNight,
        seasonNote: rule.seasonNote,
        subtotal: nights * rule.pricePerNight
      });
      segmentStart = i;
    }
  }

  const total = rows.reduce((sum, r) => sum + r.subtotal, 0);
  return { rows, total, missingDates: [] };
}

/** Every saved revision for a given invoice number, newest first. */
export async function listRevisions(invoiceNumber) {
  const { data, error } = await supabaseClient
    .from(TABLE)
    .select('*')
    .eq('invoice_number', invoiceNumber)
    .order('revision_number', { ascending: false });
  if (error) throw friendlyDbError(error, 'Could not load invoice revisions.');
  return (data || []).map(fromRow);
}

export async function getRevisionById(id) {
  const { data, error } = await supabaseClient.from(TABLE).select('*').eq('id', id).single();
  if (error) throw friendlyDbError(error, 'Could not load that invoice revision.');
  return fromRow(data);
}

/**
 * Groups every saved invoice by invoice number for the "Import Invoice"
 * browser, newest invoice first, each with its full revision history and
 * revision count already attached so the UI can render without extra calls.
 */
export async function listInvoiceGroups({ search = '' } = {}) {
  let query = supabaseClient.from(TABLE).select('*').order('created_at', { ascending: false });

  const term = search.trim();
  if (term) {
    query = query.or(`invoice_number.ilike.%${term}%,invoice_data->>guestName.ilike.%${term}%`);
  }

  const { data, error } = await query;
  if (error) throw friendlyDbError(error, 'Could not load saved invoices.');

  const groups = new Map();
  for (const row of (data || []).map(fromRow)) {
    if (!groups.has(row.invoiceNumber)) groups.set(row.invoiceNumber, []);
    groups.get(row.invoiceNumber).push(row);
  }

  return Array.from(groups.entries())
    .map(([invoiceNumber, revisions]) => {
      revisions.sort((a, b) => b.revisionNumber - a.revisionNumber);
      return { invoiceNumber, revisions, latest: revisions[0] };
    })
    .sort((a, b) => (a.latest.createdAt < b.latest.createdAt ? 1 : -1));
}

/**
 * Atomically records a new, immutable invoice revision. No PDF file is
 * uploaded anywhere — `invoiceData` is a full snapshot of everything needed
 * to regenerate the exact same PDF later (see `pdfGenerator.js` /
 * `regenerateRevisionPdf` in invoiceTab.js), so there is nothing to store
 * beyond the structured data itself.
 *
 * Pass `invoiceNumber: null` for a brand-new invoice that's never been
 * saved before — the SQL function mints the real number itself as part of
 * this same insert (see `insert_invoice_revision()`), so the returned row's
 * `invoiceNumber` is the one to start using, not whatever preview was shown
 * beforehand.
 */
export async function saveInvoiceRevision({ invoiceNumber, invoiceData }) {
  const { data, error } = await supabaseClient
    .rpc('insert_invoice_revision', {
      p_invoice_number: invoiceNumber,
      p_invoice_data: invoiceData
    })
    .single();

  if (error) throw friendlyDbError(error, 'Could not save the invoice revision.');
  return fromRow(data);
}
