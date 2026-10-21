/**
 * The assistant's write tools (#1529). Each one only prepares: the catalog
 * turns it into a proposal (proposals.ts), and `execute` runs when the user
 * clicks "Ausführen" — through the same endpoints the app's own buttons use.
 *
 * Photo selections take the filter `list_photos` takes and are resolved to ids
 * when the proposal is made: the model sees only the first ids of a result,
 * and the card has to name the count the action will really touch.
 */

import { collections, documents, finance, photo } from "~encore/clients";
import { bool, int, isoDate, str } from "../format";
import { writeTool, type WriteToolDefinition } from "../proposals";
import type { JsonSchema, RefType, ToolContext } from "../types";
import { createPhotoCollage } from "./collage";
import { renderLetter } from "./letters";
import { createTextDocument } from "./text-documents";
import { euerPdf, taxWorksheetPdf } from "./tax";
import { findInDocuments, pageCount, type Box } from "./text-boxes";
import { CRITERIA_PROPERTIES, GROUP_PROPERTIES, criteriaFromArgs, groupByFromArgs, totalsText } from "./finance";
import type { TransactionCriteria } from "../../finance/transaction-conditions";
import type { TotalsGroupBy, TransactionTotals } from "../../finance/transaction-totals";

/** More than this many objects in one proposal is refused; the user narrows first. */
const MAX_PHOTOS = 2000;
const MAX_FAVORITES = 200;
const MAX_TRANSACTIONS = 500;
const MAX_DOCUMENTS = 200;
/** Documents per new Sammelmappe; each one's pages are searched per term. */
const MAX_COLLECTION_DOCUMENTS = 50;
const MAX_REDACT_TERMS = 5;
/** Ids per call of the album batch endpoint. */
const BATCH = 500;

const PHOTO_SELECTION: Record<string, Record<string, unknown>> = {
  photos: {
    type: "object",
    description: "which photos, by the same filter as list_photos",
    properties: {
      favorite: { type: "boolean" },
      date_from: { type: "string", description: "YYYY-MM-DD" },
      date_to: { type: "string", description: "YYYY-MM-DD" },
      person_ids: { type: "array", items: { type: "integer" } },
    },
  },
  photo_ids: { type: "array", items: { type: "integer" }, description: "explicit photo ids, instead of a filter" },
  from_previous_result: { type: "boolean", description: "the photos of the previous answer, instead of a filter or ids" },
};

const FROM_PREVIOUS = (what: string) => ({
  type: "boolean",
  description: `the ${what} of the previous answer, instead of listing ids`,
});

/** Explicit ids, or the latest result of `type` when the model asks for it. */
function idsOrPrevious(args: Record<string, unknown>, key: string, type: RefType, ctx: ToolContext): number[] {
  if (bool(args.from_previous_result) === true) {
    const previous = ctx.previous?.(type);
    if (!previous) throw new Error(`there is no earlier ${type} result in this conversation`);
    return [...new Set(previous)];
  }
  return ids(args[key]);
}

function ids(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.map((v) => int(v)).filter((v): v is number => v !== undefined && v > 0))]
    : [];
}

function deDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** The photo ids a selection points at, now. */
async function resolvePhotos(args: Record<string, unknown>, ctx: ToolContext): Promise<number[]> {
  if (bool(args.from_previous_result) === true) {
    // The filter would be dropped on the floor and the album would get every
    // photo of the earlier answer; the benchmark saw Gemma try exactly this
    // for "nur die aus München". Narrowing is list_photos's job.
    if (args.photos && typeof args.photos === "object" && Object.keys(args.photos).length) {
      throw new Error("from_previous_result cannot be combined with a photos filter: call list_photos with from_previous_result and the filter first, then create_album with from_previous_result");
    }
    return idsOrPrevious(args, "photo_ids", "photo", ctx);
  }
  const explicit = ids(args.photo_ids);
  if (explicit.length) return explicit.slice(0, MAX_PHOTOS + 1);
  const f = (args.photos && typeof args.photos === "object" ? args.photos : {}) as Record<string, unknown>;
  const favorite = bool(f.favorite);
  const dateFrom = isoDate(f.date_from);
  const dateTo = isoDate(f.date_to);
  const personIds = ids(f.person_ids);
  if (!favorite && !dateFrom && !dateTo && !personIds.length) {
    throw new Error("say which photos: a filter (favorite, date range, persons), photo_ids or from_previous_result");
  }
  const res = (await photo.listPhotos({
    favorite: favorite || undefined,
    dateFrom,
    dateTo,
    personIds: personIds.length ? personIds.join(",") : undefined,
    personMode: personIds.length ? "include" : undefined,
    limit: MAX_PHOTOS + 1,
  })) as unknown as { photos: { id: number }[] };
  return res.photos.map((p) => p.id);
}

