import * as summaryService from '../services/summaryService.js';
import { toast } from './toast.js';
import { createDatePicker } from './datePicker.js';
import { toISO, parseISO, monthLabel, formatDisplayDate } from '../utils/dateUtils.js';
import { formatIDR } from '../utils/format.js';
import { generateSummaryStatementPdf } from '../utils/statementGenerator.js';

const PRESETS = [
  { key: 'this_month', label: 'This Month' },
  { key: 'last_month', label: 'Last Month' },
  { key: 'this_year', label: 'This Year' },
  { key: 'all_time', label: 'All Time' }
];

let els = {};
let state = null;
let fromPicker = null;
let toPicker = null;

function monthRange(year, month) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0); // day 0 of next month = last day of this month
  return { from: toISO(start), to: toISO(end) };
}

function rangeForPreset(preset) {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case 'last_month':
      return monthRange(y, m - 1);
    case 'this_year':
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    // Simplest way to express "no real filter" without special-casing a
    // null range everywhere else — wide enough to cover any realistic date.
    case 'all_time':
      return { from: '2000-01-01', to: '2100-12-31' };
    case 'this_month':
    default:
      return monthRange(y, m);
  }
}

export function mount(container) {
  container.innerHTML = template();
  els = {
    root: container,
    monthLabel: container.querySelector('#summary-month-label'),
    monthPrev: container.querySelector('#summary-month-prev'),
    monthNext: container.querySelector('#summary-month-next'),
    fromSlot: container.querySelector('#summary-from-slot'),
    toSlot: container.querySelector('#summary-to-slot'),
    presetsRow: container.querySelector('#summary-presets'),
    refreshBtn: container.querySelector('#summary-refresh'),
    statementBtn: container.querySelector('#btn-download-statement'),
    totalNights: container.querySelector('#summary-total-nights'),
    totalRevenue: container.querySelector('#summary-total-revenue'),
    totalCommission: container.querySelector('#summary-total-commission'),
    guardCutNote: container.querySelector('#summary-guard-cut-note'),
    missingWarning: container.querySelector('#summary-missing-warning'),
    byBookerHost: container.querySelector('#summary-by-booker-host'),
    byMonthHost: container.querySelector('#summary-by-month-host')
  };

  const initial = rangeForPreset('this_month');
  state = {
    from: initial.from,
    to: initial.to,
    loading: true,
    data: null,
    // Which bookers currently have their guest breakdown open. Keyed by
    // booker name rather than row index so an expansion survives a reload
    // that reorders the table (rows are sorted by revenue).
    expandedBookers: new Set(),
    downloading: false
  };

  fromPicker = createDatePicker({
    value: state.from,
    onChange: (value) => {
      state.from = value;
      updateMonthLabel();
      // Debounced, not load() directly: picking a new From leaves To exactly
      // as it was (e.g. still Dec 31 from an old "This Year" view) for the
      // instant in between this pick and the one the admin is about to make
      // in the To field auto-opened right below — loading immediately here
      // would briefly (or, if missed, not-so-briefly) query that stale,
      // unintended From–To pairing and surface bookings from way outside the
      // range the admin actually meant to look at.
      scheduleLoad();
      // Faster UX for picking a custom range: go straight into the To
      // field's picker instead of making staff click it themselves.
      toPicker.open();
    }
  });
  els.fromSlot.appendChild(fromPicker.trigger);

  toPicker = createDatePicker({
    value: state.to,
    // Opens on From's month whenever To is still empty — same behavior as
    // the Prices tab's Start/End pickers.
    getReferenceValue: () => fromPicker.getValue(),
    onChange: (value) => {
      state.to = value;
      // Same reasoning as From's onChange above, symmetric for whichever
      // field the admin happens to touch first.
      scheduleLoad();
    }
  });
  els.toSlot.appendChild(toPicker.trigger);

  els.monthPrev.addEventListener('click', () => navigateMonth(-1));
  els.monthNext.addEventListener('click', () => navigateMonth(1));
  els.refreshBtn.addEventListener('click', () => load());
  els.statementBtn.addEventListener('click', handleDownloadStatement);

  els.presetsRow.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = PRESETS.find((p) => p.key === btn.dataset.preset);
      const { from, to } = rangeForPreset(preset.key);
      state.from = from;
      state.to = to;
      fromPicker.setValue(from);
      toPicker.setValue(to);
      updateMonthLabel();
      load();
    });
  });

  updateMonthLabel();
  load();
}

