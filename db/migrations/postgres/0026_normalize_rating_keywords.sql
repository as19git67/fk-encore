-- Normalise "Rating N" (with space) keyword entries, produced by earlier
-- versions of the library import, to the hyphenated "Rating-N" form that the
-- natural search tokeniser treats as a single token.
UPDATE photos
SET keywords = ARRAY(
  SELECT CASE
           WHEN k ~* '^rating\s+[1-5]$'
             THEN 'Rating-' || substring(k from '[1-5]$')
           ELSE k
         END
  FROM unnest(keywords) AS k
)
WHERE EXISTS (
  SELECT 1 FROM unnest(keywords) AS k WHERE k ~* '^rating\s+[1-5]$'
);
