/**
 * Document read tools. The documents service checks `module.documents`,
 * `documents.view` and the per-document visibility on every call.
 */

import { documents } from "~encore/clients";
import { digestOf, int, isoDate, query, str, table } from "../format";
import type { ToolSpec } from "../types";

const DOCUMENTS = ["module.documents", "documents.view"];

interface Category { id: number; slug: string; name: string; parent_id: number | null }
interface DocumentSummary {
  id: number; title: string | null; original_filename?: string; doc_date: string | null;
  sender?: string | null; correspondent_display?: string | null; category_slug?: string | null;
  reference_numbers?: unknown;
}
interface DocumentDetail extends DocumentSummary {
  summary?: string | null; tags?: string[]; document_type?: string | null; tax_year?: number | null;
}

function docTitle(d: DocumentSummary): string {
  return d.title ?? d.original_filename ?? `#${d.id}`;
}

export const listCategories: ToolSpec = {
  name: "list_categories",
  kind: "read",
  summary: "Document categories as slug and path; pass a slug to search_documents to narrow a search.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: { type: "object", properties: {} },
  async run() {
    const res = await (documents.listDocumentCategories()) as unknown as { items: Category[] };
    const byId = new Map(res.items.map((c) => [c.id, c]));
    const path = (c: Category): string => {
      const names = [c.name];
      let parent = c.parent_id !== null ? byId.get(c.parent_id) : undefined;
      for (let guard = 0; parent && guard < 10; guard++) {
        names.unshift(parent.name);
        parent = parent.parent_id !== null ? byId.get(parent.parent_id) : undefined;
      }
      return names.join(" › ");
    };
    return {
      text: table(["slug", "path"], res.items.map((c) => [c.slug, path(c)]), { cap: 250 }),
      digest: `[earlier result of list_categories: ${res.items.length} categories]`,
      rowCount: res.items.length,
    };
  },
};

export const searchDocuments: ToolSpec = {
  name: "search_documents",
  kind: "read",
  summary: "Hybrid full-text and semantic document search, optionally narrowed to a category slug and a document date range.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "what the documents are about" },
      category: { type: "string", description: "category slug from list_categories" },
      date_from: { type: "string", description: "document date from, YYYY-MM-DD" },
      date_to: { type: "string", description: "document date to, YYYY-MM-DD" },
      limit: { type: "integer", description: "at most 25 (default 15)" },
    },
    required: ["q"],
  },
  async run(args) {
    const q = str(args.q);
    if (!q) throw new Error("q is required");
    const category = str(args.category);
    const dateFrom = isoDate(args.date_from);
    const dateTo = isoDate(args.date_to);
    const limit = int(args.limit, { min: 1, max: 25 }) ?? 15;
    const res = await (documents.searchDocumentsEndpoint({
      q, mode: "hybrid", category, date_from: dateFrom, date_to: dateTo, limit,
    })) as unknown as { items: DocumentSummary[] };
    const rows = res.items;
    return {
      text: table(
        ["id", "date", "title", "from", "category"],
        rows.map((d) => [d.id, d.doc_date?.slice(0, 10), docTitle(d), d.correspondent_display ?? d.sender, d.category_slug]),
        { cap: limit, note: "Ranked by relevance; the list may hold near misses — say which ones fit." },
      ),
      digest: digestOf("search_documents", rows.length, rows.map((d) => d.id)),
      rowCount: rows.length,
      ref: { type: "document", ids: rows.map((d) => d.id) },
      block: {
        kind: "documents",
        tool: "search_documents",
        rows: rows.map((d) => ({
          id: d.id, title: docTitle(d), doc_date: d.doc_date, from: d.correspondent_display ?? d.sender ?? null, category: d.category_slug ?? null,
        })),
        route: `/dokumente${query({ q, category, dateFrom, dateTo })}`,
      },
    };
  },
};

export const getDocumentSummary: ToolSpec = {
  name: "get_document_summary",
  kind: "read",
  summary: "One document's title, date, sender, category, tags, reference numbers and summary.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: { id: { type: "integer", description: "document id" } },
    required: ["id"],
  },
  async run(args) {
    const id = int(args.id);
    if (id === undefined) throw new Error("id is required");
    const d = await (documents.getDocument({ id })) as unknown as DocumentDetail;
    const refs = Array.isArray(d.reference_numbers)
      ? (d.reference_numbers as Array<{ value?: string; kind?: string }>).map((r) => `${r.kind ?? "ref"} ${r.value ?? ""}`.trim()).join("; ")
      : "";
    const text = [
      `id: ${d.id}`,
      `title: ${docTitle(d)}`,
      `date: ${d.doc_date ?? "-"}`,
      `from: ${d.correspondent_display ?? d.sender ?? "-"}`,
      `category: ${d.category_slug ?? "-"}`,
      `type: ${d.document_type ?? "-"}`,
      d.tags?.length ? `tags: ${d.tags.join(", ")}` : null,
      refs ? `reference numbers: ${refs}` : null,
      `summary: ${(d.summary ?? "-").slice(0, 1200)}`,
    ].filter(Boolean).join("\n");
    return {
      text,
      digest: `[earlier result of get_document_summary: document ${d.id}]`,
      rowCount: 1,
      block: { kind: "document", tool: "get_document_summary", rows: [{ id: d.id, title: docTitle(d), doc_date: d.doc_date }], route: `/dokumente/${d.id}` },
    };
  },
};

export const DOCUMENT_TOOLS = [listCategories, searchDocuments, getDocumentSummary];