function checkPhotoCount(photoIds: number[]): void {
  if (photoIds.length > MAX_PHOTOS) {
    throw new Error(`more than ${MAX_PHOTOS} photos match; narrow the selection first`);
  }
}

async function addToAlbum(albumId: number, photoIds: number[]): Promise<void> {
  for (let i = 0; i < photoIds.length; i += BATCH) {
    await photo.batchUpdateAlbumPhotos({ albumIds: [albumId], photoIds: photoIds.slice(i, i + BATCH), action: "add" });
  }
}

const createAlbum: WriteToolDefinition = {
  name: "create_album",
  summary: "Propose a new photo album, optionally filled with photos chosen by filter or ids.",
  permissions: ["module.photos", "albums.manage"],
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      ...PHOTO_SELECTION,
    },
    required: ["name"],
  } as JsonSchema,
  async prepare(args, ctx) {
    const name = str(args.name);
    if (!name) throw new Error("name is required");
    const wantsPhotos = Boolean(args.photos || ids(args.photo_ids).length || bool(args.from_previous_result));
    const photoIds = wantsPhotos ? await resolvePhotos(args, ctx) : [];
    checkPhotoCount(photoIds);
    return {
      summary: photoIds.length
        ? `Album „${name}“ anlegen und ${photoIds.length} Fotos hinzufügen`
        : `Leeres Album „${name}“ anlegen`,
      arguments: { name, description: str(args.description) ?? null, photo_ids: photoIds },
      count: photoIds.length,
    };
  },
  async execute(args) {
    const album = (await photo.createAlbum({
      name: String(args.name),
      description: (args.description as string | null) ?? undefined,
    })) as unknown as { id: number; name: string };
    const photoIds = ids(args.photo_ids);
    if (photoIds.length) await addToAlbum(album.id, photoIds);
    return {
      summary: `Album „${album.name}“ mit ${photoIds.length} Fotos angelegt`,
      route: `/fotos/alben/${album.id}`,
      details: { album_id: album.id },
    };
  },
};

const addPhotosToAlbum: WriteToolDefinition = {
  name: "add_photos_to_album",
  summary: "Propose adding photos (by filter or ids) to an existing album from list_albums.",
  permissions: ["module.photos", "photos.view"],
  parameters: {
    type: "object",
    properties: {
      album_id: { type: "integer", description: "id from list_albums" },
      ...PHOTO_SELECTION,
    },
    required: ["album_id"],
  } as JsonSchema,
  async prepare(args, ctx) {
    const albumId = int(args.album_id);
    if (albumId === undefined) throw new Error("album_id is required");
    const albums = (await photo.listAlbums()) as unknown as { albums: { id: number; name: string }[] };
    const album = albums.albums.find((a) => a.id === albumId);
    if (!album) throw new Error(`album ${albumId} not found`);
    const photoIds = await resolvePhotos(args, ctx);
    checkPhotoCount(photoIds);
    if (!photoIds.length) throw new Error("no photos match");
    return {
      summary: `${photoIds.length} Fotos zum Album „${album.name}“ hinzufügen`,
      arguments: { album_id: albumId, album_name: album.name, photo_ids: photoIds },
      count: photoIds.length,
    };
  },
  async execute(args) {
    const albumId = Number(args.album_id);
    const photoIds = ids(args.photo_ids);
    await addToAlbum(albumId, photoIds);
    return {
      summary: `${photoIds.length} Fotos zum Album „${String(args.album_name)}“ hinzugefügt`,
      route: `/fotos/alben/${albumId}`,
    };
  },
};

