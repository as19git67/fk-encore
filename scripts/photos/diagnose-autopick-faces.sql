-- Diagnose: Auto-Pick-Trefferquote in Abhängigkeit von der Gesichtszahl.
--
-- READ-ONLY. Ausschließlich SELECTs, keine Schreibzugriffe, keine temporären
-- Tabellen. Ausgabe direkt auf der psql-Konsole.
--
-- Diese Datei ist die abhängigkeitsfreie Variante von
-- diagnose-autopick-faces.mjs: sie braucht weder Node noch das `pg`-Paket
-- noch einen ausgecheckten Repo-Klon auf dem Datenbank-Host — nur psql, das
-- im Postgres-Container ohnehin vorhanden ist.
--
--   docker compose exec -T postgres \
--     psql -U postgres -d encore -f - < scripts/photos/diagnose-autopick-faces.sql
--
-- Nur ein Nutzer statt aller: unten :'user_filter' via -v setzen, z. B.
--   ... psql -U postgres -d encore -v user_id=3 -f - < ...
-- Ohne -v werden alle Nutzer ausgewertet.
--
-- Hintergrund und Interpretation: siehe scripts/photos/README.md.

\set ON_ERROR_STOP on
\timing off
\pset border 2

-- Ohne -v user_id=... alle Nutzer auswerten (0 = kein Filter).
\if :{?user_id}
\else
  \set user_id 0
\endif

\echo ''
\echo '=== 0. Umfang der Auswertung ==================================='
\echo ''

SELECT
  COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL)                    AS reviewte_gruppen,
  COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL
                     AND ai_picked_photo_ids IS NOT NULL
                     AND array_length(ai_picked_photo_ids, 1) > 0)   AS davon_mit_pick,
  COUNT(*) FILTER (WHERE reviewed_at IS NULL)                        AS offene_gruppen
FROM photo_groups
WHERE (:user_id = 0 OR user_id = :user_id);

\echo ''
\echo '=== 1. Gespeicherte Kalibrierung ==============================='
\echo '(leer = keine kalibrierten Gewichte, es laufen die Defaults)'
\echo ''

SELECT user_id,
       fitted_at::date                                      AS fitted_at,
       round((metadata->>'top1_accuracy_face')::numeric, 3)          AS face_acc,
       round((metadata->>'top1_accuracy_face_baseline')::numeric, 3) AS face_baseline,
       round((metadata->>'top1_accuracy_non_face')::numeric, 3)      AS nonface_acc,
       round((metadata->>'top1_accuracy_non_face_baseline')::numeric, 3) AS nonface_baseline,
       metadata->>'pair_count_face'                         AS paare_face,
       metadata->>'pair_count_non_face'                     AS paare_nonface
FROM ai_pick_user_weights
WHERE (:user_id = 0 OR user_id = :user_id)
ORDER BY user_id;

\echo ''
\echo '=== 2. Trefferquote nach Anzahl Gesichter (Kernmessung) ========'
\echo 'Treffer = mindestens ein vom Pick vorgeschlagenes Foto wurde behalten.'
\echo 'Nur Gruppen, in denen der Nutzer wirklich etwas ausgeblendet hat.'
\echo ''