/** Jumps the month-switcher a month at a time — the fast path for browsing
 * month to month, vs. picking an arbitrary range by hand in the From/To
 * fields next to it. */
function navigateMonth(delta) {
  const d = parseISO(state.from);
  let year = d.getFullYear();
  let month = d.getMonth() + delta;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  const { from, to } = monthRange(year, month);
  state.from = from;
  state.to = to;
  fromPicker.setValue(from);
  toPicker.setValue(to);
  updateMonthLabel();
  load();
}

/** The month-switcher's label always tracks whatever "From" currently is —
 * exact for a clean single-month range, an approximate "where am I" anchor
 * otherwise (e.g. after "This Year"/"All Time" or a hand-picked range), with
 * the From/To fields right next to it for the exact boundaries either way. */
function updateMonthLabel() {
  const d = parseISO(state.from);
  els.monthLabel.textContent = monthLabel(d.getFullYear(), d.getMonth());
}

/** What to call the range currently on screen, for the statement PDF's
 * header — the preset's own name when the range is exactly one ("This
 * Month", "All Time"), the month's name for a clean single month, and
 * otherwise nothing to add beyond the exact from/to dates the PDF already
 * prints. */
function currentRangeLabel() {
  const preset = PRESETS.find((p) => {
    const r = rangeForPreset(p.key);
    return r.from === state.from && r.to === state.to;
  });
  if (preset) return preset.label;

  const d = parseISO(state.from);
  const asMonth = monthRange(d.getFullYear(), d.getMonth());
  if (asMonth.from === state.from && asMonth.to === state.to) {
    return monthLabel(d.getFullYear(), d.getMonth());
  }
  return '';
}

let loadDebounce = null;

/**
 * Debounced entry point for the custom From/To fields specifically (see
 * their onChange handlers above) — each field can only change one half of
 * the range at a time, so calling load() straight away would query whatever
 * the *other* field still holds from before, which is often a stale,
 * unintended pairing (e.g. From just moved to Aug 1 while To is still Dec 31
 * from an earlier "This Year" view). Coalescing the pair of edits into one
 * load(), fired only once they've settled, means the query that actually
 * runs always reflects the finished range rather than a fleeting
 * in-between one. Every other caller of load() (month nav, presets,
 * Refresh) already changes From and To together in one atomic step, so they
 * call load() directly — there's no in-between state for them to coalesce.
 */
function scheduleLoad() {
  clearTimeout(loadDebounce);
  loadDebounce = setTimeout(load, 260);
}

let loadToken = 0;

async function load() {
  if (state.to < state.from) {
    toast.error('The "To" date must be on or after the "From" date.');
    return;
  }

  // Guards against a fast prev/next/preset click resolving after a later one
  // (out-of-order network responses) and overwriting the current range's
  // data with a stale range's — only the most recent call's result gets
  // applied.
  const myToken = ++loadToken;
  state.loading = true;
  render();
  try {
    const data = await summaryService.getBookingSummary(state.from, state.to);
    if (myToken !== loadToken) return;
    state.data = data;
  } catch (err) {
    if (myToken !== loadToken) return;
    toast.error(err.message);
    state.data = null;
  } finally {
    if (myToken === loadToken) {
      state.loading = false;
      render();
    }
  }
}

/**
 * Builds the statement from exactly what's on screen — `state.data` is the
 * result already fetched and rendered for the current range, so the PDF can
 * never disagree with the tables it was generated from, and no extra query
 * runs to produce it.
 */
async function handleDownloadStatement() {
  if (state.loading || !state.data) {
    toast.warning('Still loading this range — try again in a moment.');
    return;
  }
  if (!state.data.totalNights) {
    toast.error('There are no bookings in this range to put on a statement.');
    return;
  }

  setDownloading(true);
  try {
    const { blob, fileName } = await generateSummaryStatementPdf({
      from: state.from,
      to: state.to,
      rangeLabel: currentRangeLabel(),
      data: state.data
    });
    triggerBrowserDownload(blob, fileName);
    toast.success('Statement downloaded.');
  } catch (err) {
    toast.error(err.message);
  } finally {
    setDownloading(false);
  }
}

