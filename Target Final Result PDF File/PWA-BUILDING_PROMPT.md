# Build a Production-Ready Invoice Management PWA

Build a fully production-ready, staff-only Progressive Web App (PWA) for generating professional invoice PDFs. The application must prioritize speed, simplicity, reliability, and automation over visual effects. The goal is to minimize manual work while maximizing workflow efficiency.

The final result should be complete, polished, and immediately usable without requiring additional implementation.

---

# General Requirements

* Build a complete, production-ready web application.
* Clean, modular, maintainable architecture.
* Well-organized folder structure.
* Responsive on desktop and tablet (desktop-first).
* Installable PWA.
* Fast loading and optimized performance.
* Robust error handling.
* Input validation for all forms.
* Minimal, clean UI focused on speed.
* No unnecessary hover effects or fancy animations.
* Only subtle and fast transitions where appropriate.
* Staff-first UX where speed is more important than visual design.
* Write clean, documented, scalable code.

---

# Main Navigation

The application must contain exactly three tabs:

1. فاتورة (Invoice)
2. اسعار (Prices)
3. توافرات (Availability)

Navigation between tabs must be seamless without page reloads.

---

# TAB 1 — فاتورة (Invoice)

Use the attached invoice:

**ALMUZAINI MESHAL (INV-N-26-IIV-0122).pdf**

only as a reference for the invoice content.

Do **NOT** copy the design.

Instead, redesign it into a cleaner, more modern, well-organized, professional invoice while keeping it simple.

The exported PDF must use vector-based text (not rasterized images) to ensure excellent print quality.

---

## Invoice Fields

### Guest Name

* Manual typing.
* Include a quick-select chip/button:

  * عميل خاص
* This option is frequently used.

---

### Invoice Number

Automatically generated.

Requirements:

* Sequential numbering.
* Never duplicated.
* Automatically assigned.
* User cannot edit it manually.

---

### Check-in Date

* Easy-to-use date picker.

---

### Number of Nights

* Numbers only.
* Positive integers only.

---

### Check-out Date

This field must never be editable.

Automatically calculate:

Check-out = Check-in + Number of Nights

Whenever Check-in or Nights changes, Check-out updates immediately.

---

### Villa Type

Dropdown.

Options:

* 3 Bedroom Villa (Default)
* 2 Bedroom Villa

---

# Automatic Price Calculation

The invoice total must be calculated automatically using the pricing rules stored inside Supabase.

Support bookings that span multiple pricing periods.

Example:

High Season

3 Nights

3 × 2,500,000 IDR

Low Season

2 Nights

2 × 1,800,000 IDR

---

Total

5 Nights

11,100,000 IDR

Each pricing period must appear as its own invoice row.

Currency:

IDR only.

---

# PDF Export

Provide a button:

**Download Invoice PDF**

Requirements:

* Professional layout.
* A4.
* Vector text.
* Excellent print quality.
* Proper spacing.
* Consistent typography.
* Optimized file size.

---

# Invoice Revision System

Every downloaded invoice must also be saved.

Never overwrite previous versions.

Each saved invoice receives:

* Revision Number
* Created Date
* Updated Date
* Invoice Number

Users must be able to:

* Browse previous revisions.
* Open an old revision.
* Edit it.
* Download again.

Downloading an edited invoice must create a NEW revision instead of replacing the previous version.

---

# Import Invoice

Provide a button:

**Import Invoice**

The user can choose any previously saved invoice revision and restore all invoice fields for editing.

---

# TAB 2 — اسعار (Prices)

Create a pricing management page.

Purpose:

Manage seasonal pricing.

Each pricing rule contains:

* Start Date
* End Date
* Price Per Night (IDR)
* Season Note

Example notes:

* High Season
* Low Season
* Holiday
* Ramadan
* Weekend
* Promotion

or any custom text.

Example:

From:

1 June

To:

31 August

Price:

2,750,000 IDR

Note:

High Season

---

Requirements

* Unlimited pricing ranges.
* Support multiple years.
* Prevent overlapping pricing ranges through validation.
* Edit pricing.
* Delete pricing.
* Search pricing.
* Sort pricing.

These pricing rules must automatically be used during invoice generation.

---

# TAB 3 — توافرات (Availability)

