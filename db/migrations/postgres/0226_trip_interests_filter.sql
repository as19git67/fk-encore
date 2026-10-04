-- The interest ticks became a filter (2026-10-04).
--
-- Until now a ticked interest raised a spot's score and excluded nothing,
-- and the interpreter's category list narrowed the search invisibly.
-- Read as a filter, old ticks would narrow trips nobody meant to narrow,
-- and old category lists would keep narrowing from a place nobody can
-- see. Both go; every existing trip searches everything, which is what
-- its screen will show. The free text the interpreter stored under
-- interests ("barock") goes with it: it never matched anything.
UPDATE trip_plans
   SET constraints = (constraints - 'interests') - 'categories'
 WHERE constraints ?| array['interests', 'categories'];
