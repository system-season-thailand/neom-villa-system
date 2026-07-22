-- =============================================================================
-- 007_enable_availability_realtime.sql
-- Neom Villa staff console — turns on Supabase Realtime for neom_availability.
--
-- Without this, the Availability calendar still works normally on every
-- device (each still fetches statuses itself on load/navigate) — this just
-- adds the live layer on top: a status change made on one device shows up on
-- every other device that currently has the calendar open, with no manual
-- refresh needed.
--
-- Run this once, after 006_add_booked_by.sql. Safe to re-run — ALTER
-- PUBLICATION ... ADD TABLE errors on a table that's already a member, so
-- this checks first rather than relying on IF NOT EXISTS (which that
-- statement doesn't support).
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'neom_availability'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE neom_availability;
  END IF;
END $$;
