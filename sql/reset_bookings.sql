-- =============================================================================
-- reset_bookings.sql
-- Neom Villa staff console — ONE-TIME, DESTRUCTIVE reset of every booking
-- and linked-stay marker, for starting fresh right before going to
-- production.
--
-- ⚠ THIS PERMANENTLY DELETES EVERY ROW IN neom_availability AND
-- neom_linked_stays — every Booked/On Hold/Blocked date and every "must be
-- booked together" group. There is no undo once this runs. If there's any
-- chance you'll want this data again, export/back up both tables first
-- (Supabase → Table Editor → neom_availability / neom_linked_stays →
-- Export).
--
-- Not part of the numbered 001–011 setup sequence — this is a manual,
-- run-it-only-when-you-actually-mean-it script, not something run once
-- during initial setup. Run it directly in the Supabase SQL Editor.
--
-- After this runs, every date shows as Available again — neom_availability
-- is sparse by design (see 003_create_neom_availability.sql /
-- 009_stop_storing_available.sql), so an empty table already means
-- "everything is Available"; there is nothing else to reset for that to be
-- true. neom_price (pricing rules) and neom_pdf (invoices) are untouched.
-- =============================================================================

TRUNCATE TABLE neom_availability;
TRUNCATE TABLE neom_linked_stays;
