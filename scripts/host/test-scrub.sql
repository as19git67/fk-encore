-- Scrub of the test stack's copy of production
-- (documentation/plans/dev-system.md, "Scrub").
--
-- Run by test-refresh.sh on the freshly cloned main database, before the
-- test app starts on it. Removes from the copy what points at a real
-- person, device or account outside the host: push and device tokens,
-- sessions, bank logins, public links, and the jobs that would act on
-- their own. The data itself (photos, documents, bookings) stays — that is
-- what the copy is for.
--
-- One transaction. A table the copy does not have yet (it is older than the
-- code that added it) is skipped; a missing column fails, so this file is
-- fixed rather than half applied. Plain SQL without psql meta-commands, so
-- the test suite can run it too (scripts/test-stack.test.ts).

BEGIN;

CREATE FUNCTION pg_temp.scrub(tbl text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.' || tbl) IS NULL THEN
    RAISE NOTICE 'scrub: % does not exist, skipped', tbl;
    RETURN;
  END IF;
  EXECUTE stmt;
END $$;

-- Push and devices: nothing the test app sends reaches a phone of prod.
SELECT pg_temp.scrub('push_subscriptions', 'DELETE FROM push_subscriptions');
SELECT pg_temp.scrub('guest_push_subscriptions', 'DELETE FROM guest_push_subscriptions');
SELECT pg_temp.scrub('apns_device_tokens', 'DELETE FROM apns_device_tokens');

-- Sessions and one-time tokens: everyone signs in to test afresh.
SELECT pg_temp.scrub('sessions', 'DELETE FROM sessions');
SELECT pg_temp.scrub('refresh_tokens', 'DELETE FROM refresh_tokens');
SELECT pg_temp.scrub('guest_sessions', 'DELETE FROM guest_sessions');
SELECT pg_temp.scrub('auth_handover_tokens', 'DELETE FROM auth_handover_tokens');
SELECT pg_temp.scrub('password_reset_tokens', 'DELETE FROM password_reset_tokens');

-- Banks: no login, and no bank-assigned system id that a second client
-- would present as its own.
SELECT pg_temp.scrub('finance_bankcontact',
  'UPDATE finance_bankcontact SET credentials_encrypted = NULL, banking_information = NULL, sync_times = ''[]''::jsonb');

-- Price watches: paused, so no search is spent and no alert goes out.
SELECT pg_temp.scrub('travel_hotel_watch', 'UPDATE travel_hotel_watch SET paused = true');
SELECT pg_temp.scrub('travel_flight_watch', 'UPDATE travel_flight_watch SET paused = true');

-- Exports and links: no scheduled mail, no public link that answers from test.
SELECT pg_temp.scrub('collection_schedules', 'UPDATE collection_schedules SET enabled = false');
SELECT pg_temp.scrub('album_public_links', 'DELETE FROM album_public_links');
SELECT pg_temp.scrub('collection_public_links', 'DELETE FROM collection_public_links');

-- Photos: the nightly aesthetic run would lend prod's GPU.
SELECT pg_temp.scrub('photo_aesthetic_settings', 'UPDATE photo_aesthetic_settings SET enabled = false');

-- Jobs that act outward on their own. Switched off, not deleted: the admin
-- page (Admin › Jobs) shows them and one can be switched on by hand for a
-- test. A row is created for a job that never ran on prod, so it starts off
-- too. Keep in step with the outbound jobs of the plan.
SELECT pg_temp.scrub('scheduled_job_state', $q$
  INSERT INTO scheduled_job_state (name, enabled)
  SELECT name, false FROM unnest(ARRAY[
    'finance-sync-statements',
    'finance-news-refresh',
    'travel-hotel-watches',
    'travel-flight-watches',
    'collections-schedules',
    'documents-follow-ups-process-due',
    'guest-digest',
    'trip-planner-live-activities',
    'photo-aesthetic-nightly',
    'meter-petrol-prices'
  ]) AS name
  ON CONFLICT (name) DO UPDATE SET enabled = false, updated_at = now()
$q$);

COMMIT;