const setPhotoFavorite: WriteToolDefinition = {
  name: "set_photo_favorite",
  summary: "Propose marking photos as favorites, or removing the mark.",
  permissions: ["module.photos", "photos.view"],
  parameters: {
    type: "object",
    properties: {
      photo_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: FROM_PREVIOUS("photos"),
      favorite: { type: "boolean", description: "false removes the mark" },
    },
    required: ["favorite"],
  },
  async prepare(args, ctx) {
    const photoIds = idsOrPrevious(args, "photo_ids", "photo", ctx);
    if (!photoIds.length) throw new Error("photo_ids or from_previous_result is required");
    if (photoIds.length > MAX_FAVORITES) throw new Error(`at most ${MAX_FAVORITES} photos at once`);
    const favorite = bool(args.favorite) ?? true;
    return {
      summary: favorite
        ? `${photoIds.length} Fotos als Favorit markieren`
        : `Bei ${photoIds.length} Fotos die Favoriten-Markierung entfernen`,
      arguments: { photo_ids: photoIds, favorite },
      count: photoIds.length,
    };
  },
  async execute(args) {
    const photoIds = ids(args.photo_ids);
    const status = args.favorite === false ? "visible" : "favorite";
    for (const id of photoIds) await photo.updatePhotoCuration({ id, status });
    return {
      summary: status === "favorite"
        ? `${photoIds.length} Fotos als Favorit markiert`
        : `Bei ${photoIds.length} Fotos die Markierung entfernt`,
      route: status === "favorite" ? "/fotos/galerie?favorite=true" : undefined,
    };
  },
};

const createDocumentFollowUp: WriteToolDefinition = {
  name: "create_document_follow_up",
  summary: "Propose a follow-up (Wiedervorlage) on documents for a date, with an optional note.",
  permissions: ["module.documents", "documents.view"],
  parameters: {
    type: "object",
    properties: {
      document_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: FROM_PREVIOUS("documents"),
      date: { type: "string", description: "YYYY-MM-DD" },
      note: { type: "string" },
    },
    required: ["date"],
  },
  async prepare(args, ctx) {
    const documentIds = idsOrPrevious(args, "document_ids", "document", ctx);
    if (!documentIds.length) throw new Error("document_ids or from_previous_result is required");
    if (documentIds.length > MAX_DOCUMENTS) throw new Error(`at most ${MAX_DOCUMENTS} documents at once`);
    const date = isoDate(args.date);
    if (!date) throw new Error("date must be YYYY-MM-DD");
    if (date < ctx.today) throw new Error("the follow-up date lies in the past");
    const note = str(args.note) ?? null;
    return {
      summary: `Wiedervorlage am ${deDate(date)} für ${documentIds.length === 1 ? "1 Dokument" : `${documentIds.length} Dokumente`}${note ? ` („${note.slice(0, 60)}“)` : ""}`,
      arguments: { document_ids: documentIds, date, note },
      count: documentIds.length,
    };
  },
  async execute(args) {
    const res = (await documents.setDocumentFollowUp({
      document_ids: ids(args.document_ids),
      follow_up_date: String(args.date),
      note: (args.note as string | null) ?? null,
    })) as unknown as { scheduled: number };
    return {
      summary: `Wiedervorlage am ${deDate(String(args.date))} für ${res.scheduled} Dokumente gesetzt`,
      route: "/dokumente/spaeter",
    };
  },
};

