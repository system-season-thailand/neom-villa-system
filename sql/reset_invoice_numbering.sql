-- =============================================================================
-- reset_invoice_numbering.sql
-- Neom Villa staff console — ONE-TIME, DESTRUCTIVE reset of neom_pdf.
--
-- ⚠ THIS PERMANENTLY DELETES EVERY ROW IN neom_pdf — every saved invoice and
-- every revision of every invoice. There is no undo once this runs. If
-- there's any chance you'll want this data again, export/back up the table
-- first (Supabase → Table Editor → neom_pdf → Export).
--
-- Not part of the numbered 001–011 setup sequence — this is a manual,
-- run-it-only-when-you-actually-mean-it script, not something run once
-- during initial setup. Run it directly in the Supabase SQL Editor.
--
-- After this runs, the next invoice saved from the app is numbered
-- INV-<current year>-0125 (not -0001) — everything after that continues
-- sequentially from there (0126, 0127, …).
-- =============================================================================

TRUNCATE TABLE neom_pdf;

-- RESTART WITH 125 means the very next nextval() call (i.e. the next invoice
-- actually saved) returns 125 — it does not skip ahead to 126. This also
-- makes peek_next_invoice_number() immediately preview "0125" without
-- consuming it, since RESTART resets the sequence's is_called flag to false.
ALTER SEQUENCE neom_invoice_number_seq RESTART WITH 125;