function setDownloading(isDownloading) {
  state.downloading = isDownloading;
  els.statementBtn.classList.toggle('is-loading', isDownloading);
  els.statementBtn.disabled = isDownloading || state.loading || !state.data?.totalNights;
}

function triggerBrowserDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function monthKeyLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return monthLabel(y, m - 1);
}

/**
 * One row per booker, each with a "More Details" toggle revealing a second,
 * nested row listing the guests behind that booker's nights. The detail row
 * is rendered up front and hidden rather than built on demand — the data is
 * already in hand from the same query, so there's nothing to wait for, and
 * keeping it in the table means the mobile stacked-card layout picks it up
 * for free.
 */
function renderBookerTable(byBooker) {
  if (!byBooker.length) {
    return `<div class="state-block"><div class="state-icon">📊</div><div class="state-title">No bookings in this range</div></div>`;
  }
  return `
    <div class="table-wrap">
      <table class="data-table stacked-table" id="summary-booker-table">
        <thead>
          <tr>
            <th>Booker</th>
            <th>Nights</th>
            <th>Revenue</th>
            <th>Commission (9%)</th>
            <th>Area Guard (1%)</th>
            <th>Villa Guard (50K)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${byBooker
            .map((b, idx) => {
              const isOpen = state.expandedBookers.has(b.bookedBy);
              return `
            <tr>
              <td data-label="Booker" dir="auto">${escapeHtml(b.bookedBy)}</td>
              <td class="num" data-label="Nights">${b.nights}</td>
              <td class="num" data-label="Revenue">${formatIDR(b.revenue)}</td>
              <td class="num" data-label="Commission (9%)">${formatIDR(b.commission)}</td>
              <td class="num text-muted" data-label="Area Guard (1%)">${formatIDR(b.areaGuard)}</td>
              <td class="num text-muted" data-label="Villa Guard (50K)">${formatIDR(b.villaGuard)}</td>
              <td class="summary-details-cell" data-label="Details">
                <button type="button" class="btn btn-sm btn-secondary summary-details-btn"
                        data-details-index="${idx}" aria-expanded="${isOpen}" aria-controls="summary-guest-row-${idx}">
                  ${isOpen ? 'Hide Details' : 'More Details'}
                </button>
              </td>
            </tr>
            <tr class="summary-guest-detail-row${isOpen ? ' is-open' : ''}" id="summary-guest-row-${idx}"${isOpen ? '' : ' hidden'}>
              <td class="summary-guest-detail-cell" colspan="7">
                <div class="summary-guest-detail-anim">
                  <div class="summary-guest-detail-clip">${renderGuestDetail(b)}</div>
                </div>
              </td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

/** The per-guest breakdown behind one booker's row: who actually stayed the
 * nights that booker is credited with, and the 9% each of those guests
 * generated. Nights whose dates no saved invoice covers are grouped into a
 * single, clearly-labelled row rather than being dropped — the nights and
 * commission here always add back up to the booker's own row above. */
function renderGuestDetail(booker) {
  if (!booker.guests.length) {
    return `<div class="summary-guest-empty">No guest detail available for this booker.</div>`;
  }

  return `
    <div class="summary-guest-detail">
      <div class="summary-guest-detail-title">Guests booked by <strong dir="auto">${escapeHtml(booker.bookedBy)}</strong></div>
      <table class="data-table stacked-table summary-guest-table">
        <thead>
          <tr><th>Guest</th><th>Nights</th><th>Revenue</th><th>Commission (9%)</th></tr>
        </thead>
        <tbody>
          ${booker.guests
            .map(
              (g) => `
            <tr>
              <td data-label="Guest">${renderGuestName(g)}</td>
              <td class="num" data-label="Nights">${g.nights}</td>
              <td class="num" data-label="Revenue">${formatIDR(g.revenue)}</td>
              <td class="num" data-label="Commission (9%)">${formatIDR(g.commission)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * dir="auto" so an Arabic guest name sitting next to a Latin invoice number
 * lays out in its own direction instead of the two being reordered into each
 * other.
 *
 * The name and its invoice number(s) are wrapped in one element rather than
 * left as two siblings: on mobile the containing <td> is a flex row (see
 * .stacked-table td), so two siblings would be laid out as two separate
 * columns alongside the label instead of the number sitting under the name.
 */
function renderGuestName(guest) {
  if (!guest.guestName) {
    return `<span class="summary-guest-unmatched">No matching invoice</span>`;
  }
  const invoices = guest.invoiceNumbers.length
    ? `<span class="summary-guest-invoice">${escapeHtml(guest.invoiceNumbers.join(', '))}</span>`
    : '';
  return `<span class="summary-guest-name-cell"><span class="summary-guest-name" dir="auto">${escapeHtml(guest.guestName)}</span>${invoices}</span>`;
}

// Keep in sync with the transition duration on .summary-guest-detail-anim in
// css/summary.css (--dur-base). Only used as a safety net — see closeRow().
const DETAIL_ANIM_MS = 180;

// Pending "hide once the collapse finishes" work, per row, so re-opening a
// row mid-collapse can cancel it rather than having it hide itself a beat
// later underneath the user.
const pendingCollapse = new WeakMap();

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

function cancelPendingCollapse(row) {
  const pending = pendingCollapse.get(row);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.wrap.removeEventListener('transitionend', pending.onEnd);
  pendingCollapse.delete(row);
}

/**
 * The `hidden` attribute still does the real showing and hiding — a
 * collapsed row stays out of the layout and the accessibility tree rather
 * than lingering at zero height — but it can't be transitioned, so it's
 * applied a frame *before* the opening animation and only *after* the
 * closing one. The animation itself is a grid 0fr→1fr on a wrapper inside
 * the cell (see css/summary.css), not on the <tr>: table rows don't animate
 * their own height reliably, and `overflow: hidden` is ignored on
 * table-row/table-cell boxes, so there'd be nothing to clip the content
 * against on the way down.
 */
function openRow(row) {
  cancelPendingCollapse(row);
  row.hidden = false;

  if (prefersReducedMotion()) {
    row.classList.add('is-open');
    return;
  }
  // Force a style/layout flush so the collapsed (0fr) state is committed
  // before the class change below. Without it the browser coalesces
  // un-hiding and opening into one style recalculation, with no starting
  // value to transition from, and the row simply snaps open. A
  // requestAnimationFrame pair is the other common way to do this, but it
  // silently does nothing while the page is hidden (rAF is throttled), so
  // the row would sit open-but-unanimated until the tab came back.
  void row.offsetHeight;
  row.classList.add('is-open');
}

function closeRow(row) {
  cancelPendingCollapse(row);
  row.classList.remove('is-open');

  if (prefersReducedMotion()) {
    row.hidden = true;
    return;
  }

  const wrap = row.querySelector('.summary-guest-detail-anim');
  if (!wrap) {
    row.hidden = true;
    return;
  }

  const finish = () => {
    cancelPendingCollapse(row);
    row.hidden = true;
  };
  const onEnd = (event) => {
    if (event.target === wrap && event.propertyName === 'grid-template-rows') finish();
  };
  wrap.addEventListener('transitionend', onEnd);
  // Backstop for browsers that don't interpolate grid-template-rows: the
  // class change still applies (so it collapses, just instantly) but no
  // transitionend ever arrives to hide the row afterwards.
  const timer = setTimeout(finish, DETAIL_ANIM_MS + 80);
  pendingCollapse.set(row, { timer, wrap, onEnd });
}

/** Toggles a booker's detail row in place rather than re-rendering the whole
 * table — nothing about the data changed, only what's shown. */
function bindBookerTableEvents(host, byBooker) {
  host.querySelectorAll('.summary-details-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.detailsIndex);
      const booker = byBooker[idx];
      const row = host.querySelector(`#summary-guest-row-${idx}`);
      if (!booker || !row) return;

      // Read intent from the class, not from `hidden` — during a collapse
      // the row is briefly still visible while already on its way closed.
      const willOpen = !row.classList.contains('is-open');
      if (willOpen) openRow(row);
      else closeRow(row);

      btn.textContent = willOpen ? 'Hide Details' : 'More Details';
      btn.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) state.expandedBookers.add(booker.bookedBy);
      else state.expandedBookers.delete(booker.bookedBy);
    });
  });
}