const tagTransactions: WriteToolDefinition = {
  name: "tag_transactions",
  summary: "Propose adding or removing the user's tags on bookings (ids from list_transactions).",
  permissions: ["module.finance", "finance.view"],
  parameters: {
    type: "object",
    properties: {
      transaction_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: FROM_PREVIOUS("bookings"),
      add: { type: "array", items: { type: "string" }, description: "tags to add" },
      remove: { type: "array", items: { type: "string" }, description: "tags to remove" },
    },
  },
  async prepare(args, ctx) {
    const transactionIds = idsOrPrevious(args, "transaction_ids", "transaction", ctx);
    if (!transactionIds.length) throw new Error("transaction_ids or from_previous_result is required");
    if (transactionIds.length > MAX_TRANSACTIONS) throw new Error(`at most ${MAX_TRANSACTIONS} bookings at once`);
    const clean = (v: unknown) => (Array.isArray(v) ? v.map((t) => str(t)).filter((t): t is string => !!t) : []);
    const add = clean(args.add);
    const remove = clean(args.remove);
    if (!add.length && !remove.length) throw new Error("say which tags to add or remove");
    const parts = [
      add.length ? `${add.map((t) => `„${t}“`).join(", ")} setzen` : null,
      remove.length ? `${remove.map((t) => `„${t}“`).join(", ")} entfernen` : null,
    ].filter(Boolean);
    return {
      summary: `Bei ${transactionIds.length} Buchungen ${parts.join(" und ")}`,
      arguments: { transaction_ids: transactionIds, add, remove },
      count: transactionIds.length,
    };
  },
  async execute(args) {
    const res = (await finance.batchTag({
      transaction_ids: ids(args.transaction_ids),
      add: (args.add as string[]) ?? [],
      remove: (args.remove as string[]) ?? [],
    })) as unknown as { affected_transactions: number };
    return { summary: `Tags an ${res.affected_transactions} Buchungen geändert` };
  },
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

const createCollection: WriteToolDefinition = {
  name: "create_collection",
  summary: "Propose a document Sammelmappe (folder) of documents, optionally with values blacked out wherever they stand and its PDF built. Name what to black out in `redact`; the server finds the boxes.",
  permissions: ["module.documents", "documents.view"],
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      document_ids: { type: "array", items: { type: "integer" } },
      from_previous_result: { type: "boolean", description: "the documents of the previous answer, instead of ids" },
      redact: {
        type: "array",
        items: { type: "string" },
        description: "values to black out in every document, e.g. ['450.000,00'] for a purchase price; an amount matches in all its printed forms",
      },
      build_pdf: { type: "boolean", description: "also build the folder's PDF (default true)" },
    },
    required: ["name"],
  },
  async prepare(args, ctx) {
    const name = str(args.name);
    if (!name) throw new Error("name is required");
    const documentIds = idsOrPrevious(args, "document_ids", "document", ctx);
    if (!documentIds.length) throw new Error("document_ids or from_previous_result is required");
    if (documentIds.length > MAX_COLLECTION_DOCUMENTS) {
      throw new Error(`at most ${MAX_COLLECTION_DOCUMENTS} documents in one folder`);
    }
    const terms = Array.isArray(args.redact)
      ? [...new Set(args.redact.map((t) => str(t)).filter((t): t is string => !!t))]
      : [];
    if (terms.length > MAX_REDACT_TERMS) throw new Error(`at most ${MAX_REDACT_TERMS} values to black out`);
    const buildPdf = bool(args.build_pdf) ?? true;

    const hits = terms.length ? await findInDocuments(documentIds, terms) : [];
    const invisible = hits.filter((h) => h.status === "not_found").map((h) => h.document_id);
    if (invisible.length) throw new Error(`documents ${invisible.join(", ")} not found`);
    const redactions: Record<string, Box[]> = {};
    for (const h of hits) if (h.boxes.length) redactions[String(h.document_id)] = h.boxes;
    const unsearchable = hits.filter((h) => h.status === "no_words").map((h) => h.document_id);

    const termText = terms.map((t) => `„${t}“`).join(", ");
    const parts = [`Sammelmappe „${name}“ mit ${plural(documentIds.length, "Dokument", "Dokumenten")}`];
    if (terms.length) {
      const pages = pageCount(hits);
      parts.push(pages > 0 ? `${termText} auf ${plural(pages, "Seite", "Seiten")} geschwärzt` : `${termText} nirgends gefunden, nichts geschwärzt`);
    }
    if (unsearchable.length) {
      parts.push(`${plural(unsearchable.length, "Dokument", "Dokumente")} noch ohne Wortpositionen, dort nichts geschwärzt`);
    }
    if (buildPdf) parts.push("PDF wird erzeugt");
    return {
      summary: parts.join(", "),
      arguments: { name, document_ids: documentIds, redact: terms, redactions, unsearchable, build_pdf: buildPdf },
      count: documentIds.length,
    };
  },
  async execute(args) {
    const created = (await documents.createCollection({
      title: String(args.name),
      document_ids: ids(args.document_ids),
    })) as unknown as { id: number; title: string };
    const redactions = (args.redactions ?? {}) as Record<string, Box[]>;
    let pages = 0;
    for (const [documentId, boxes] of Object.entries(redactions)) {
      await documents.updateCollectionItem({ id: created.id, documentId: Number(documentId), redactions: boxes });
      pages += new Set(boxes.map((b) => b.page)).size;
    }
    if (args.build_pdf !== false) await documents.startCollectionExport({ id: created.id });
    const parts = [`Sammelmappe „${created.title}“ angelegt`];
    if (pages > 0) parts.push(`${plural(pages, "Seite", "Seiten")} geschwärzt – bitte die Boxen dort prüfen`);
    if (args.build_pdf !== false) parts.push("das PDF wird erzeugt und liegt dann in der Mappe zum Herunterladen");
    return {
      summary: parts.join(", "),
      route: `/dokumente/mappen/${created.id}`,
      details: { collection_id: created.id },
    };
  },
};

