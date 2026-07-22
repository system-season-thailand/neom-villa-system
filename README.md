# Neom Villa — Staff Console

A staff-only Progressive Web App for generating professional invoice PDFs,
managing seasonal pricing, and tracking calendar availability for Neom
Villa. Built for speed and reliability over visual flourish — three tabs,
minimal clicks, maximum automation.

## Overview

| Tab | Arabic label | Purpose |
|---|---|---|
| Invoice | فاتورة | Create guest invoices with automatic pricing, export vector-quality PDFs, and browse/restore past revisions. |
| Prices | اسعار | Manage seasonal nightly rates used automatically by the Invoice tab. |
| Availability | توافرات | A calendar of booking status per date, with past dates automatically marked Passed. |

It's a plain HTML/CSS/JavaScript static site — no framework, no bundler, no
build step. Third-party libraries (Supabase JS, jsPDF, jsPDF-AutoTable) are
loaded from a CDN as pinned-version `<script>` tags. This makes it a direct
fit for static hosting such as GitHub Pages: push the repository, point
Pages at the root, done.

Data lives in a single Supabase Postgres database — there is no Storage
bucket; invoice PDFs are regenerated on demand from a saved data snapshot
rather than kept as files (see [`PDF_ENGINE.md`](PDF_ENGINE.md)). See
[`DATABASE.md`](DATABASE.md) for the schema and [`/sql`](sql/) for the
scripts that create it.

## Installation / running locally

There is nothing to install or compile. Serve the folder with any static
file server and open it in a browser — for example:

```bash
npx serve .
# or
python -m http.server 8080
```

Then visit the printed local URL. The app talks directly to the Supabase
project configured in [`js/config/supabase.js`](js/config/supabase.js).

**Before first use**, run the three SQL scripts in [`/sql`](sql/) against
your Supabase project (SQL Editor → run `001`, then `002`, then `003` — see
[`sql/README.md`](sql/README.md)). Without them the tables the app expects
don't exist yet.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. Repo → **Settings → Pages** → set **Source** to the `main` branch, root folder.
3. Wait for the Pages build to finish, then open the published URL.

No environment variables or secrets to configure — the Supabase URL and
anon key are intentionally hardcoded in `js/config/supabase.js` (this is a
staff-only tool with no build pipeline; see [`DATABASE.md`](DATABASE.md) for
why that's an acceptable trade-off here). Because it's a plain static site,
any other static host (Netlify, Vercel, Cloudflare Pages, S3) works
identically if you ever move off GitHub Pages.

## Folder structure

```
├── index.html                 App shell: topbar, tab nav, the three panel containers
├── manifest.json               PWA manifest (icons, theme, standalone display)
│
├── css/
│   ├── base.css                 Design tokens (colors, type, resets)
│   ├── layout.css                App shell layout (topbar, tabs, page grid)
│   ├── components.css            Reusable UI: buttons, forms, tables, modal, toast, badges
│   ├── invoice.css               Invoice tab-specific styles
│   ├── prices.css                Prices tab-specific styles
│   ├── availability.css          Availability calendar styles
│   └── auth.css                  Login gate + topbar role badge styles
│
├── js/
│   ├── app.js                    Entry point: auth gate, tab router, connection indicator, mounts tabs
│   ├── auth/
│   │   └── authService.js         Role gate (Admin/User) — localStorage-backed, see ARCHITECTURE.md
│   ├── config/
│   │   └── supabase.js            Supabase client + credentials
│   ├── services/                  All Supabase reads/writes — the only layer that talks to the DB
│   │   ├── invoiceService.js        Invoice numbers, pricing calc, revisions
│   │   ├── priceService.js          Seasonal pricing CRUD
│   │   ├── availabilityService.js   Calendar status CRUD (incl. bulk status updates)
│   │   ├── settingsService.js       Staff-editable option lists (Guest By)
│   │   └── linkedStayService.js     "Must be booked together" date-group CRUD
│   ├── components/                 One file per UI feature, each exporting mount(container)
│   │   ├── invoiceTab.js
│   │   ├── pricesTab.js
│   │   ├── availabilityTab.js
│   │   ├── loginGate.js
│   │   ├── modal.js
│   │   ├── toast.js
│   │   └── datePicker.js            Shared calendar popover (Prices tab + Invoice tab's check-in)
│   ├── state/
│   │   └── store.js                Minimal observable store for cross-cutting state
│   └── utils/
│       ├── dateUtils.js             ISO date helpers, month-grid builder
│       ├── format.js                IDR currency formatting
│       ├── validators.js            Form field validation
│       ├── dbErrors.js              Friendly messages for Postgres error codes
│       ├── pdfGenerator.js          Builds the invoice PDF (jsPDF vector text + canvas-rendered Arabic)
│       └── arabicReshaper.js        containsArabic() — routes Arabic strings to canvas rendering
│
├── assets/
│   ├── icons/                     PWA icons + favicon
│   └── fonts/                     Font license text
│
└── sql/                           Database setup — see sql/README.md
```

## Related documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design, data flow, component pattern
- [`DATABASE.md`](DATABASE.md) — schema, revision system, pricing/availability logic
- [`PDF_ENGINE.md`](PDF_ENGINE.md) — how invoice PDFs are generated and revisioned
- [`FUTURE_IMPROVEMENTS.md`](FUTURE_IMPROVEMENTS.md) — known trade-offs and suggested next steps
- [`sql/README.md`](sql/README.md) — database setup instructions