function renderMonthTable(byMonth) {
  if (!byMonth.length) {
    return `<div class="state-block"><div class="state-icon">📊</div><div class="state-title">No bookings in this range</div></div>`;
  }
  return `
    <div class="table-wrap">
      <table class="data-table stacked-table" id="summary-month-table">
        <thead>
          <tr><th>Month</th><th>Nights</th><th>Total Revenue</th><th>Net Revenue</th></tr>
        </thead>
        <tbody>
          ${byMonth
            .map(
              (m) => `
            <tr>
              <td data-label="Month">${escapeHtml(monthKeyLabel(m.month))}</td>
              <td class="num" data-label="Nights">${m.nights}</td>
              <td class="num" data-label="Total Revenue">${formatIDR(m.revenue)}</td>
              <td class="num summary-net-revenue" data-label="Net Revenue">${formatIDR(m.netRevenue)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div class="summary-net-hint">Net Revenue = Total Revenue − Commission (9%) − Area Guard (1%) − Villa Guard (50K × nights).</div>
    </div>
  `;
}

function render() {
  els.presetsRow.querySelectorAll('[data-preset]').forEach((btn) => {
    const { from, to } = rangeForPreset(btn.dataset.preset);
    const isActive = from === state.from && to === state.to;
    btn.classList.toggle('btn-primary', isActive);
    btn.classList.toggle('btn-secondary', !isActive);
  });

  els.refreshBtn.disabled = state.loading;
  els.refreshBtn.classList.toggle('is-loading', state.loading);
  els.statementBtn.disabled = state.loading || state.downloading || !state.data?.totalNights;

  if (state.loading) {
    const skeleton = `<div class="skeleton" style="height:36px;margin-bottom:8px;"></div><div class="skeleton" style="height:36px;"></div>`;
    els.totalNights.textContent = '…';
    els.totalRevenue.textContent = '…';
    els.totalCommission.textContent = '…';
    els.guardCutNote.textContent = '';
    els.missingWarning.hidden = true;
    els.byBookerHost.innerHTML = skeleton;
    els.byMonthHost.innerHTML = skeleton;
    return;
  }

  if (!state.data) {
    els.totalNights.textContent = '—';
    els.totalRevenue.textContent = '—';
    els.totalCommission.textContent = '—';
    els.guardCutNote.textContent = '';
    els.missingWarning.hidden = true;
    els.byBookerHost.innerHTML = `<div class="state-block"><div class="state-title">Could not load this range</div></div>`;
    els.byMonthHost.innerHTML = '';
    return;
  }

  const {
    byBooker,
    byMonth,
    totalNights,
    totalRevenue,
    totalCommission,
    totalAreaGuard,
    totalVillaGuard,
    missingPriceNights,
    missingPriceDates
  } = state.data;

  els.totalNights.textContent = String(totalNights);
  els.totalRevenue.textContent = formatIDR(totalRevenue);
  els.totalCommission.textContent = formatIDR(totalCommission);
  // Deliberately a small note, not their own stat boxes — both guard cuts are
  // secondary info next to nights/revenue/commission, per the villa owner's
  // own framing of them. Both are shown here because they're the two figures
  // the By Month table's Net Revenue column is computed from, and there'd
  // otherwise be nowhere on the page to check that subtraction against. One
  // per line rather than run together on one: they're two unrelated cuts on
  // two different bases (a % of revenue vs. a flat rate per night), so
  // reading them stacked is quicker than picking them apart from one string.
  els.guardCutNote.innerHTML = `
    <div class="summary-guard-line">Area guard (1%): ${formatIDR(totalAreaGuard)}</div>
    <div class="summary-guard-line">Villa guard (50K × ${totalNights} night${totalNights === 1 ? '' : 's'}): ${formatIDR(totalVillaGuard)}</div>
  `;

  if (totalNights === 0) {
    // Distinct from the pricing-mismatch warning below — this is a plain
    // "nothing to show" state, not a data-quality issue, so it gets its own
    // clearly different (red, not amber) treatment rather than being lumped
    // in with missingPriceNights (which can only be non-zero when there ARE
    // booked nights).
    els.missingWarning.hidden = false;
    els.missingWarning.classList.add('pricing-warning--empty');
    els.missingWarning.innerHTML = '🔴 The selected dates have no booking in them.';
  } else if (missingPriceNights > 0) {
    els.missingWarning.hidden = false;
    els.missingWarning.classList.remove('pricing-warning--empty');
    els.missingWarning.innerHTML = `⚠ ${missingPriceNights} booked night${missingPriceNights === 1 ? '' : 's'} in this range ${missingPriceNights === 1 ? 'has' : 'have'} no matching pricing rule and ${missingPriceNights === 1 ? 'is' : 'are'} excluded from revenue totals.${renderMissingDatesList(missingPriceDates)}`;
  } else {
    els.missingWarning.hidden = true;
    els.missingWarning.classList.remove('pricing-warning--empty');
  }

  els.byBookerHost.innerHTML = renderBookerTable(byBooker);
  bindBookerTableEvents(els.byBookerHost, byBooker);
  els.byMonthHost.innerHTML = renderMonthTable(byMonth);
}

/** Names the exact date(s) missing a pricing rule, not just a count — so
 * whoever's filling in the Prices tab can go straight to the actual gap
 * instead of re-checking the whole range by hand. Capped at 8 dates inline;
 * beyond that a running list would be more clutter than help. */
function renderMissingDatesList(dates) {
  if (!dates?.length) return '';
  const shown = dates.slice(0, 8).map((d) => escapeHtml(formatDisplayDate(d)));
  const extra = dates.length - shown.length;
  const list = shown.join(', ') + (extra > 0 ? `, +${extra} more` : '');
  return ` (${list})`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function template() {
  return `
    <div class="page">
      <div class="page-actions">
        <button class="btn btn-primary" id="btn-download-statement" type="button" disabled>
          <span class="spinner"></span>
          <span class="btn-label">Download Statement PDF</span>
        </button>
      </div>

      <div class="card">
        <div class="card-header">
          <h2>Filter by Date</h2>
          <button type="button" class="btn btn-sm btn-secondary" id="summary-refresh" title="Refresh data">
            <span class="spinner"></span>
            <span class="btn-label">⟳ Refresh</span>
          </button>
        </div>
        <div class="card-body">
          <div class="summary-range-row">
            <div class="summary-month-switcher" id="summary-month-switcher">
              <button type="button" class="btn btn-icon btn-secondary" id="summary-month-prev" aria-label="Previous month">‹</button>
              <div class="summary-month-label" id="summary-month-label"></div>
              <button type="button" class="btn btn-icon btn-secondary" id="summary-month-next" aria-label="Next month">›</button>
            </div>
            <div class="field-row summary-custom-range" id="summary-custom-range">
              <div class="field">
                <label class="field-label">From</label>
                <div id="summary-from-slot"></div>
              </div>
              <div class="field">
                <label class="field-label">To</label>
                <div id="summary-to-slot"></div>
              </div>
            </div>
          </div>
          <div class="summary-presets" id="summary-presets">
            ${PRESETS.map((p) => `<button type="button" class="btn btn-sm btn-secondary" data-preset="${p.key}">${p.label}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="invoice-meta-row summary-stats-row">
        <div class="invoice-meta-box">
          <div class="kv-label">Total Nights Sold</div>
          <div class="kv-value" id="summary-total-nights">—</div>
        </div>
        <div class="invoice-meta-box">
          <div class="kv-label">Total Revenue</div>
          <div class="kv-value" id="summary-total-revenue">—</div>
        </div>
        <div class="invoice-meta-box">
          <div class="kv-label">Total Commissions (9%)</div>
          <div class="kv-value" id="summary-total-commission">—</div>
        </div>
      </div>
      <div class="summary-guard-note text-muted" id="summary-guard-cut-note"></div>
      <div class="pricing-warning" id="summary-missing-warning" hidden></div>

      <div class="card">
        <div class="card-header"><h2>By Booker</h2></div>
        <div class="card-body" id="summary-by-booker-host"></div>
      </div>

      <div class="card">
        <div class="card-header"><h2>By Month — All Bookers</h2></div>
        <div class="card-body" id="summary-by-month-host"></div>
      </div>
    </div>
  `;
}
