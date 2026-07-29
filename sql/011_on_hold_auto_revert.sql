-- =============================================================================
-- 011_on_hold_auto_revert.sql
-- Neom Villa staff console — automatically reverts an On Hold date back to
-- Available 24 hours after it was put on hold, with no one needing to have
-- the app open for it to happen.
--
-- Run this AFTER 010_add_on_hold_at.sql. Requires the pg_cron extension —
-- if CREATE EXTENSION below fails with a permissions error, enable it first
-- from the Supabase dashboard: Database → Extensions → search "pg_cron" →
-- Enable, then re-run this file. Safe to re-run either way (the unschedule
-- step below means re-running never creates a duplicate job).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule any previous run of this same job first, by name, so
-- re-running this file replaces it instead of stacking up duplicates.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'neom_availability_revert_expired_on_hold';

-- Every 5 minutes: 'available' is never stored as a row (see
-- 009_stop_storing_available.sql), so "revert to Available" means deleting
-- the row outright — the same thing clearStatus()/the app's own "Passed"
-- revert option already does — rather than writing status = 'available',
-- which the table's check constraint no longer even allows.
SELECT cron.schedule(
  'neom_availability_revert_expired_on_hold',
  '*/5 * * * *',
  $$DELETE FROM neom_availability WHERE status = 'on_hold' AND on_hold_at <= now() - interval '24 hours'$$
);
