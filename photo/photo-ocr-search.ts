/**
 * The search predicate over text recognised inside photos (#1029).
 *
 * Kept in its own module because photo.service needs it while
 * photo-ocr.service needs photo.service (for the photo's path on disk): a
 * static cycle between the two would deadlock boot, since both are
 * transitively async-initialised through db/database.ts. Same reason
 * scan-config.ts exists.
 */

import { sql } from "drizzle-orm";
import { photoOcr, photos } from "../db/schema";

/**
 * SQL predicate: this photo has recognised text matching `pattern`
 * (an ILIKE pattern, i.e. with its own `%` wildcards).
 *
 * ILIKE rather than the tsvector index, because a search token is a fragment
 * of a word as often as a whole one — "bahnhof" should find the
 * "Hauptbahnhof" on a sign. The GIN index exists for rank-ordered full-text
 * search, which the natural-language photo search does not do.
 */
export function ocrTextMatches(pattern: string) {
  return sql`EXISTS (
    SELECT 1 FROM ${photoOcr} po WHERE po.photo_id = ${photos.id} AND po.full_text ILIKE ${pattern}
  )`;
}
