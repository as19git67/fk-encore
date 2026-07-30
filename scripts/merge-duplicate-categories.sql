-- Merge duplicate document_categories rows: same name (case-/whitespace-
-- insensitive) under the same parent. Root cause: acceptCategorySuggestion
-- only checked for a slug collision, not a name collision, so accepting a
-- suggestion whose auto-derived slug didn't match an existing category could
-- create a second row with an identical name (e.g. two "Betriebliche
-- Unterlagen" under "Beruf"). That gap is now fixed in code; this script
-- cleans up rows that already exist.
--
-- Strategy: for each (parent_id, lower(trim(name))) group with more than one
-- row, keep the row with the lowest id as canonical ("winner") and fold every
-- other row ("loser") into it:
--   1. Repoint documents.category_id from loser -> winner.
--   2. Repoint document_categories.parent_id from loser -> winner (in case a
--      loser unexpectedly had children of its own).
--   3. Delete the loser rows.
--
-- Run the two SELECTs first to see exactly what will change. Nothing is
-- written until the UPDATE/DELETE statements run, and the whole thing is
-- wrapped in a transaction — if the preview looks wrong, ROLLBACK.

BEGIN;

-- ── 1. Preview: which categories are duplicates? ────────────────────────────
WITH dupes AS (
  SELECT
    id,
    slug,
    name,
    parent_id,
    row_number() OVER (
      PARTITION BY parent_id, lower(trim(name))
      ORDER BY id
    ) AS rn
  FROM document_categories
)
SELECT
  d.parent_id,
  p.name  AS parent_name,
  d.id,
  d.slug,
  d.name,
  CASE WHEN d.rn = 1 THEN 'KEEP (winner)' ELSE 'MERGE INTO WINNER' END AS action
FROM dupes d
LEFT JOIN document_categories p ON p.id = d.parent_id
WHERE (d.parent_id, lower(trim(d.name))) IN (
  SELECT parent_id, lower(trim(name))
  FROM document_categories
  GROUP BY parent_id, lower(trim(name))
  HAVING count(*) > 1
)
ORDER BY d.parent_id NULLS FIRST, lower(trim(d.name)), d.rn;

-- ── 2. Preview: how many documents would be repointed? ──────────────────────
WITH dupes AS (
  SELECT
    id,
    parent_id,
    name,
    first_value(id) OVER (
      PARTITION BY parent_id, lower(trim(name))
      ORDER BY id
    ) AS winner_id
  FROM document_categories
)
SELECT d.id AS loser_id, d.winner_id, count(doc.id) AS documents_to_repoint
FROM dupes d
JOIN documents doc ON doc.category_id = d.id
WHERE d.id <> d.winner_id
GROUP BY d.id, d.winner_id
ORDER BY d.id;

-- ── 3. The actual merge ──────────────────────────────────────────────────────
WITH dupes AS (
  SELECT
    id,
    parent_id,
    name,
    first_value(id) OVER (
      PARTITION BY parent_id, lower(trim(name))
      ORDER BY id
    ) AS winner_id
  FROM document_categories
),
losers AS (
  SELECT id AS loser_id, winner_id FROM dupes WHERE id <> winner_id
)
UPDATE documents
SET category_id = losers.winner_id
FROM losers
WHERE documents.category_id = losers.loser_id;

WITH dupes AS (
  SELECT
    id,
    parent_id,
    name,
    first_value(id) OVER (
      PARTITION BY parent_id, lower(trim(name))
      ORDER BY id
    ) AS winner_id
  FROM document_categories
),
losers AS (
  SELECT id AS loser_id, winner_id FROM dupes WHERE id <> winner_id
)
UPDATE document_categories
SET parent_id = losers.winner_id
FROM losers
WHERE document_categories.parent_id = losers.loser_id;

WITH dupes AS (
  SELECT
    id,
    parent_id,
    name,
    first_value(id) OVER (
      PARTITION BY parent_id, lower(trim(name))
      ORDER BY id
    ) AS winner_id
  FROM document_categories
)
DELETE FROM document_categories
WHERE id IN (SELECT id FROM dupes WHERE id <> winner_id);

-- Review the row counts/messages above. If everything looks right:
COMMIT;
-- If anything looks wrong, run ROLLBACK; instead of COMMIT;.
