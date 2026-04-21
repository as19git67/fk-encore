-- Backfill `photos.location_city` / `location_country` (plus the two derived
-- display columns) for rows written before the exifr IPTC producer-boundary
-- fix. Historical imports ran ``getExifMetadata()`` through a version of
-- exifr that decodes IPTC strings as Latin-1 unconditionally, so anything
-- that originally contained a two-byte UTF-8 codepoint (ä/ö/ü/ß etc.) ended
-- up stored as its mojibake form — e.g. "BrÃ¼ssel" instead of "Brüssel".
--
-- The repair reinterprets the affected UTF-8 string's codepoints as Latin-1
-- bytes and re-decodes them as UTF-8. A round-trip that succeeds and does
-- not introduce the replacement char (U+FFFD) is accepted; otherwise the
-- original is kept. Equivalent to the JS ``repairMojibake()`` helper in
-- ``photo/text-encoding.ts`` and the Python ``_repair_mojibake`` in
-- ``llm-service/main.py``.
--
-- The regex literal uses ``E'...'`` so ``Â``..``¿`` are expanded
-- to the actual codepoints by the Postgres string scanner before the regex
-- engine ever sees them — otherwise ``[-¿]`` would be read as
-- three literals (the control char, a hyphen, ``¿``) instead of a range.

CREATE OR REPLACE FUNCTION pg_temp.repair_mojibake(input text) RETURNS text AS $$
DECLARE
  repaired text;
BEGIN
  IF input IS NULL OR input = '' THEN
    RETURN input;
  END IF;
  -- Classic UTF-8-as-Latin-1 signature: a 0xC2/0xC3 lead-byte char followed
  -- by another char in the 0x80..0xBF continuation-byte range.
  IF input !~ E'[ÂÃ][-¿]' THEN
    RETURN input;
  END IF;
  BEGIN
    repaired := convert_from(convert_to(input, 'LATIN1'), 'UTF8');
  EXCEPTION WHEN OTHERS THEN
    -- convert_to raises when the input contains chars outside Latin-1 (e.g.
    -- an emoji that sneaked into a tag); in that case the string is not
    -- Latin-1-round-trippable and therefore not the mojibake we're after.
    RETURN input;
  END;
  IF position(U&'\+00FFFD' in repaired) > 0 THEN
    RETURN input;
  END IF;
  RETURN repaired;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE photos
   SET location_city    = pg_temp.repair_mojibake(location_city),
       location_country = pg_temp.repair_mojibake(location_country),
       location_name    = pg_temp.repair_mojibake(location_name),
       location_short   = pg_temp.repair_mojibake(location_short)
 WHERE location_city    ~ E'[ÂÃ][-¿]'
    OR location_country ~ E'[ÂÃ][-¿]'
    OR location_name    ~ E'[ÂÃ][-¿]'
    OR location_short   ~ E'[ÂÃ][-¿]';
