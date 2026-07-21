// Indonesian Rupiah formatting: period as the thousands separator, no
// decimals — matching both local convention and the villa's existing
// invoices (e.g. "IDR 15.000.000").
const IDR_FORMATTER = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

export function formatIDR(amount) {
  const n = Number(amount) || 0;
  return `IDR ${IDR_FORMATTER.format(n)}`;
}

export function formatNumber(amount) {
  return IDR_FORMATTER.format(Number(amount) || 0);
}

/** Compact form for tight spaces (calendar cells) — "IDR 2.000.000" becomes
 * "2 JT" ("juta", Indonesian for million), "IDR 3.500.000" becomes
 * "3.5 JT", etc. Rounds to 2 decimal places and drops trailing zeros. No
 * "IDR" prefix — the calendar cell doesn't have room for it. */
export function formatIDRShort(amount) {
  const millions = parseFloat(((Number(amount) || 0) / 1_000_000).toFixed(2));
  return `${millions} JT`;
}

export function nightsLabel(n) {
  return `${n} ${n === 1 ? 'Night' : 'Nights'}`;
}
