-- The travel group is the trip's accounts, plus whoever has none (§3.5).
--
-- The group used to draw on two lists that describe people twice: the
-- accounts that plan the trip, and the organiser's household from the
-- documents module. Every adult with a login is in both — as "Erika"
-- (the account) and as "Erika Beispiel (Ehefrau)" (the household) —
-- and the screen kept offering them twice, because the only join
-- between the lists was a name.
--
-- Now there is one rule: whoever plans the trip is on it. An account
-- on the trip has a row here with `added_for_user_id` set, made and
-- removed with the invitation. Everybody without an account — a child,
-- a grandmother from elsewhere — is entered by hand, with a name and,
-- if known, a birth date. The household link goes.

-- A household entry's birth date lived in the household; keep it on
-- the row before the link is cut, so the age still plans the day.
UPDATE trip_plan_travellers t
SET birth_date = COALESCE(t.birth_date, to_char(p.birth_date, 'YYYY-MM-DD'))
FROM user_subject_persons p
WHERE t.subject_person_id = p.id;

-- Dropping the column drops its partial unique index with it.
ALTER TABLE trip_plan_travellers DROP COLUMN IF EXISTS subject_person_id;

-- Everybody who plans an existing trip is on it from now on. Rows for
-- accounts that are already there stay as they are (the unique index
-- on plan_id, added_for_user_id says which those are).
INSERT INTO trip_plan_travellers (plan_id, added_for_user_id, label, added_by)
SELECT p.id, p.owner_id, COALESCE(u.name, u.email), p.owner_id
FROM trip_plans p
JOIN users u ON u.id = p.owner_id
ON CONFLICT (plan_id, added_for_user_id) WHERE added_for_user_id IS NOT NULL DO NOTHING;

INSERT INTO trip_plan_travellers (plan_id, added_for_user_id, label, added_by)
SELECT s.plan_id, s.user_id, COALESCE(u.name, u.email), s.invited_by
FROM trip_plan_shares s
JOIN users u ON u.id = s.user_id
ON CONFLICT (plan_id, added_for_user_id) WHERE added_for_user_id IS NOT NULL DO NOTHING;
