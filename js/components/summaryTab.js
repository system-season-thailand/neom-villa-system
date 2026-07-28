import * as summaryService from '../services/summaryService.js';
import { toast } from './toast.js';
import { createDatePicker } from './datePicker.js';
import { toISO, parseISO, monthLabel, formatDisplayDate } from '../utils/dateUtils.js';
import { formatIDR } from '../utils/format.js';

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
    totalNights: container.querySelector('#summary-total-nights'),
    totalRevenue: container.querySelector('#summary-total-revenue'),
    totalCommission: container.querySelector('#summary-total-commission'),
    guardCutNote: container.querySelector('#summary-guard-cut-note'),
    missingWarning: container.querySelector('#summary-missing-warning'),
    byBookerHost: container.querySelector('#summary-by-booker-host'),
    byMonthHost: container.querySelector('#summary-by-month-host')
  };

  const initial = rangeForPreset('this_month');
  state = { from: initial.from, to: initial.to, loading: true, data: null };

  fromPicker = createDatePicker({
    value: state.from,
    onChange: (value) => {
      state.from = value;
      updateMonthLabel();
      load();
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
      load();
    }
  });
  els.toSlot.appendChild(toPicker.trigger);

  els.monthPrev.addEventListener('click', () => navigateMonth(-1));
  els.monthNext.addEventListener('click', () => navigateMonth(1));
  els.refreshBtn.addEventListener('click', () => load());

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

function monthKeyLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return monthLabel(y, m - 1);
}

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
            <th>Guard Cut (1%)</th>
          </tr>
        </thead>
        <tbody>
          ${byBooker
            .map(
              (b) => `
            <tr>
              <td data-label="Booker">${escapeHtml(b.bookedBy)}</td>
              <td class="num" data-label="Nights">${b.nights}</td>
              <td class="num" data-label="Revenue">${formatIDR(b.revenue)}</td>
              <td class="num" data-label="Commission (9%)">${formatIDR(b.commission)}</td>
              <td class="num text-muted" data-label="Guard Cut (1%)">${formatIDR(b.guardCut)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderMonthTable(byMonth) {
  if (!byMonth.length) {
    return `<div class="state-block"><div class="state-icon">📊</div><div class="state-title">No bookings in this range</div></div>`;
  }
  return `
    <div class="table-wrap">
      <table class="data-table stacked-table" id="summary-month-table">
        <thead>
          <tr><th>Month</th><th>Nights</th><th>Revenue</th></tr>
        </thead>
        <tbody>
          ${byMonth
            .map(
              (m) => `
            <tr>
              <td data-label="Month">${escapeHtml(monthKeyLabel(m.month))}</td>
              <td class="num" data-label="Nights">${m.nights}</td>
              <td class="num" data-label="Revenue">${formatIDR(m.revenue)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
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

  const { byBooker, byMonth, totalNights, totalRevenue, totalCommission, totalGuardCut, missingPriceNights, missingPriceDates } = state.data;

  els.totalNights.textContent = String(totalNights);
  els.totalRevenue.textContent = formatIDR(totalRevenue);
  els.totalCommission.textContent = formatIDR(totalCommission);
  // Deliberately a small note, not its own stat box — the 1% guard cut is
  // secondary info next to nights/revenue/commission, per the villa owner's
  // own framing of it as "doesn't matter that much".
  els.guardCutNote.textContent = `Villa guard's cut (1%): ${formatIDR(totalGuardCut)}`;

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
