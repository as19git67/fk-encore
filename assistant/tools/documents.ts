/**
 * Document read tools. The documents service checks `module.documents`,
 * `documents.view` and the per-document visibility on every call.
 */

import { documents } from "~encore/clients";
import { bool, digestOf, int, isoDate, query, str, table } from "../format";
import type { ToolSpec } from "../types";
import { taxWorksheet } from "./tax";
import { findInDocuments } from "./text-boxes";
import { dateKey, groupProperties, groupRows, parseGrouping, parseRanking, rankNote, rankProperties, rankRequires, type RankField } from "./ranking";
import { loosenAdvice, periodLabel, type LoosenAdvice, type Probe, type ProbeCount } from "./hints";

const DOCUMENTS = ["module.documents", "documents.view"];

interface Category { id: number; slug: string; name: string; parent_id: number | null }
interface DocumentSummary {
  id: number; title: string | null; original_filename?: string; doc_date: string | null;
  sender?: string | null; correspondent_display?: string | null; category_slug?: string | null;
  reference_numbers?: unknown; uploaded_at?: string | null; size_bytes?: number;
}

/**
 * What a document list is ranked by: the search's relevance, or a field the
 * documents service sorts by (`sort_by` of GET /documents and /documents/search).
 */
const RANK_FIELDS = {
  relevance: { description: "match of q (needs q)", sortBy: undefined },
  doc_date: { description: "document date", sortBy: "doc_date" },
  uploaded_at: { description: "date added", sortBy: "uploaded_at" },
  size_bytes: { description: "file size ('das größte')", sortBy: "size_bytes" },
} satisfies Record<string, RankField & { sortBy: string | undefined }>;
type DocumentRankField = keyof typeof RANK_FIELDS;

const GROUPS = {
  year: "of the document date",
  month: "YYYY-MM",
  correspondent: "sender",
  category: "slug",
} as const;
type DocumentGroup = keyof typeof GROUPS;

/** Rows the service is asked for when the result is grouped: every group needs its first row. */
const GROUPED_SEARCH_CAP = 100;
const GROUPED_LIST_CAP = 200;

function groupKey(d: DocumentSummary, by: DocumentGroup): string | undefined {
  if (by === "year" || by === "month") return dateKey(d.doc_date, by);
  if (by === "correspondent") return d.correspondent_display ?? d.sender ?? undefined;
  return d.category_slug ?? undefined;
}
interface DocumentDetail extends DocumentSummary {
  summary?: string | null; tags?: string[]; document_type?: string | null;
  tax_relevant?: boolean; tax_year?: number | null; tax_sections?: { slug: string; name: string; group: string }[];
}
interface TaxBucket { slug: string; name: string; group: string; documents: { document: DocumentSummary & { tax_year?: number | null }; confidence: number | null; source: string }[] }

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

const SEARCH_MODES = ["hybrid", "fts", "semantic"];

interface Correspondent { slug: string; display: string; count: number }

/**
 * The sender as the user names it ("TK") to the way the documents carry it:
 * the correspondent slug when one known correspondent matches the name,
 * otherwise a substring filter on the sender line. The search endpoint's
 * `correspondent` is an exact slug, which the model cannot know.
 */
async function resolveCorrespondent(name: string | undefined): Promise<{ slug?: string; sender?: string; note?: string }> {
  if (!name) return {};
  const needle = name.toLocaleLowerCase("de");
  let known: Correspondent[] = [];
  try {
    known = ((await documents.listCorrespondents()) as unknown as { items: Correspondent[] }).items;
  } catch {
    // Without the facet the sender line still narrows the search.
  }
  const exact = known.filter((c) => c.slug === needle || c.display.toLocaleLowerCase("de") === needle);
  const partial = exact.length ? exact : known.filter((c) => c.slug.includes(needle) || c.display.toLocaleLowerCase("de").includes(needle));
  const best = [...partial].sort((a, b) => b.count - a.count)[0];
  if (best) {
    const others = partial.filter((c) => c !== best).map((c) => c.display);
    return {
      slug: best.slug,
      note: `Correspondent "${name}" taken as ${best.display} (${best.count} documents)${others.length ? `; also matching: ${others.slice(0, 5).join(", ")}` : ""}.`,
    };
  }
  return { sender: name, note: `No known correspondent matches "${name}"; filtered on the sender line instead.` };
}

/** The filters a document query shares between the search and the list. */
interface DocumentQuery {
  q?: string;
  mode: string;
  category?: string;
  date_from?: string;
  date_to?: string;
  correspondent?: string;
  sender?: string;
  tax_relevant?: boolean;
}

