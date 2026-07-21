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

export function nightsLabel(n) {
  return `${n} ${n === 1 ? 'Night' : 'Nights'}`;
}
