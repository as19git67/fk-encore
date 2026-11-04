-- One-time cleanup of the auto-mined document category suggestions.
--
-- Since July every document that landed in "sonstiges" opened or grew a
-- suggestion for its sender, and nothing ever closed one: not when the
-- document got a real category, not when it was deleted. The list hid most of
-- them (below three examples), but they piled up by the hundreds.
--
-- Drop every example that no longer exists or is no longer in "sonstiges";
-- delete an auto-mined suggestion with no example left. Suggestions a user
-- proposed are untouched. From now on the daily taxonomy snapshot runs the
-- same sweep (pruneStaleCategorySuggestions in documents/suggestion-writer.ts).

WITH auto AS (
  SELECT s.id,
         s.example_document_ids AS old_ids,
         COALESCE(
           array_agg(e.doc_id ORDER BY e.ord) FILTER (WHERE c.slug = 'sonstiges'),
           '{}'::integer[]
         ) AS keep_ids
  FROM document_category_suggestions s
  LEFT JOIN LATERAL unnest(s.example_document_ids) WITH ORDINALITY AS e(doc_id, ord) ON true
  LEFT JOIN documents d ON d.id = e.doc_id
  LEFT JOIN document_categories c ON c.id = d.category_id
  WHERE s.status = 'open'
    AND (s.rationale LIKE 'auto-sender:%' OR s.rationale LIKE 'auto-mining:%')
  GROUP BY s.id
),
removed AS (
  DELETE FROM document_category_suggestions t
  USING auto
  WHERE t.id = auto.id AND cardinality(auto.keep_ids) = 0
  RETURNING t.id
)
UPDATE document_category_suggestions t
SET example_document_ids = auto.keep_ids
FROM auto
WHERE t.id = auto.id
  AND cardinality(auto.keep_ids) > 0
  AND auto.keep_ids <> auto.old_ids;
