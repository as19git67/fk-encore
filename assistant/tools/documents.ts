/**
 * Document read tools. The documents service checks `module.documents`,
 * `documents.view` and the per-document visibility on every call.
 */

import { documents } from "~encore/clients";
import { bool, digestOf, int, isoDate, query, str, table } from "../format";
import type { ToolSpec } from "../types";
import { findInDocuments } from "./text-boxes";

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

/** Characters of a document's text one call hands over; the rest is offered by `offset`. */
const TEXT_CHUNK = 6000;

export const getDocumentText: ToolSpec = {
  name: "get_document_text",
  kind: "read",
  summary: "The full extracted text of one document, in pieces of 6000 characters; use it when a summary or the working set lacks a fact a letter or answer needs.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      id: { type: "integer", description: "document id" },
      offset: { type: "integer", description: "character to start at, for the next piece (default 0)" },
    },
    required: ["id"],
  },
  async run(args) {
    const id = int(args.id);
    if (id === undefined) throw new Error("id is required");
    const offset = int(args.offset, { min: 0 }) ?? 0;
    const res = (await documents.getDocumentText({ id })) as unknown as { text: string | null };
    const text = res.text ?? "";
    if (!text) {
      return { text: `document ${id} has no extracted text (yet)`, digest: `[earlier result of get_document_text: document ${id}, no text]`, rowCount: 0 };
    }
    const piece = text.slice(offset, offset + TEXT_CHUNK);
    const end = offset + piece.length;
    const more = end < text.length ? `\n[characters ${offset}–${end} of ${text.length}; call again with offset ${end} for more]` : "";
    return {
      text: `text of document ${id}:\n${piece}${more}`,
      digest: `[earlier result of get_document_text: document ${id}, characters ${offset}–${end} of ${text.length}]`,
      rowCount: 1,
    };
  },
};

/** Documents searched per call; more is a sign the model should narrow first. */
const FIND_MAX_DOCUMENTS = 50;

export const findTextInDocument: ToolSpec = {
  name: "find_text_in_document",
  kind: "read",
  summary: "Where a value (an amount in any printed form, or a phrase) stands in documents: the pages per document. Documents read before word positions were kept are named as such.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      document_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: { type: "boolean", description: "the documents of the previous answer, instead of ids" },
      query: { type: "string", description: "e.g. '450.000,00' or 'Kaufpreis'" },
    },
    required: ["query"],
  },
  async run(args, ctx) {
    const q = str(args.query);
    if (!q) throw new Error("query is required");
    const ids = bool(args.from_previous_result) === true
      ? ctx.previous?.("document") ?? []
      : Array.isArray(args.document_ids)
        ? [...new Set(args.document_ids.map((v) => int(v)).filter((v): v is number => v !== undefined))]
        : [];
    if (!ids.length) throw new Error("say which documents: document_ids or from_previous_result");
    if (ids.length > FIND_MAX_DOCUMENTS) throw new Error(`at most ${FIND_MAX_DOCUMENTS} documents at once`);
    const hits = await findInDocuments(ids, [q]);
    const pagesText = (pages: number[]) => pages.join(", ");
    const statusText = (h: (typeof hits)[number]) =>
      h.status === "no_words" ? "no word positions yet (not searchable)"
        : h.status === "not_found" ? "not visible"
          : h.pages.length ? `pages ${pagesText(h.pages)}` : "not found";
    const found = hits.filter((h) => h.pages.length > 0);
    return {
      text: table(
        ["document", "result"],
        hits.map((h) => [h.document_id, statusText(h)]),
        { cap: 50, note: `"${q}" found in ${found.length} of ${hits.length} documents.` },
      ),
      digest: digestOf("find_text_in_document", found.length, found.map((h) => h.document_id)),
      rowCount: hits.length,
      block: {
        kind: "table",
        tool: "find_text_in_document",
        rows: hits.map((h) => ({ id: h.document_id, result: statusText(h), route: `/dokumente/${h.document_id}` })),
      },
    };
  },
};

export const DOCUMENT_TOOLS = [listCategories, searchDocuments, getDocumentSummary, getDocumentText, findTextInDocument];