const buildCollectionPdf: WriteToolDefinition = {
  name: "build_collection_pdf",
  summary: "Propose building the PDF of an existing document Sammelmappe (with its redactions burnt in).",
  permissions: ["module.documents", "documents.view"],
  parameters: {
    type: "object",
    properties: { collection_id: { type: "integer" } },
    required: ["collection_id"],
  },
  async prepare(args) {
    const id = int(args.collection_id);
    if (id === undefined) throw new Error("collection_id is required");
    const c = (await documents.getCollection({ id })) as unknown as { id: number; title: string; items?: unknown[] };
    return {
      summary: `PDF der Sammelmappe „${c.title}“ erzeugen`,
      arguments: { collection_id: id, title: c.title },
      count: c.items?.length,
    };
  },
  async execute(args) {
    const id = Number(args.collection_id);
    await documents.startCollectionExport({ id });
    return {
      summary: `PDF der Sammelmappe „${String(args.title)}“ wird erzeugt und liegt dann in der Mappe zum Herunterladen`,
      route: `/dokumente/mappen/${id}`,
    };
  },
};

interface ReportPreview {
  id: number | null;
  title: string;
  currency: string;
  groups: Array<{ name: string; count: number; subtotal: number }>;
  total: number;
  count: number;
  yield: { formula: string; total: number; per_year: number } | null;
}

function money(centsValue: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(centsValue / 100);
}

/** The groups as the model gave them, cleaned to what the finance endpoint takes. */
function reportDefinition(args: Record<string, unknown>, ctx: ToolContext) {
  const title = str(args.title);
  if (!title) throw new Error("title is required");
  const rawGroups = Array.isArray(args.groups) ? args.groups : [];
  if (!rawGroups.length) throw new Error("groups is required");
  const groups = rawGroups.map((g) => {
    const o = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
    const name = str(o.name);
    if (!name) throw new Error("every group needs a name");
    const tag = str(o.tag);
    return tag ? { name, tag } : { name, transaction_ids: ids(o.transaction_ids) };
  });
  const all = bool(args.from_previous_result) === true
    ? ctx.previous?.("transaction") ?? []
    : ids(args.transaction_ids);
  const y = (args.yield && typeof args.yield === "object" ? args.yield : null) as Record<string, unknown> | null;
  const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x) : []);
  const yieldSpec = y && str(y.investment_group)
    ? { investment_group: str(y.investment_group)!, income_groups: names(y.income_groups), cost_groups: names(y.cost_groups) }
    : null;
  return { title, groups, transaction_ids: all, yield: yieldSpec };
}

