-- Händler und Belegdatum sind keine Receipt-Spezialmetadaten: semantisch
-- entsprechen sie documents.sender und documents.doc_date. Bestehende
-- Dokumentwerte (insbesondere Nutzerkorrekturen) haben Vorrang; nur leere
-- Felder werden aus der bisherigen Receipt-Extraktion übernommen.
UPDATE documents AS d
SET
  sender = COALESCE(NULLIF(BTRIM(d.sender), ''), NULLIF(BTRIM(e.store), '')),
  doc_date = COALESCE(NULLIF(BTRIM(d.doc_date), ''), NULLIF(BTRIM(e.receipt_date), ''))
FROM document_receipt_extraction AS e
WHERE e.document_id = d.id
  AND (
    (NULLIF(BTRIM(d.sender), '') IS NULL AND NULLIF(BTRIM(e.store), '') IS NOT NULL)
    OR
    (NULLIF(BTRIM(d.doc_date), '') IS NULL AND NULLIF(BTRIM(e.receipt_date), '') IS NOT NULL)
  );

-- Receipt-Dokumente ohne manuell gepflegten Titel sollen in Liste, Suche und
-- Dateipfad nicht weiter nur als "image.pdf" erscheinen. Nutzergeprüfte
-- Attribute und bereits vorhandene Titel bleiben unverändert.
UPDATE documents
SET title = CASE
  WHEN NULLIF(BTRIM(sender), '') IS NOT NULL
    THEN LEFT('Kassenbeleg – ' || BTRIM(sender), 120)
  ELSE 'Kassenbeleg'
END
WHERE receipt_ocr_state IS NOT NULL
  AND attributes_reviewed = FALSE
  AND NULLIF(BTRIM(title), '') IS NULL;

ALTER TABLE document_receipt_extraction
  DROP COLUMN store,
  DROP COLUMN receipt_date;