/** Documents the same query finds without one filter: the list's total, or a capped page of the search. */
async function documentCount(query: DocumentQuery): Promise<ProbeCount> {
  const { q, mode, ...filters } = query;
  if (q) {
    const page = 25;
    const res = (await documents.searchDocumentsEndpoint({ ...filters, q, mode, limit: page })) as unknown as { items: unknown[] };
    return { n: res.items.length, atLeast: res.items.length >= page };
  }
  const res = (await documents.listDocuments({ ...filters, limit: 1 })) as unknown as { total: number };
  return { n: res.total };
}

/** Nothing found: each filter dropped in turn, and the word search widened to meaning (stage 2 of assistent-wegfindung.md). */
async function emptyDocumentsHint(query: DocumentQuery, correspondentName: string | undefined): Promise<LoosenAdvice> {
  const probes: Probe[] = [];
  if (query.q) {
    probes.push({ label: `q ${JSON.stringify(query.q)}`, args: ["q"], count: () => documentCount({ ...query, q: undefined }) });
    // A change of mode, not a dropped argument: listed and recommendable, but the guard does not hold a call to it.
    if (query.mode === "fts") probes.push({ label: "mode fts (hybrid instead)", count: () => documentCount({ ...query, mode: "hybrid" }) });
  }
  if (query.correspondent || query.sender) {
    probes.push({ label: `correspondent ${JSON.stringify(correspondentName ?? query.correspondent ?? query.sender)}`, args: ["correspondent"], count: () => documentCount({ ...query, correspondent: undefined, sender: undefined }) });
  }
  if (query.category) probes.push({ label: `category ${query.category}`, args: ["category"], count: () => documentCount({ ...query, category: undefined }) });
  if (query.date_from || query.date_to) probes.push({ label: periodLabel(query.date_from, query.date_to), args: ["date_from", "date_to"], count: () => documentCount({ ...query, date_from: undefined, date_to: undefined }) });
  if (query.tax_relevant !== undefined) probes.push({ label: `tax_relevant ${query.tax_relevant}`, args: ["tax_relevant"], count: () => documentCount({ ...query, tax_relevant: undefined }) });
  return loosenAdvice("documents", probes);
}