const transactionReport: WriteToolDefinition = {
  name: "transaction_report",
  summary: "Propose a PDF report of bookings in named groups with subtotals, a total and optionally the yield; the server computes every number. Group bookings by ids from list_transactions, or by one of the user's tags.",
  permissions: ["module.finance", "finance.view"],
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      groups: {
        type: "array",
        description: "each booking in at most one group",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "e.g. 'Kauf', 'Reparatur', 'Mieteinnahmen'" },
            transaction_ids: { type: "array", items: { type: "integer" } },
            tag: { type: "string", description: "instead of ids: every booking with this tag of the user" },
          },
          required: ["name"],
        },
      },
      transaction_ids: { type: "array", items: { type: "integer" }, description: "all bookings of the report; those in no group are listed under 'Sonstige'" },
      from_previous_result: { type: "boolean", description: "the bookings of the previous answer as all bookings of the report" },
      yield: {
        type: "object",
        description: "compute the yield: net income (income + cost groups) over the investment",
        properties: {
          investment_group: { type: "string" },
          income_groups: { type: "array", items: { type: "string" } },
          cost_groups: { type: "array", items: { type: "string" } },
        },
        required: ["investment_group"],
      },
    },
    required: ["title", "groups"],
  },
  async prepare(args, ctx) {
    const definition = reportDefinition(args, ctx);
    const preview = (await finance.previewGroupedReport(definition)) as unknown as ReportPreview;
    const groupsText = preview.groups.map((g) => `${g.name} ${g.count}`).join(", ");
    const parts = [`Bericht „${preview.title}“ als PDF: ${groupsText}; ${preview.count} Buchungen, Summe ${money(preview.total, preview.currency)}`];
    if (preview.yield) parts.push("mit Rendite");
    return {
      summary: parts.join(", "),
      arguments: definition,
      count: preview.count,
      // What the model may repeat: every figure below was computed by the server.
      note: [
        ...preview.groups.map((g) => `${g.name}: ${g.count} bookings, subtotal ${money(g.subtotal, preview.currency)}`),
        `Total: ${preview.count} bookings, ${money(preview.total, preview.currency)}`,
        ...(preview.yield ? [preview.yield.formula] : []),
      ].join("\n"),
    };
  },
  async execute(args) {
    const report = (await finance.createGroupedReport(args as never)) as unknown as ReportPreview;
    return {
      summary: `Bericht „${report.title}“ gespeichert – ${report.count} Buchungen, Summe ${money(report.total, report.currency)}`
        + (report.yield ? `, ${report.yield.formula.split("\n")[0]}` : ""),
      download: `/finance/reports/grouped/${report.id}/pdf`,
      details: { report_id: report.id },
    };
  },
};

/** The filter in words, for the card. */
function criteriaWords(c: TransactionCriteria): string {
  const parts: string[] = [];
  if (c.text) parts.push(`Suche „${c.text}“`);
  if (c.tags?.length) parts.push(`${c.tags.length === 1 ? "Tag" : "Tags"} ${c.tags.map((t) => `„${t}“`).join(", ")}`);
  if (c.from && c.to) parts.push(`${deDate(c.from)}–${deDate(c.to)}`);
  else if (c.from) parts.push(`ab ${deDate(c.from)}`);
  else if (c.to) parts.push(`bis ${deDate(c.to)}`);
  if (c.direction) parts.push(c.direction === "out" ? "nur Ausgaben" : "nur Einnahmen");
  if (c.amount_min !== undefined) parts.push(`ab ${c.amount_min} €`);
  if (c.amount_max !== undefined) parts.push(`bis ${c.amount_max} €`);
  if (c.tax_relevant !== undefined) parts.push(c.tax_relevant ? "steuerrelevant" : "nicht steuerrelevant");
  if (c.account_ids?.length) parts.push(plural(c.account_ids.length, "Konto", "Konten"));
  return parts.join(", ");
}

const SUBTOTAL_WORDS: Record<TotalsGroupBy, string> = {
  none: "",
  tag: "Zwischensummen je Tag",
  month: "Zwischensummen je Monat",
  quarter: "Zwischensummen je Quartal",
  year: "Zwischensummen je Jahr",
};