WITH grp AS (
  SELECT pg.id, pg.user_id, pg.ai_picked_photo_ids, pg.ai_picked_confidence
    FROM photo_groups pg
   WHERE pg.reviewed_at IS NOT NULL
     AND pg.ai_picked_photo_ids IS NOT NULL
     AND array_length(pg.ai_picked_photo_ids, 1) > 0
     AND (:user_id = 0 OR pg.user_id = :user_id)
),
-- Gesichtszahl je Foto: gezählt wie im Scoring (alle faces-Zeilen,
-- auch als "ignoriert" markierte).
face_stats AS (
  SELECT f.photo_id,
         COUNT(*)::int AS face_count,
         MAX(COALESCE((f.bbox::jsonb->>'width')::float, 0)
           * COALESCE((f.bbox::jsonb->>'height')::float, 0)) AS max_area,
         MIN(COALESCE((f.bbox::jsonb->>'width')::float, 0)
           * COALESCE((f.bbox::jsonb->>'height')::float, 0)) AS min_area
    FROM faces f
   GROUP BY f.photo_id
),
member AS (
  SELECT g.id AS group_id,
         g.ai_picked_confidence,
         gm.photo_id,
         COALESCE(fs.face_count, 0) AS face_count,
         (g.ai_picked_photo_ids @> ARRAY[gm.photo_id]) AS is_pick,
         -- Fehlende Kuratierung = nicht ausgeblendet = behalten.
         COALESCE(pc.status, 'visible') <> 'hidden'    AS kept
    FROM grp g
    JOIN photo_group_members gm ON gm.group_id = g.id
    LEFT JOIN photo_curation pc
           ON pc.photo_id = gm.photo_id AND pc.user_id = g.user_id
    LEFT JOIN face_stats fs ON fs.photo_id = gm.photo_id
),
per_group AS (
  SELECT group_id,
         MIN(ai_picked_confidence)                       AS confidence,
         MAX(face_count)                                 AS max_faces,
         COUNT(*)                                        AS members,
         COUNT(*) FILTER (WHERE NOT kept)                AS hidden_count,
         BOOL_OR(is_pick AND kept)                       AS hit
    FROM member
   GROUP BY group_id
),
bucketed AS (
  SELECT CASE
           WHEN max_faces <= 0 THEN '0 (ohne Gesicht)'
           WHEN max_faces = 1  THEN '1'
           WHEN max_faces = 2  THEN '2'
           WHEN max_faces <= 5 THEN '3-5'
           WHEN max_faces <= 15 THEN '6-15'
           ELSE '16+'
         END AS bucket,
         CASE
           WHEN max_faces <= 0 THEN 0 WHEN max_faces = 1 THEN 1
           WHEN max_faces = 2 THEN 2 WHEN max_faces <= 5 THEN 3
           WHEN max_faces <= 15 THEN 4 ELSE 5
         END AS sort_key,
         confidence, hit
    FROM per_group
   -- Gruppen ohne jede Ausblendung würden die Quote trivial nach oben
   -- verzerren: dort trifft jeder Pick.
   WHERE hidden_count > 0 AND members >= 2
)
SELECT bucket                                                   AS gesichter,
       COUNT(*)                                                 AS gruppen,
       COUNT(*) FILTER (WHERE hit)                              AS treffer,
       round(100.0 * COUNT(*) FILTER (WHERE hit) / COUNT(*), 1) AS quote_pct,
       COUNT(*) FILTER (WHERE confidence = 'high')              AS high_conf,
       round(100.0 * COUNT(*) FILTER (WHERE hit AND confidence = 'high')
             / NULLIF(COUNT(*) FILTER (WHERE confidence = 'high'), 0), 1)
                                                                AS quote_high_pct
FROM bucketed
GROUP BY bucket, sort_key
ORDER BY sort_key;

\echo ''
\echo 'Lesart: faellt quote_pct zu den hohen Buckets hin deutlich ab, ist die'
\echo 'min()-Aggregation das Problem. Bleibt sie flach, ist die These widerlegt.'
\echo 'quote_high_pct ist der wichtigere Wert - dort blendet der Batch-Abgleich'
\echo 'ungefragt aus.'

\echo ''
\echo '=== 3. Prominenz-Spreizung der Gesichter ======================='
\echo 'Verhaeltnis kleinstes/groesstes Gesicht je Foto (Flaeche).'
\echo 'Nahe 0 = ein winziges Hintergrundgesicht bestimmt face_sharpness.'
\echo ''

WITH face_stats AS (
  SELECT f.photo_id,
         COUNT(*)::int AS face_count,
         MAX(COALESCE((f.bbox::jsonb->>'width')::float, 0)
           * COALESCE((f.bbox::jsonb->>'height')::float, 0)) AS max_area,
         MIN(COALESCE((f.bbox::jsonb->>'width')::float, 0)
           * COALESCE((f.bbox::jsonb->>'height')::float, 0)) AS min_area
    FROM faces f
   GROUP BY f.photo_id
),
scoped AS (
  SELECT DISTINCT fs.photo_id, fs.face_count, fs.max_area, fs.min_area
    FROM face_stats fs
    JOIN photo_group_members gm ON gm.photo_id = fs.photo_id
    JOIN photo_groups pg ON pg.id = gm.group_id
   WHERE pg.reviewed_at IS NOT NULL
     AND (:user_id = 0 OR pg.user_id = :user_id)
     AND fs.face_count >= 2
     AND fs.max_area > 0
)
SELECT COUNT(*)                                                   AS fotos_mit_2plus,
       round(percentile_cont(0.5) WITHIN GROUP
             (ORDER BY min_area / max_area)::numeric, 3)          AS median_verhaeltnis,
       COUNT(*) FILTER (WHERE min_area / max_area < 0.25)         AS unter_0_25,
       COUNT(*) FILTER (WHERE min_area / max_area < 0.10)         AS unter_0_10,
       round(100.0 * COUNT(*) FILTER (WHERE min_area / max_area < 0.10)
             / NULLIF(COUNT(*), 0), 1)                            AS unter_0_10_pct
FROM scoped;

\echo ''
\echo '=== 4. Face-Zweig durch Mini-Detektionen ======================='
\echo 'face_count > 0 schaltet auf die Face-Formel (0.85 Gewicht auf'
\echo 'Gesichtssignalen) - auch wenn das groesste Gesicht winzig ist.'
\echo ''

