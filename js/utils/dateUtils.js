// All dates in this app are plain ISO strings ("YYYY-MM-DD") end to end —
// from Supabase's `date` columns, through form inputs, to the PDF. Using a
// single string representation avoids timezone drift that would otherwise
// creep in from JS Date objects when the browser and Supabase disagree on
// local time.

const MONTHS_SHORT = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
];

export function todayISO() {
  return toISO(new Date());
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, days) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function daysBetween(startISO, endISO) {
  const a = parseISO(startISO);
  const b = parseISO(endISO);
  return Math.round((b - a) / 86400000);
}

export function isPast(iso) {
  return iso < todayISO();
}

/** "4 AUG 2026" — matches the villa's existing invoice date convention. */
export function formatDisplayDate(iso) {
  if (!iso) return '—';
  const d = parseISO(iso);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDateTime(isoTimestamp) {
  if (!isoTimestamp) return '—';
  const d = new Date(isoTimestamp);
  const date = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

/** Monday-first 6x7 week matrix for a given year/month (month is 0-indexed), including leading/trailing days from adjacent months marked as `inCurrentMonth: false`. */
export function buildMonthMatrix(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // convert Sun=0 -> Mon=0 start
  const gridStart = new Date(year, month, 1 - startOffset);

  const weeks = [];
  let cursor = new Date(gridStart);
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      week.push({
        iso: toISO(cursor),
        day: cursor.getDate(),
        inCurrentMonth: cursor.getMonth() === month
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export function monthLabel(year, month) {
  return new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