Create an availability management page.

Each calendar date has one status.

Statuses:

* Available
* Booked
* On Hold
* Blocked
* Passed

Each status must have its own color for easy readability.

---

Automatic Rule

Every day before today automatically becomes:

Passed

No manual editing required.

---

Users can modify future dates to:

* Available
* Booked
* On Hold
* Blocked

Provide a simple, fast calendar interface for updating statuses.

---

# Supabase

The application will use three database tables.

---

## neom_pdf

Store:

* Invoice Number
* Invoice Data
* PDF metadata
* PDF Storage Path
* Revision Number
* Created Date
* Updated Date

Generated PDF files themselves should be stored inside a Supabase Storage bucket (for example: **invoice-pdfs**), while this table stores the invoice metadata and file path.

---

## neom_price

Store:

* Start Date
* End Date
* Price Per Night (IDR)
* Season Note

Support unlimited years.

---

## neom_availability

Store:

* Date
* Status
* Status Color
* Optional Notes

---

# Supabase Credentials

Use the credentials directly inside the application (hardcoded). Do NOT use environment variables (.env).

Project URL:
https://zrunsrimyijarswjfycw.supabase.co

Anon Key:
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpydW5zcmlteWlqYXJzd2pmeWN3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY3MjgzOTEsImV4cCI6MjA2MjMwNDM5MX0.UdW4LiIY-t1jZlrat1VUGnW0yRE7YEzW5SHbpkE29H8

---

# Database SQL Generation

Generate complete, production-ready SQL scripts that can be executed directly in the Supabase SQL Editor.

Include everything required:

* Tables
* Primary Keys
* Foreign Keys (if needed)
* Constraints
* Indexes
* Default values
* Timestamps
* Triggers (if useful)
* Functions (if useful)
* Storage bucket creation (if possible)
* Appropriate Row Level Security (RLS) policies for this application

Generate the SQL as separate files:

* 001_create_neom_pdf.sql
* 002_create_neom_price.sql
* 003_create_neom_availability.sql

Also generate a README explaining the execution order.

After executing the SQL, the application should work immediately without requiring additional database modifications.

---

# Automation Requirements

Automate as much as possible.

Examples:

* Invoice number automatically generated.
* Check-out automatically calculated.
* Total automatically calculated.
* Seasonal prices automatically detected.
* Multi-season bookings automatically split into invoice rows.
* Past dates automatically become Passed.
* Revision numbers automatically increment.
* Importing invoices restores every editable field automatically.

Minimize manual work wherever possible.

---

# Technical Requirements

Use modern best practices.

Include:

* HTML, CSS, JAVASCRIPT
Do NOT use React, Vue, Angular, Next.js, Nuxt, Svelte, TypeScript, or any other frontend framework unless I explicitly request it later.
Using third-party libraries is allowed whenever they provide a clear benefit or significantly reduce development time. Choose stable, well-maintained libraries only.
* Component-based architecture
* Strong typing
* Reusable components
* Service layer
* Proper state management
* Loading states
* Empty states
* Error boundaries
* Toast notifications
* Responsive layout
* Accessibility best practices
* Performance optimization
* Clean folder structure

---

# Documentation

Generate concise Markdown documentation.

Required files:

## README.md

Include:

* Installation
* Project overview
* Folder structure
* Build instructions

---

## ARCHITECTURE.md

Include:

* System architecture
* Folder organization
* Data flow
* Major components

---

## DATABASE.md

Include:

* Database schema
* Table descriptions
* Relationships
* Revision system
* Pricing logic
* Availability logic

---

## PDF_ENGINE.md

Include:

* PDF generation workflow
* PDF revision workflow

---

## FUTURE_IMPROVEMENTS.md

Include:

Suggestions for future enhancements.

---

# Code Quality

* No placeholder implementations.
* No TODO comments.
* No incomplete features.
* No mock data except where absolutely necessary.
* Follow production-ready coding standards throughout.
* Ensure the project is easy to extend and maintain.

---

# Final Goal

Deliver a polished, production-quality staff application that is immediately usable.

The application should prioritize:

* Fast workflow
* Minimal clicks
* Maximum automation
* Professional PDF generation
* Reliable Supabase integration
* Excellent maintainability
* Clean architecture
* Future scalability