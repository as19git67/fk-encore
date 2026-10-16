/**
 * Where a value stands in documents, from the word positions text extraction
 * keeps (#1531, #1532). Shared by `find_text_in_document` and by the
 * `create_collection` proposal, which turns the boxes into redactions: the
 * server finds the rectangles, the model only names what to black out.
 */

import { documents } from "~encore/clients";

export interface Box {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DocumentHits {
  document_id: number;
  /** "no_words": extracted before positions were kept; nothing to find yet. */
  status: "ok" | "no_words" | "not_found";
  boxes: Box[];
  pages: number[];
}

/** One call per document and query, through the documents service's own check. */
export async function findInDocuments(ids: readonly number[], queries: readonly string[]): Promise<DocumentHits[]> {
  const out: DocumentHits[] = [];
  for (const id of ids) {
    const boxes: Box[] = [];
    let status: DocumentHits["status"] = "ok";
    for (const q of queries) {
      try {
        const res = (await documents.findDocumentTextBoxes({ id, q })) as unknown as { status: "ok" | "no_words"; boxes: Box[] };
        if (res.status === "no_words") {
          status = "no_words";
          break;
        }
        boxes.push(...res.boxes);
      } catch (err) {
        if ((err as { code?: string }).code === "not_found") {
          status = "not_found";
          break;
        }
        throw err;
      }
    }
    out.push({
      document_id: id,
      status,
      boxes: status === "ok" ? dedupe(boxes) : [],
      pages: status === "ok" ? [...new Set(boxes.map((b) => b.page))].sort((a, b) => a - b) : [],
    });
  }
  return out;
}

/** Two queries can find the same spot ("450.000" and "450.000,00 EUR"). */
function dedupe(boxes: Box[]): Box[] {
  const seen = new Set<string>();
  return boxes.filter((b) => {
    const key = `${b.page}:${b.x}:${b.y}:${b.w}:${b.h}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pageCount(hits: readonly DocumentHits[]): number {
  return hits.reduce((n, h) => n + h.pages.length, 0);
}