export const searchDocuments: ToolSpec = {
  name: "search_documents",
  kind: "read",
  refines: true,
  summary: "Documents by what they are about (q), optionally narrowed to the sender organisation (correspondent), a category slug and a document date range; ranked by relevance, date or size (rank_by, direction), optionally the first of every year, month, sender or category (group_by). Without q it lists by the filters alone. Put the sender (an insurer, a bank, an authority) into correspondent, not into q.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "what the documents are about — the subject, not the sender; leave out to list by the other arguments alone" },
      correspondent: { type: "string", description: "the sender organisation as the user names it ('TK', 'Stadtwerke'); matched against the known correspondents, else against the sender line" },
      mode: {
        type: "string",
        enum: ["hybrid", "fts", "semantic"],
        description: "hybrid (default) mixes exact words and meaning and brings near misses; fts matches the words only — use it for a rare or technical term ('Gesundheitsdividende', an invoice number); semantic for a paraphrase",
      },
      category: { type: "string", description: "category slug from list_categories" },
      tax_relevant: { type: "boolean", description: "only documents flagged as relevant for the tax return (true) or not flagged (false); for one tax year use tax_documents instead" },
      date_from: { type: "string", description: "document date from, YYYY-MM-DD" },
      date_to: { type: "string", description: "document date to, YYYY-MM-DD" },
      limit: { type: "integer", description: "at most 25 (default 15); with group_by: groups shown" },
      ...rankProperties(RANK_FIELDS, "relevance"),
      ...groupProperties(GROUPS),
    },
    dependentRequired: rankRequires(),
  },
  async run(args) {
    const q = str(args.q);
    const category = str(args.category);
    const dateFrom = isoDate(args.date_from);
    const dateTo = isoDate(args.date_to);
    const limit = int(args.limit, { min: 1, max: 25 }) ?? 15;
    const grouping = parseGrouping(args, GROUPS);
    // Without q there is no relevance: such a list is in date order unless told otherwise.
    const ranking = parseRanking(args, RANK_FIELDS, q ? "relevance" : "doc_date");
    if (ranking.field === "relevance" && !q) throw new Error("rank_by relevance needs q; give q, or rank by doc_date, uploaded_at or size_bytes");
    const sortBy = RANK_FIELDS[ranking.field].sortBy;
    const mode = str(args.mode) ?? "hybrid";
    if (!SEARCH_MODES.includes(mode)) throw new Error(`mode must be one of ${SEARCH_MODES.join(", ")}`);
    const who = await resolveCorrespondent(str(args.correspondent));
    const taxRelevant = bool(args.tax_relevant);
    const common = {
      category, date_from: dateFrom, date_to: dateTo,
      correspondent: who.slug, sender: who.sender, tax_relevant: taxRelevant,
      sort_by: sortBy, sort_dir: sortBy ? ranking.direction : undefined,
    };
    let rows: DocumentSummary[];
    let total: number | undefined;
    if (q) {
      const res = await (documents.searchDocumentsEndpoint({
        ...common, q, mode, limit: grouping ? GROUPED_SEARCH_CAP : limit,
      })) as unknown as { items: DocumentSummary[] };
      rows = res.items;
    } else {
      const res = await (documents.listDocuments({
        ...common, limit: grouping ? GROUPED_LIST_CAP : limit,
      })) as unknown as { items: DocumentSummary[]; total: number };
      rows = res.items;
      total = res.total;
    }
    const advice = rows.length ? undefined : await emptyDocumentsHint({ ...common, q, mode }, str(args.correspondent));
    const hint = advice?.hint;
    const groups = grouping ? groupRows(rows, (d) => groupKey(d, grouping.by), grouping.perGroup) : undefined;
    const shown = groups ? groups.flatMap((g) => g.rows.map((d) => ({ ...d, group: g.key }))) : rows.map((d) => ({ ...d, group: undefined as string | undefined }));
    const rowCap = groups ? Math.min(shown.length, limit * grouping!.perGroup) : limit;
    const sizeColumn = ranking.field === "size_bytes";
    const modeNote = mode === "fts" ? "Word match only" : mode === "semantic" ? "By meaning" : "Ranked by relevance";
    const orderNote = ranking.field === "relevance"
      ? `${modeNote}; the list may hold near misses — say which ones fit.`
      : `${rankNote(ranking, grouping, groups?.length ?? 0)}${q ? "; the list may hold near misses — say which ones fit" : ""}.`;
    const capNote = groups && q ? ` Only the ${GROUPED_SEARCH_CAP} best matches were grouped.` : groups && total !== undefined && total > rows.length ? ` Only the first ${rows.length} of ${total} were grouped.` : "";
    return {
      text: table(
        [...(groups ? ["group"] : []), "id", "date", ...(sizeColumn ? ["size_bytes"] : []), "title", "from", "category"],
        shown.map((d) => [...(groups ? [d.group] : []), d.id, d.doc_date?.slice(0, 10), ...(sizeColumn ? [d.size_bytes] : []), docTitle(d), d.correspondent_display ?? d.sender, d.category_slug]),
        {
          cap: rowCap,
          total: groups ? shown.length : total,
          note: [who.note, orderNote + capNote].filter(Boolean).join(" "),
        },
      ),
      digest: digestOf("search_documents", shown.length, shown.map((d) => d.id)),
      rowCount: shown.length,
      hint,
      loosen: advice?.loosen,
      ref: { type: "document", ids: shown.map((d) => d.id) },
      block: {
        kind: "documents",
        tool: "search_documents",
        rows: shown.slice(0, rowCap).map((d) => ({
          id: d.id, title: docTitle(d), doc_date: d.doc_date, from: d.correspondent_display ?? d.sender ?? null, category: d.category_slug ?? null,
        })),
        route: `/dokumente${query({ q, category, correspondent: who.slug, sender: who.sender, dateFrom, dateTo, sortBy, sortDir: sortBy ? ranking.direction : undefined })}`,
      },
    };
  },
};