WITH face_stats AS (
  SELECT f.photo_id,
         MAX(COALESCE((f.bbox::jsonb->>'width')::float, 0)
           * COALESCE((f.bbox::jsonb->>'height')::float, 0)) AS max_area
    FROM faces f
   GROUP BY f.photo_id
),
scoped AS (
  SELECT DISTINCT fs.photo_id, fs.max_area
    FROM face_stats fs
    JOIN photo_group_members gm ON gm.photo_id = fs.photo_id
    JOIN photo_groups pg ON pg.id = gm.group_id
   WHERE pg.reviewed_at IS NOT NULL
     AND (:user_id = 0 OR pg.user_id = :user_id)
)
SELECT COUNT(*)                                            AS fotos_im_face_zweig,
       COUNT(*) FILTER (WHERE max_area < 0.02)             AS groesstes_unter_2pct,
       COUNT(*) FILTER (WHERE max_area < 0.005)            AS groesstes_unter_0_5pct,
       round(100.0 * COUNT(*) FILTER (WHERE max_area < 0.005)
             / NULLIF(COUNT(*), 0), 1)                     AS unter_0_5pct_anteil
FROM scoped;

\echo ''
\echo '=== 5. Ignorierte Gesichter, die im Scoring mitzaehlen ========='
\echo 'loadSignalsForPhotos joint faces OHNE user_face_assignments.'
\echo ''

SELECT COUNT(*)                          AS ignorierte_gesichter,
       COUNT(DISTINCT f.photo_id)        AS betroffene_fotos
FROM user_face_assignments ufa
JOIN faces f ON f.id = ufa.face_id
WHERE ufa.ignored = TRUE
  AND (:user_id = 0 OR ufa.user_id = :user_id);

\echo ''
\echo '=== 6. Streuung je Gruppe: face_sharpness vs. blur ============='
\echo 'Springt face_sharpness zwischen fast identischen Aufnahmen staerker'
\echo 'als die globale Schaerfe, ist das die Signatur eines instabilen Minimums.'
\echo ''

WITH face_stats AS (
  SELECT f.photo_id, COUNT(*)::int AS face_count
    FROM faces f GROUP BY f.photo_id
),
grp AS (
  SELECT pg.id, pg.user_id, pg.ai_pick_details
    FROM photo_groups pg
   WHERE pg.reviewed_at IS NOT NULL
     AND pg.ai_pick_details IS NOT NULL
     AND (:user_id = 0 OR pg.user_id = :user_id)
),
scores AS (
  SELECT g.id AS group_id,
         (s->>'face_sharpness')::float AS fs_val,
         (s->>'blur')::float           AS blur_val
    FROM grp g
    CROSS JOIN LATERAL jsonb_array_elements(g.ai_pick_details->'scores') AS elem
    CROSS JOIN LATERAL (SELECT elem->'signals') AS sig(s)
   WHERE (elem->'signals'->>'face_sharpness') IS NOT NULL
     AND (elem->'signals'->>'blur') IS NOT NULL
),
per_group AS (
  SELECT sc.group_id,
         stddev_samp(sc.fs_val)   AS sd_face,
         stddev_samp(sc.blur_val) AS sd_blur,
         COUNT(*)                 AS members
    FROM scores sc
   GROUP BY sc.group_id
  HAVING COUNT(*) >= 2
),
with_faces AS (
  SELECT p.*,
         COALESCE(MAX(fs.face_count), 0) AS max_faces
    FROM per_group p
    JOIN photo_group_members gm ON gm.group_id = p.group_id
    LEFT JOIN face_stats fs ON fs.photo_id = gm.photo_id
   GROUP BY p.group_id, p.sd_face, p.sd_blur, p.members
),
bucketed AS (
  SELECT CASE
           WHEN max_faces <= 0 THEN '0 (ohne Gesicht)'
           WHEN max_faces = 1  THEN '1'
           WHEN max_faces = 2  THEN '2'
           WHEN max_faces <= 5 THEN '3-5'
           WHEN max_faces <= 15 THEN '6-15'
           ELSE '16+'
         END AS bucket,
         CASE
           WHEN max_faces <= 0 THEN 0 WHEN max_faces = 1 THEN 1
           WHEN max_faces = 2 THEN 2 WHEN max_faces <= 5 THEN 3
           WHEN max_faces <= 15 THEN 4 ELSE 5
         END AS sort_key,
         sd_face, sd_blur
    FROM with_faces
)
SELECT bucket                                                        AS gesichter,
       COUNT(*)                                                      AS gruppen,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY sd_face)::numeric, 3)
                                                                     AS median_sd_face,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY sd_blur)::numeric, 3)
                                                                     AS median_sd_blur,
       COUNT(*) FILTER (WHERE sd_blur < 0.01)                        AS sd_blur_unter_eps
FROM bucketed
GROUP BY bucket, sort_key
ORDER BY sort_key;

\echo ''
\echo 'Aussagekraeftig ist median_sd_face im Vergleich ueber die Buckets:'
\echo 'steigt der Wert mit der Gesichtszahl, springt das Minimum. Wo'
\echo 'sd_blur_unter_eps hoch ist, ist die globale Schaerfe praktisch konstant'
\echo '- dann ist ein Verhaeltnis der beiden Streuungen nicht aussagekraeftig.'
\echo ''
