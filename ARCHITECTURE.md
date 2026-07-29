# Architecture

## Stack

Plain HTML/CSS/JavaScript (ES modules), no framework, no build step. Three
CDN libraries loaded as pinned UMD `<script>` tags in `index.html`:

- **Supabase JS v2** — database only (no Storage — see below).
- **jsPDF** — vector PDF generation.
- **jsPDF-AutoTable** — the invoice charges table inside the PDF.

This stack was a project requirement (see `PWA-BUILDING_PROMPT.md`): no
React/Vue/Angular/etc., and no bundler — the app must run as static files
with no build step, which is also what makes GitHub Pages hosting trivial.

## Layered structure

```
components/  →  services/  →  Supabase (Postgres only)
     ↓              ↓
   utils/        utils/
```

- **`components/`** own the DOM and user interaction for one tab each. They
  never call Supabase directly — only through `services/`.
- **`services/`** are the only modules that import the Supabase client. Each
  wraps one table and translates between the DB's `snake_case` rows and the
  app's `camelCase` objects, and turns raw Postgres errors into friendly
  messages via `utils/dbErrors.js`. There's no storage service — no PDF file
  is ever uploaded anywhere (see the Data flow section below).
- **`utils/`** are pure functions with no DOM or network access: dates,
  currency formatting, validation, Arabic text shaping, PDF drawing.
- **`state/store.js`** holds the handful of values genuinely shared across
  components (Supabase connection status). Each tab component otherwise owns
  its own local state — there's no global state tree, which would be
  overkill for three independent tabs.

## Component pattern

Every tab component is a module exporting a single `mount(container)`
function. `app.js` calls all four once, at startup:

```js
invoiceTab.mount(document.getElementById('tab-invoice'));
pricesTab.mount(document.getElementById('tab-prices'));
availabilityTab.mount(document.getElementById('tab-availability'));
summaryTab.mount(document.getElementById('tab-summary'));
```

All four tabs are mounted into the DOM up front and simply shown/hidden via
the `hidden` attribute when the user switches tabs — not re-mounted every
time. Two reasons:

1. **No page reloads, no flicker** — switching tabs is an instant CSS
   visibility toggle.
2. **In-progress form state survives tab switches.** A staff member filling
   out an invoice can flip to Prices to check a rate, then flip back, and
   the invoice form is exactly as they left it.

Each component keeps a private module-level `state` object plus a `render()`
function that re-renders from that state. There's no virtual DOM or diffing
— for four tabs' worth of UI, targeted `innerHTML` updates on specific
containers (e.g. re-rendering just the pricing breakdown table when nights
change, not the whole form) are simple and fast enough, and easier to reason
about than introducing a UI framework the project brief explicitly excluded.

## Data flow: creating an invoice

There is no "New Invoice" button. `invoiceTab` always shows either a
brand-new, not-yet-saved form or an existing invoice loaded for editing —
the only way back to a fresh blank form is downloading the current one.

1. `invoiceTab` calls `invoiceService.peekNextInvoiceNumber()` on mount (and
   again right after downloading a brand-new invoice), which calls the
   `peek_next_invoice_number()` Postgres function via `supabase.rpc(...)`.
   This is a **preview only** — it reads the sequence's current state
   without consuming it, so it's displayed read-only but is not yet a real,
   committed invoice number (see `state.invoiceNumberCommitted`).
2. As the user fills in check-in date and nights, `invoiceTab` debounces a
   call to `invoiceService.calculateStayPricing()`, which fetches every
   `neom_price` row overlapping the stay and splits it into one row per
   pricing period (see `DATABASE.md` for the algorithm).
3. On **Download Invoice PDF**: the form is validated, then
   `insert_invoice_revision()` is called via RPC with the `invoice_data`
   snapshot (guest name, guest by, dates, pricing rows, total, generation
   timestamp — no file) and either the existing invoice number (revising a
   committed invoice) or `NULL` (a brand-new invoice — the function mints
   the real number itself as part of the same insert; see `DATABASE.md` →
   "Revision system"). Only *after* that save succeeds does `pdfGenerator.js`
   render the PDF `Blob`, built from what the save actually returned, and
   only then does the browser download trigger. This ordering exists
   specifically so a "downloaded" invoice is never left unsaved, and so a
   saved invoice number always corresponds to a real, downloaded PDF (see
   `PDF_ENGINE.md`). If this was a brand-new invoice, the form then resets
   to another blank preview for the next guest; revising an existing
   invoice instead stays on the same form. Re-downloading an old revision
   later doesn't fetch a stored file either — it re-runs `pdfGenerator.js`
   against that revision's saved data snapshot.

## Custom date picker

Neither the Add/Edit Pricing Rule modal's Start/End fields (`pricesTab.js`)
nor the Invoice tab's Check-in field (`invoiceTab.js`) use a native
`<input type="date">` — native date pickers only support a min/max bound,
with no way to grey out arbitrary dates in the middle of the range.
`createDatePicker()` in `js/components/datePicker.js` — a shared UI
component, alongside `modal.js`/`toast.js`, not owned by either tab — renders
its own small calendar popover (the same `buildMonthMatrix`/`monthLabel`
helpers the Availability tab uses) instead.