export const getDocumentSummary: ToolSpec = {
  name: "get_document_summary",
  kind: "read",
  summary: "Title, date, sender, category, tags, reference numbers and summary of one document or of several at once (ids) — one call for all the documents an answer looks at, not one per document.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      id: { type: "integer", description: "one document id" },
      ids: { type: "array", items: { type: "integer" }, description: "several document ids, at most 10 — e.g. the documents of the previous answer" },
    },
  },
  async run(args) {
    const one = int(args.id);
    const many = Array.isArray(args.ids) ? args.ids.map((v) => int(v)).filter((v): v is number => v !== undefined) : [];
    const ids = [...new Set([...(one !== undefined ? [one] : []), ...many])].slice(0, 10);
    if (!ids.length) throw new Error("id or ids is required");
    const docs: DocumentDetail[] = [];
    const missing: number[] = [];
    for (const id of ids) {
      try {
        docs.push((await documents.getDocument({ id })) as unknown as DocumentDetail);
      } catch {
        missing.push(id);
      }
    }
    const perDoc = docs.length > 1 ? 600 : 1200;
    const text = docs.map((d) => {
      const refs = Array.isArray(d.reference_numbers)
        ? (d.reference_numbers as Array<{ value?: string; kind?: string }>).map((r) => `${r.kind ?? "ref"} ${r.value ?? ""}`.trim()).join("; ")
        : "";
      return [
        `id: ${d.id}`,
        `title: ${docTitle(d)}`,
        `date: ${d.doc_date ?? "-"}`,
        `from: ${d.correspondent_display ?? d.sender ?? "-"}`,
        `category: ${d.category_slug ?? "-"}`,
        `type: ${d.document_type ?? "-"}`,
        d.tags?.length ? `tags: ${d.tags.join(", ")}` : null,
        refs ? `reference numbers: ${refs}` : null,
        d.tax_relevant
          ? `tax: relevant for the tax return${d.tax_year ? ` of ${d.tax_year}` : ""}${d.tax_sections?.length ? `, Anlage(n): ${d.tax_sections.map((t) => t.name).join(", ")}` : ""}`
          : "tax: not flagged as tax-relevant",
        `summary: ${(d.summary ?? "-").slice(0, perDoc)}`,
      ].filter(Boolean).join("\n");
    }).join("\n\n");
    const note = missing.length ? `\n\nNot found or not visible: ${missing.join(", ")}.` : "";
    const rows = docs.map((d) => ({ id: d.id, title: docTitle(d), doc_date: d.doc_date, from: d.correspondent_display ?? d.sender ?? null, category: d.category_slug ?? null }));
    return {
      text: (text || "No document found.") + note,
      digest: `[earlier result of get_document_summary: document${docs.length === 1 ? "" : "s"} ${docs.map((d) => d.id).join(", ") || "none"}]`,
      rowCount: docs.length,
      ref: docs.length ? { type: "document", ids: docs.map((d) => d.id) } : undefined,
      block: docs.length === 1
        ? { kind: "document", tool: "get_document_summary", rows, route: `/dokumente/${docs[0]!.id}` }
        : { kind: "documents", tool: "get_document_summary", rows },
    };
  },
};

export const taxDocuments: ToolSpec = {
  name: "tax_documents",
  kind: "read",
  summary: "The documents flagged for the tax return of one year, grouped by Anlage (tax section: Anlage N, KAP, V, Vorsorgeaufwand …) as the Steuer page shows them — what the Finanzamt gets. Documents can carry a tax year and Anlagen; this reads them. For the folder with everything, tax_return_bundle.",
  permissions: DOCUMENTS,
  source: "hand",
  parameters: {
    type: "object",
    properties: {
      year: { type: "integer", description: "the tax year, e.g. 2025; without it every flagged document" },
      section: { type: "string", description: "one Anlage by slug, e.g. anlage-kap" },
      review_needed: { type: "boolean", description: "only documents the tax review still has to look at" },
      person_id: { type: "integer", description: "the Steuerakte of a household member with their own tax return (subject person id); default: the user's own return" },
    },
  },
  async run(args) {
    const year = int(args.year);
    const res = (await documents.listTaxDocuments({
      year, section: str(args.section), review_needed: bool(args.review_needed), tax_return_person: int(args.person_id),
    })) as unknown as { year: number | null; total_documents: number; sections: TaxBucket[] };
    const lines = [`${res.total_documents} document${res.total_documents === 1 ? "" : "s"} for the tax return${res.year ? ` of ${res.year}` : ""}, in ${res.sections.length} Anlage${res.sections.length === 1 ? "" : "n"}:`];
    const rows: Array<{ id: number; title: string; doc_date: string | null; from: string | null; section: string; section_slug: string }> = [];
    for (const b of res.sections) {
      lines.push(`\n${b.name} (${b.slug}, ${b.group}) — ${b.documents.length}:`);
      for (const e of b.documents) {
        const d = e.document;
        lines.push(`  ${d.id} | ${d.doc_date?.slice(0, 10) ?? "-"} | ${docTitle(d)} | ${d.correspondent_display ?? d.sender ?? "-"}${e.source === "user" ? "" : ` (${e.source}${e.confidence !== null ? ` ${Math.round(e.confidence * 100)} %` : ""})`}`);
        rows.push({ id: d.id, title: docTitle(d), doc_date: d.doc_date, from: d.correspondent_display ?? d.sender ?? null, section: b.name, section_slug: b.slug });
      }
    }
    if (!rows.length) lines.push("None flagged yet.");
    const ids = [...new Set(rows.map((r) => r.id))];
    return {
      text: lines.join("\n"),
      digest: digestOf("tax_documents", ids.length, ids),
      rowCount: ids.length,
      ref: ids.length ? { type: "document", ids } : undefined,
      block: {
        kind: "documents",
        tool: "tax_documents",
        total: ids.length,
        subtitle: res.year ? `Steuer ${res.year}` : undefined,
        rows,
        route: `/finanzen/steuer${query({ year })}`,
      },
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

export const DOCUMENT_TOOLS = [taxDocuments, taxWorksheet, listCategories, searchDocuments, getDocumentSummary, getDocumentText, findTextInDocument];