const createTransactionFolder: WriteToolDefinition = {
  name: "create_transaction_folder",
  summary: "Propose a rule-based Sammelmappe of bookings: the transaction list's filter and search become its rule, so bookings that match later join by themselves. Its page shows subtotals per tag or per month, quarter or year and the total; the server computes them. Same filter names as list_transactions.",
  permissions: ["module.finance", "finance.view"],
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "the folder's name, e.g. 'Handwerker 2026'" },
      ...CRITERIA_PROPERTIES,
      ...GROUP_PROPERTIES,
    },
    required: ["name"],
  },
  async prepare(args) {
    const name = str(args.name);
    if (!name) throw new Error("name is required");
    const criteria = criteriaFromArgs(args);
    if (Object.keys(criteria).length === 0) {
      throw new Error("the rule must narrow something: a search, a period, tags, an account, a direction or an amount");
    }
    const grouping = groupByFromArgs(args);
    const totals = (await finance.transactionTotals({ criteria, ...grouping })) as unknown as TransactionTotals;
    const parts = [`Regel-Sammelmappe „${name}“ für Buchungen: ${criteriaWords(criteria)}`];
    parts.push(`jetzt ${plural(totals.count, "Buchung", "Buchungen")}, Summe ${money(totals.total, totals.currency)}`);
    if (grouping.group_by !== "none") parts.push(SUBTOTAL_WORDS[grouping.group_by]);
    return {
      summary: parts.join("; "),
      arguments: {
        name,
        criteria,
        totals: { group_by: grouping.group_by, ...(grouping.group_tags ? { tags: grouping.group_tags } : {}) },
      },
      count: totals.count,
      note: totalsText(totals),
    };
  },
  async execute(args) {
    const res = (await collections.createRuleCollection({
      name: String(args.name),
      rule: { type: "transaction", criteria: args.criteria, totals: args.totals },
    })) as unknown as { collection: { id: number; name: string; total: number } };
    const c = res.collection;
    return {
      summary: `Regel-Sammelmappe „${c.name}“ angelegt mit ${plural(c.total, "Buchung", "Buchungen")} – neue passende Buchungen kommen von selbst dazu`,
      route: `/finanzen/sammelmappe/${c.id}`,
      details: { collection_id: c.id },
    };
  },
};

const MAX_BUNDLE_DOCUMENTS = 500;

interface TaxBundleBucket { slug: string; name: string; group: string; documents: { document: { id: number; title: string | null; original_filename?: string } }[] }

