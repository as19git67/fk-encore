-- A chapter of several days gives its dates without the number of days
-- ("1.–3. Juni 2024", not "3 Tage, 1.–3. Juni 2024").
UPDATE "photo_book_chapter"
SET "subtitle" = regexp_replace("subtitle", '^[0-9]+ Tage, ', '')
WHERE "subtitle" ~ '^[0-9]+ Tage, ';
--> statement-breakpoint
-- A chapter of one day says the hours it covers ("Montag, 3. Juni 2024,
-- 10:15–17:40 Uhr"), as photo-book-layout.ts writes it for new books. Only
-- subtitles still in the rule's day form get the hours; one changed by hand stays.
UPDATE "photo_book_chapter"
SET "subtitle" = "subtitle" || ', ' ||
  CASE WHEN to_char("starts_at", 'HH24:MI') = to_char("ends_at", 'HH24:MI')
    THEN to_char("starts_at", 'HH24:MI')
    ELSE to_char("starts_at", 'HH24:MI') || '–' || to_char("ends_at", 'HH24:MI')
  END || ' Uhr'
WHERE "subtitle" ~ '^(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag), [0-9]{1,2}\. [^ ,]+ [0-9]{4}$'
  AND "starts_at" IS NOT NULL AND "ends_at" IS NOT NULL
  AND "starts_at"::date = "ends_at"::date
  AND to_char("starts_at", 'HH24:MI') <> '00:00'
  AND to_char("ends_at", 'HH24:MI') <> '00:00';
