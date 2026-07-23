-- Dokumenttyp-Erhebung (read-only) über den bestehenden Korpus.
--
-- Zweck: Vor Einführung der Dokumenttyp-Facette (Stufe B) empirisch prüfen, ob
-- das vorgeschlagene Vokabular die real vorkommenden Dokumentarten abdeckt.
-- Heuristisch (Schlüsselwörter in Titel + Zusammenfassung + Tags) — NICHT als
-- exakte Typisierung gedacht, sondern nur zur *Abdeckungs-/Lückenmessung*.
-- Überlappungen sind erlaubt (ein Dokument kann auf mehrere Muster passen);
-- entscheidend ist der "uncovered"-Rest, der auf fehlende Typen hinweist.
--
-- Ausführen (read-only):
--   psql "$POSTGRES_CONNECTION_STRING" -f scripts/taxonomy/document_type_survey.sql
--   -- oder: psql -h localhost -U postgres -d fk_encore -f <diese Datei>

\echo '=== 1) Abdeckung nach Dokumenttyp (Überlappungen erlaubt) ==='

WITH base AS (
  SELECT
    id,
    title,
    lower(
      coalesce(title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(tags_text, '')
    ) AS txt
  FROM documents
  -- nur klassifizierte Dokumente mit auswertbarem Inhalt
  WHERE coalesce(title, '') <> '' OR coalesce(summary, '') <> ''
),
flags AS (
  SELECT
    id,
    title,
    (txt ~* 'police|versicherungsschein|(^| )vertrag|vertrags|vereinbarung|mandatsvereinbarung') AS vertrag,
    (txt ~* 'rechnung|mahnung|zahlungserinnerung')                                                AS rechnung,
    (txt ~* 'abrechnung|kontoauszug|nebenkosten|erträgnisaufstellung|gehaltsabrechnung|entgeltabrechnung|lohnabrechnung') AS abrechnung,
    (txt ~* 'bescheid|festsetzung')                                                               AS bescheid,
    (txt ~* 'bescheinigung|nachweis|zertifikat|bestätigung|garantie|gewährleistung')              AS bescheinigung,
    (txt ~* 'mitteilung|information|anschreiben|standmitteilung|benachrichtigung|hinweis')         AS mitteilung,
    (txt ~* 'urkunde|zeugnis|diplom')                                                             AS urkunde,
    (txt ~* 'antrag|formular|fragebogen|anmeldung|einwilligung|einverständnis')                   AS antrag,
    (txt ~* 'arztbrief|befund|(^| )bericht|protokoll|gutachten|laborwert|entlassungsbericht')      AS bericht,
    (txt ~* 'schreiben|korrespondenz|widerspruch|kündigung|(^| )brief')                           AS korrespondenz,
    (txt ~* 'beleg|kassenbon|quittung')                                                           AS beleg,
    (txt ~* 'anleitung|handbuch|merkblatt|satzung|betriebsanleitung')                             AS anleitung
  FROM base
)
SELECT typ, treffer,
       round(100.0 * treffer / nullif((SELECT count(*) FROM flags), 0), 1) AS prozent
FROM (
  SELECT 'vertrag'       AS typ, count(*) FILTER (WHERE vertrag)       AS treffer FROM flags
  UNION ALL SELECT 'rechnung',      count(*) FILTER (WHERE rechnung)      FROM flags
  UNION ALL SELECT 'abrechnung',    count(*) FILTER (WHERE abrechnung)    FROM flags
  UNION ALL SELECT 'bescheid',      count(*) FILTER (WHERE bescheid)      FROM flags
  UNION ALL SELECT 'bescheinigung', count(*) FILTER (WHERE bescheinigung) FROM flags
  UNION ALL SELECT 'mitteilung',    count(*) FILTER (WHERE mitteilung)    FROM flags
  UNION ALL SELECT 'urkunde',       count(*) FILTER (WHERE urkunde)       FROM flags
  UNION ALL SELECT 'antrag',        count(*) FILTER (WHERE antrag)        FROM flags
  UNION ALL SELECT 'bericht',       count(*) FILTER (WHERE bericht)       FROM flags
  UNION ALL SELECT 'korrespondenz', count(*) FILTER (WHERE korrespondenz) FROM flags
  UNION ALL SELECT 'beleg',         count(*) FILTER (WHERE beleg)         FROM flags
  UNION ALL SELECT 'anleitung',     count(*) FILTER (WHERE anleitung)     FROM flags
) s
ORDER BY treffer DESC;

\echo ''
\echo '=== 2) Abdeckungs-Zusammenfassung (0 Typen = Lücke) ==='

WITH base AS (
  SELECT id,
    lower(coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(tags_text,'')) AS txt
  FROM documents
  WHERE coalesce(title,'') <> '' OR coalesce(summary,'') <> ''
),
counts AS (
  SELECT id,
    (txt ~* 'police|versicherungsschein|(^| )vertrag|vertrags|vereinbarung|mandatsvereinbarung')::int
  + (txt ~* 'rechnung|mahnung|zahlungserinnerung')::int
  + (txt ~* 'abrechnung|kontoauszug|nebenkosten|erträgnisaufstellung|gehaltsabrechnung|entgeltabrechnung|lohnabrechnung')::int
  + (txt ~* 'bescheid|festsetzung')::int
  + (txt ~* 'bescheinigung|nachweis|zertifikat|bestätigung|garantie|gewährleistung')::int
  + (txt ~* 'mitteilung|information|anschreiben|standmitteilung|benachrichtigung|hinweis')::int
  + (txt ~* 'urkunde|zeugnis|diplom')::int
  + (txt ~* 'antrag|formular|fragebogen|anmeldung|einwilligung|einverständnis')::int
  + (txt ~* 'arztbrief|befund|(^| )bericht|protokoll|gutachten|laborwert|entlassungsbericht')::int
  + (txt ~* 'schreiben|korrespondenz|widerspruch|kündigung|(^| )brief')::int
  + (txt ~* 'beleg|kassenbon|quittung')::int
  + (txt ~* 'anleitung|handbuch|merkblatt|satzung|betriebsanleitung')::int AS n_typen
  FROM base
)
SELECT
  CASE WHEN n_typen = 0 THEN '0 (LÜCKE — kein Typ)'
       WHEN n_typen = 1 THEN '1 (eindeutig)'
       WHEN n_typen = 2 THEN '2 (mehrdeutig)'
       ELSE '3+ (stark mehrdeutig)' END AS treffer_typen,
  count(*) AS dokumente,
  round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS prozent
FROM counts
GROUP BY 1
ORDER BY 1;

\echo ''
\echo '=== 3) Stichprobe der NICHT abgedeckten Dokumente (zeigt fehlende Typen) ==='

WITH base AS (
  SELECT id, title,
    lower(coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(tags_text,'')) AS txt
  FROM documents
  WHERE coalesce(title,'') <> '' OR coalesce(summary,'') <> ''
)
SELECT title
FROM base
WHERE NOT (
     txt ~* 'police|versicherungsschein|(^| )vertrag|vertrags|vereinbarung|mandatsvereinbarung'
  OR txt ~* 'rechnung|mahnung|zahlungserinnerung'
  OR txt ~* 'abrechnung|kontoauszug|nebenkosten|erträgnisaufstellung|gehaltsabrechnung|entgeltabrechnung|lohnabrechnung'
  OR txt ~* 'bescheid|festsetzung'
  OR txt ~* 'bescheinigung|nachweis|zertifikat|bestätigung|garantie|gewährleistung'
  OR txt ~* 'mitteilung|information|anschreiben|standmitteilung|benachrichtigung|hinweis'
  OR txt ~* 'urkunde|zeugnis|diplom'
  OR txt ~* 'antrag|formular|fragebogen|anmeldung|einwilligung|einverständnis'
  OR txt ~* 'arztbrief|befund|(^| )bericht|protokoll|gutachten|laborwert|entlassungsbericht'
  OR txt ~* 'schreiben|korrespondenz|widerspruch|kündigung|(^| )brief'
  OR txt ~* 'beleg|kassenbon|quittung'
  OR txt ~* 'anleitung|handbuch|merkblatt|satzung|betriebsanleitung'
)
ORDER BY random()
LIMIT 60;
