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
function. `app.js` calls all three once, at startup:

```js
invoiceTab.mount(document.getElementById('tab-invoice'));
pricesTab.mount(document.getElementById('tab-prices'));
availabilityTab.mount(document.getElementById('tab-availability'));
```

All three tabs are mounted into the DOM up front and simply shown/hidden via
the `hidden` attribute when the user switches tabs — not re-mounted every
time. Two reasons:

1. **No page reloads, no flicker** — switching tabs is an instant CSS
   visibility toggle.
2. **In-progress form state survives tab switches.** A staff member filling
   out an invoice can flip to Prices to check a rate, then flip back, and
   the invoice form is exactly as they left it.

Each component keeps a private module-level `state` object plus a `render()`
function that re-renders from that state. There's no virtual DOM or diffing
— for three tabs' worth of UI, targeted `innerHTML` updates on specific
containers (e.g. re-rendering just the pricing breakdown table when nights
change, not the whole form) are simple and fast enough, and easier to reason
about than introducing a UI framework the project brief explicitly excluded.

## Data flow: creating an invoice

1. `invoiceTab` calls `invoiceService.generateInvoiceNumber()` on mount,
   which calls the `generate_invoice_number()` Postgres function via
   `supabase.rpc(...)`. The number is displayed read-only immediately.
2. As the user fills in check-in date and nights, `invoiceTab` debounces a
   call to `invoiceService.calculateStayPricing()`, which fetches every
   `neom_price` row overlapping the stay and splits it into one row per
   pricing period (see `DATABASE.md` for the algorithm).
3. On **Download Invoice PDF**: the form is validated, `pdfGenerator.js`
   renders a PDF `Blob` entirely client-side, and its underlying data (guest
   name, dates, pricing rows, total, generation timestamp — no file) is
   recorded via the `insert_invoice_revision()` RPC (which atomically
   assigns the next revision number) — **and only after that succeeds** does
   the browser download trigger. This ordering exists specifically so a
   "downloaded" invoice is never left unsaved (see `PDF_ENGINE.md`).
   Re-downloading an old revision later doesn't fetch a stored file either —
   it re-runs `pdfGenerator.js` against that revision's saved data snapshot.

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
app's shape: three tabs, no shared cross-tab data, no deep component trees,
no server-side rendering. Vanilla `mount(container)` components with a thin
service layer give the same practical benefits (separation of concerns,
reusable pieces) without the bundler, framework runtime, or build tooling
this project explicitly doesn't need.