The two call sites use it differently:

- **Prices tab:** passes `disabledDates`, a set of every date already
  covered by some *other* `neom_price` rule — fetched fresh via
  `priceService.listPrices()` at modal-open time rather than reused from the
  table's own (possibly search-filtered) state, and with the rule currently
  being edited (if any) excluded so its own existing range stays selectable.
  It reads the picked date once, via `getValue()`, when the form is saved.
- **Invoice tab:** passes no `disabledDates` at all — every date is
  pickable, including past ones — and an `onChange` callback instead, since
  picking a check-in date needs to immediately recompute the check-out date
  and re-run pricing, not just wait to be read at save time.
- **Summary tab's Custom range** (`summaryTab.js`) uses both `onChange` and
  the picker's `open()` method together: picking a From date opens the To
  field's picker automatically — one fewer click for the common case of
  setting both ends of a range back to back. The Prices tab's Start field
  does the same for its End field.

Only one popover is ever open at a time, app-wide — `datePicker.js` tracks
that itself and closes the previous one whenever a new one opens.
`setValue()` keeps the popover's own displayed month in sync with whatever
value it's given, not just the trigger's label text — needed for the
Summary tab's month-switcher, which calls `setValue()` on every prev/next
click rather than waiting for the user to pick a day inside the popover
itself.

## Shared option-select dropdown

The Invoice tab's **Guest By** field and the Availability tab's **Booked
By** field (in the single-date status popover) are both the same component:
`createOptionSelect({ key, label, value, onChange })` in
`js/components/optionSelect.js`, pointed at a different
`neom_system_settings` key (`GUEST_BY_KEY` / `BOOKED_BY_KEY`, exported from
`settingsService.js`) for each. Like `datePicker.js`, it's a shared UI
component rather than something either tab owns.

Beyond the plain values, the rendered `<select>` always carries two standing
entries: **"+ Add new…"** opens a one-field modal for the fast path, and
**"✎ Manage list…"** opens a fuller modal listing every current option with
an inline rename (Save) and Delete button per row, plus its own add-row —
both call straight through to `settingsService.js`'s generic
`addOption`/`updateOption`/`deleteOption(key/id, value)`. Renaming or
deleting an option only affects the dropdown going forward: since
`setting_value` is copied as plain text onto whatever record used it (an
invoice's `guestBy`, a date's `booked_by`), nothing already saved changes
retroactively — the same reasoning `neom_price`'s free-text `season_note`
already relies on.

## Role gate (Admin / User)

`js/auth/authService.js` checks an entered password against two hardcoded
values and stores the resulting role (`'admin'` or `'user'`) in
`localStorage`. `app.js` checks this before anything else runs: no role means
`loginGate.js` replaces `#app` with a password form and nothing else loads;
a role present means the app boots as normal, with `initTabs(role)` hiding
the فاتورة/اسعار/ملخص tab buttons entirely for `'user'` (they're never
mounted — `invoiceTab.js`/`pricesTab.js`/`summaryTab.js` aren't even fetched
for that role) and `availabilityTab.mount(el, { readOnly: role === 'user' })`
disabling every interactive affordance on the calendar (no cell clicks, no
bulk-select bar), leaving it a pure status display. Both roles fetch
`neom_price` for the visible month and print each date's nightly rate above
its status pill — Arabic ("لا يوجد سعر") for the read-only view, matching
its own فاتورة/اسعار/ملخص labeling, English ("No price set") for admins,
matching theirs — for any date no pricing rule covers; see
`findPriceForDate()` in `availabilityTab.js`. Admins additionally see who
booked a booked date printed above that same price line, reusing the exact
same `cell-price` styling for a name (see `renderAdminLine()`) — the read-only
view never shows this, since a front-desk user has no Booked By field to
begin with.

**This is a UX convenience, not a security boundary.** The passwords are
plain strings in a client-side bundle, and every Supabase table remains
open to the anon key regardless of role (see `DATABASE.md`). It stops the
wrong tab from being one accidental click away on a shared front-desk
device; it does not stop someone with dev tools from reading the source or
querying Supabase directly. See `FUTURE_IMPROVEMENTS.md`.

## Error handling

- Every service function throws a `friendlyDbError()`-wrapped `Error` with a
  staff-readable message (see `utils/dbErrors.js`) instead of a raw
  PostgREST error object.
- Every component action that can fail (save, delete, load) is wrapped in
  try/catch and reports failures via `toast.error()` rather than throwing
  silently or leaving the UI in an ambiguous state.
- `app.js` loads the config and tab modules via `import()` inside a
  try/catch specifically so a CDN or network failure on first load shows a
  reload-able error screen instead of a blank white page.
- Pricing calculation never guesses: if any night in a stay has no matching
  `neom_price` rule, the Invoice tab shows exactly which dates are missing
  and disables the Download button until it's fixed.

## Why no framework, no state library, no router

Not a limitation — a project requirement, and also the right fit for this
app's shape: four tabs, no shared cross-tab data, no deep component trees,
no server-side rendering. Vanilla `mount(container)` components with a thin
service layer give the same practical benefits (separation of concerns,
reusable pieces) without the bundler, framework runtime, or build tooling
this project explicitly doesn't need.