const taxReturnBundle: WriteToolDefinition = {
  name: "tax_return_bundle",
  summary: "Propose the Sammelmappe for one year's tax return: every document flagged for that tax year, grouped by Anlage as the Steuer page lists them, plus the bookings flagged tax-relevant in that year. The folder can then be exported, sent or shared from its page. Ask for this when the user wants 'alle Unterlagen für die Steuer 2025'.",
  permissions: ["module.documents", "documents.view"],
  parameters: {
    type: "object",
    properties: {
      year: { type: "integer", description: "the tax year, e.g. 2025" },
      name: { type: "string", description: "folder name; default 'Steuererklärung <year>'" },
      include_transactions: { type: "boolean", description: "also the bookings flagged tax-relevant in that year (default true, if the user may see finance)" },
      person_id: { type: "integer", description: "the Steuerakte of a household member with their own tax return (subject person id); default: the user's own return" },
    },
    required: ["year"],
  },
  async prepare(args, ctx) {
    const year = int(args.year, { min: 1990, max: 2100 });
    if (year === undefined) throw new Error("year is required (e.g. 2025)");
    const name = str(args.name) ?? `Steuererklärung ${year}`;
    const personId = int(args.person_id);
    const tax = (await documents.listTaxDocuments({ year, tax_return_person: personId })) as unknown as { total_documents: number; sections: TaxBundleBucket[] };
    const documentIds = [...new Set(tax.sections.flatMap((b) => b.documents.map((e) => e.document.id)))].slice(0, MAX_BUNDLE_DOCUMENTS);
    const sections = tax.sections.filter((b) => b.documents.length).map((b) => `${b.name} ${b.documents.length}`);

    const mayFinance = ["module.finance", "finance.view"].every((perm) => ctx.user.permissions.includes(perm));
    const wantTransactions = (bool(args.include_transactions) ?? true) && mayFinance;
    let transactionIds: number[] = [];
    let transactionTotal = 0;
    if (wantTransactions) {
      const res = (await finance.listTransactions({ taxRelevant: true, from: `${year}-01-01`, to: `${year}-12-31`, limit: MAX_TRANSACTIONS })) as unknown as { items: { id: number }[]; total: number };
      transactionIds = res.items.map((t) => t.id);
      transactionTotal = res.total;
    }
    if (!documentIds.length && !transactionIds.length) {
      throw new Error(`nothing is flagged for the tax year ${year}: no document carries tax year ${year}${wantTransactions ? " and no booking of that year is marked tax-relevant" : ""}. Flag documents on the Steuer page first.`);
    }
    const parts = [`Sammelmappe „${name}“ mit ${plural(documentIds.length, "Dokument", "Dokumenten")}`];
    if (sections.length) parts.push(`in ${plural(sections.length, "Anlage", "Anlagen")} (${sections.join(", ")})`);
    if (wantTransactions) parts.push(`und ${plural(transactionIds.length, "steuerrelevanter Buchung", "steuerrelevanten Buchungen")}`);
    const notes = [
      tax.total_documents > documentIds.length ? `Only the first ${documentIds.length} of ${tax.total_documents} documents fit into one folder.` : undefined,
      transactionTotal > transactionIds.length ? `Only the first ${transactionIds.length} of ${transactionTotal} bookings fit.` : undefined,
      "The folder is a mixed Sammelmappe; from its page the user exports it as PDF or ZIP, sends it or shares a link. Documents the tax review still has to look at are included as flagged.",
    ].filter(Boolean);
    return {
      summary: parts.join(" "),
      arguments: { name, year, document_ids: documentIds, transaction_ids: transactionIds, person_id: personId ?? null, sections },
      count: documentIds.length + transactionIds.length,
      note: notes.join(" "),
    };
  },
  async execute(args) {
    const documentIds = ids(args.document_ids);
    const transactionIds = ids(args.transaction_ids);
    const sections = Array.isArray(args.sections) ? args.sections.map(String) : [];
    const created = (await collections.createAnyCollection({
      name: String(args.name),
      description: [`Steuererklärung ${String(args.year)}: ${documentIds.length} Dokumente${sections.length ? ` (${sections.join(", ")})` : ""}`, transactionIds.length ? `${transactionIds.length} steuerrelevante Buchungen` : ""].filter(Boolean).join(", "),
      members: [
        ...documentIds.map((id) => ({ entity_type: "document", entity_id: id })),
        ...transactionIds.map((id) => ({ entity_type: "transaction", entity_id: id })),
      ],
    })) as unknown as { id: number; name?: string; title?: string };
    return {
      summary: `Sammelmappe „${String(args.name)}“ angelegt mit ${plural(documentIds.length, "Dokument", "Dokumenten")}${transactionIds.length ? ` und ${plural(transactionIds.length, "Buchung", "Buchungen")}` : ""} – auf ihrer Seite lässt sie sich als PDF oder ZIP exportieren, versenden oder teilen`,
      route: `/sammelmappen/${created.id}`,
      details: { collection_id: created.id, documents: documentIds.length, transactions: transactionIds.length },
    };
  },
};

export const WRITE_TOOL_DEFINITIONS: WriteToolDefinition[] = [
  taxReturnBundle,
  taxWorksheetPdf,
  euerPdf,
  createAlbum,
  addPhotosToAlbum,
  setPhotoFavorite,
  createPhotoCollage,
  createDocumentFollowUp,
  tagTransactions,
  createCollection,
  buildCollectionPdf,
  transactionReport,
  createTransactionFolder,
  renderLetter,
  createTextDocument,
];

export const WRITE_TOOLS = WRITE_TOOL_DEFINITIONS.map(writeTool);

export const WRITE_TOOLS_BY_NAME = new Map(WRITE_TOOL_DEFINITIONS.map((d) => [d.name, d]));
