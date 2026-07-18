/**
 * API endpoints for the documents module.
 *
 * Upload goes through the raw endpoint so the PDF body streams
 * straight to disk; every other endpoint is a typed Encore API.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { createRequire } from "module";
import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import { asc, and, desc, eq, gte, ilike, inArray, lte, lt, ne, or, sql, type SQL } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  documentCategories,
  documentCategorySuggestions,
  documentHintSuggestions,
  documentCorrespondentOverrides,
  documentSubjectPersons,
  documentTagLinks,
  documentTags,
  documentTaxSections,
  documents,
  documentsUserPref,
  financeAccountAccess,
  financeTransaction,
  financeTransactionDocument,
  userSubjectPersons,
} from "../db/schema";
import {
  DOCUMENTS_MAX_BYTES,
  SUPPORTED_MIME_TYPES,
  assertPathUnderDocumentsRoot,
  composeOwnerRootSegment,
  ensureDir,
  getInitialUploadDiskPath,
  guessExtension,
  pruneEmptyDirs,
  slugifyName,
  slugifyUserLogin,
} from "./documents.service";
import { normalizeForMatch } from "./sender-rules";
import {
  invalidateCorrespondentOverridesCache,
} from "./correspondent-overrides";
import { users } from "../db/schema";
import { replaceUserTaxSections } from "./document-ops";
import {
  deleteTaxHintOverride,
  listTaxHintEntries,
  upsertTaxHintOverride,
  type TaxHintEntry,
} from "./tax-hint-overrides";
import {
  createSubjectPerson,
  deleteSubjectPerson,
  listSubjectPersons,
  updateSubjectPerson,
} from "./subject-persons";
import { dropTaxLinks, relocateDocument } from "./relocate";
import { withDocumentLock } from "./document-lock";
import { singleJpegPagePdf } from "./receipt-pdf";
import {
  buildReceiptCapturePlan,
  shouldUseTesseractSidecar,
} from "./receipt-capture";
import {
  assertGroupMember,
  loadAdministrableDocument,
  loadUserGroupIds,
  loadVisibleDocument,
  visibleDocumentsWhere,
} from "./visibility";
import { enqueueDocumentScan, getQueueStatus, requeueDocument, cancelPendingJobs, retryFailedJobs, type QueueStatus } from "./scan-queue";
import { triggerWorkers } from "./scan-worker";
import { ensureThumbnail, removeThumbnail } from "./thumbnail";
import { ensureSearchablePdf, ocrPdfFilePath, removeOcrPdf } from "./ocr-pdf";
import { decryptPdfWithPassword } from "./text-extract";
import { searchDocuments, type SearchMode } from "./search";
import { documentTextPreview } from "./text-preview";
import { fetchTagsForDocuments } from "./tags";
import {
  findTaxSection,
  isValidTaxSectionSlug,
  orderTaxSectionSlugs,
  TAX_SECTIONS,
  type TaxSectionGroup,
} from "./tax-sections";

const _require = createRequire(import.meta.url);
type HeicConvertFn = (opts: {
  buffer: ArrayBuffer | Buffer;
  format: "JPEG" | "PNG";
  quality: number;
}) => Promise<ArrayBuffer>;
const heicConvert: HeicConvertFn = _require("heic-convert");

const RECEIPT_CAPTURE_PRIORITY = 0;
const RECEIPT_CAPTURE_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const HEIC_BRANDS = new Set([
  "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "mif2",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID, 10);
}

function checkModule(): void {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.documents");
}

/**
 * `data.manage` admins see every document in `listDocuments`; the same flag
 * lets `loadVisibleDocument` / `loadAdministrableDocument` open, edit, delete
 * and replace those documents. Keeping the single-document endpoints in sync
 * with the list avoids the "visible in the list but 'document not found' on
 * open/delete" mismatch.
 */
function isDataAdmin(authData: { permissions: string[] }): boolean {
  return authData.permissions.includes("data.manage");
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface DocumentSummary {
  id: number;
  title: string | null;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  status: "pending" | "extracting" | "classifying" | "ready" | "failed";
  uploaded_at: string | null;
  doc_date: string | null;
  sender: string | null;
  document_number: string | null;
  /** Canonical correspondent (institution) derived from sender (migration 0130). */
  correspondent_slug: string | null;
  correspondent_display: string | null;
  category_id: number | null;
  category_slug: string | null;
  classification_confidence: number | null;
  tags: string[];
  tax_relevant: boolean;
  tax_year: number | null;
  last_error: string | null;
  visibility: "private" | "group";
  group_id: number | null;
  /** Free-form human notes (shared document metadata, issue #750). */
  notes: string | null;
  /**
   * True when a human pinned the editable attributes (see migration 0101).
   * `false` on a ready document marks it as "new": freshly imported with
   * AI-only attribution that nobody has approved yet (issue #635).
   */
  attributes_reviewed: boolean;
  /** Who last set the category: 'ai' (local model), 'cloud' (Cloud Teacher), 'user' (human). */
  category_source: "ai" | "cloud" | "user";
}

export interface DocumentTaxSectionDTO {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  confidence: number | null;
  source: "ai" | "cloud" | "user";
}

export interface DocumentSubjectPersonDTO {
  id: number;
  full_name: string;
  relation_tag: string;
  source: "ai" | "cloud" | "user";
}

export interface DocumentDetail extends DocumentSummary {
  summary: string | null;
  extracted_text_preview: string | null;
  tax_reviewed: boolean;
  tax_year_confidence: number | null;
  tax_sections: DocumentTaxSectionDTO[];
  /** Bezugspersonen this document concerns (see migration 0102). */
  subject_persons: DocumentSubjectPersonDTO[];
  /**
   * True when a user flagged this document for the next Cloud-Teacher run
   * (migration 0133). The teacher picks flagged documents first and clears the
   * flag once it writes a label.
   */
  teacher_requested: boolean;
}

export interface DocumentReceiptSuggestion {
  document: DocumentSummary;
  status: DocumentSummary["status"];
  last_error: string | null;
  amount: number | null;
  doc_date: string | null;
  sender: string | null;
  note: string | null;
}

export interface DocumentCategoryDTO {
  id: number;
  slug: string;
  name: string;
  parent_id: number | null;
  icon: string | null;
  sort_order: number;
}

export interface ListDocumentsResponse {
  items: DocumentSummary[];
  total: number;
}

interface ListQuery {
  category?: Query<string>;
  tags?: Query<string>;
  q?: Query<string>;
  status?: Query<string>;
  /**
   * `needs_review=true` keeps only documents the human should look at:
   * status='failed', or status='ready' with classification_confidence
   * below LOW_CONFIDENCE_THRESHOLD. Combine with status= for a more
   * specific filter (e.g. status=ready + needs_review=true → just the
   * low-confidence ready ones).
   */
  needs_review?: Query<boolean>;
  /**
   * `unreviewed=true` keeps only "new" documents: status='ready' whose
   * attributes nobody has approved yet (attributes_reviewed=false). The
   * companion of needs_review for issue #635 — needs_review surfaces the
   * *uncertain* ones, unreviewed surfaces *every* AI-only attribution.
   */
  unreviewed?: Query<boolean>;
  sender?: Query<string>;
  /** Keep only documents whose persisted correspondent matches this slug (migration 0130). */
  correspondent?: Query<string>;
  date_from?: Query<string>;
  date_to?: Query<string>;
  tax_relevant?: Query<boolean>;
  /** Keep only documents linked to this Bezugsperson (see migration 0102). */
  subject_person_id?: Query<number>;
  /** Filter by category source: 'ai', 'cloud', or 'user'. */
  category_source?: Query<string>;
  sort_by?: Query<string>;
  sort_dir?: Query<string>;
  limit?: Query<number>;
  offset?: Query<number>;
}

/** Mirrors documents/document-ops.ts — keep in sync. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Fields driving the document filter panel (category, tags, status, …). */
interface DocumentFilterArgs {
  category?: string;
  tags?: string;
  status?: string;
  needs_review?: boolean;
  unreviewed?: boolean;
  sender?: string;
  correspondent?: string;
  date_from?: string;
  date_to?: string;
  tax_relevant?: boolean;
  subject_person_id?: number;
  category_source?: string;
}

/**
 * Translate the document filter panel into Drizzle WHERE conditions.
 *
 * Shared by `listDocuments` and `searchDocumentsEndpoint` so the same
 * category/tag/status/sender/date/tax/Bezugsperson filters apply whether or
 * not a full-text search term is present. The free-text `q` matching is left
 * to each caller (list uses ILIKE, search uses FTS/embeddings).
 *
 * Returns `null` when a requested tag doesn't exist — the filter can then
 * never match, so callers should short-circuit to an empty result.
 */
async function buildDocumentFilterConditions(
  f: DocumentFilterArgs,
): Promise<SQL[] | null> {
  const conds: SQL[] = [];

  if (f.status && f.status.length > 0) {
    conds.push(eq(documents.status, f.status as any));
  }
  if (f.needs_review === true) {
    const reviewCond = or(
      eq(documents.status, "failed" as any),
      and(
        eq(documents.status, "ready" as any),
        lt(documents.classification_confidence, LOW_CONFIDENCE_THRESHOLD),
      ),
    );
    if (reviewCond) conds.push(reviewCond);
  }
  if (f.unreviewed === true) {
    conds.push(
      and(
        eq(documents.status, "ready" as any),
        eq(documents.attributes_reviewed, false),
      )!,
    );
  }
  if (f.category && f.category.length > 0) {
    const cat = await dbFirst<{ id: number }>(
      db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, f.category)),
    );
    conds.push(eq(documents.category_id, cat?.id ?? -1));
  }
  if (f.sender && f.sender.trim().length > 0) {
    conds.push(ilike(documents.sender, `%${f.sender.trim()}%`));
  }
  if (f.correspondent && f.correspondent.trim().length > 0) {
    conds.push(eq(documents.correspondent_slug, f.correspondent.trim().toLowerCase()));
  }
  if (f.date_from) {
    conds.push(gte(documents.doc_date, f.date_from));
  }
  if (f.date_to) {
    conds.push(lte(documents.doc_date, f.date_to));
  }
  if (f.tax_relevant === true) {
    conds.push(eq(documents.tax_relevant, true));
  } else if (f.tax_relevant === false) {
    conds.push(eq(documents.tax_relevant, false));
  }
  if (f.subject_person_id != null) {
    conds.push(
      sql`EXISTS (
        SELECT 1 FROM ${documentSubjectPersons}
        WHERE ${documentSubjectPersons.document_id} = ${documents.id}
          AND ${documentSubjectPersons.subject_person_id} = ${f.subject_person_id}
      )`,
    );
  }

  if (f.category_source && ["ai", "cloud", "user"].includes(f.category_source)) {
    conds.push(eq(documents.category_source, f.category_source as "ai" | "cloud" | "user"));
  }

  const tagList = f.tags
    ? f.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  if (tagList.length > 0) {
    const tagRows = await dbAll<{ id: number; name: string }>(
      db.select({ id: documentTags.id, name: documentTags.name })
        .from(documentTags)
        .where(inArray(documentTags.name, tagList)),
    );
    if (tagRows.length < tagList.length) {
      return null;
    }
    // AND logic: a document must have ALL requested tags, so add one
    // EXISTS(link for that tag_id) per tag.
    for (const tagRow of tagRows) {
      conds.push(
        sql`EXISTS (
          SELECT 1 FROM ${documentTagLinks}
          WHERE ${documentTagLinks.document_id} = ${documents.id}
            AND ${documentTagLinks.tag_id} = ${tagRow.id}
        )`,
      );
    }
  }

  return conds;
}

// ─── Upload (raw) ───────────────────────────────────────────────────────────

/**
 * Stream a PDF into DOCUMENTS_DIR. The sha256 digest is computed while
 * streaming and acts as the dedup key — re-uploading the same file
 * returns 409 without touching disk twice.
 */
export const uploadDocument = api.raw(
  { expose: true, method: "POST", path: "/documents", auth: true, bodyLimit: null },
  async (req, res) => {
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const authData = getAuthData()!;
    try {
      requirePermission(authData, "documents.upload");
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Missing permission: documents.upload" }));
      return;
    }

    const userId = getUserId();
    const rawFileName = (req.headers["x-file-name"] as string) || "document.pdf";
    // Client percent-encodes the filename to stay within ISO-8859-1 header limits.
    let originalName = rawFileName;
    try {
      originalName = decodeURIComponent(rawFileName);
    } catch {
      originalName = rawFileName;
    }
    const mimeType = ((req.headers["content-type"] as string) || "application/pdf")
      .toLowerCase()
      .split(";")[0]
      .trim();

    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      res.statusCode = 415;
      res.end(JSON.stringify({ error: "Unsupported file type", message: "Nur PDF-Dateien werden unterstützt." }));
      return;
    }

    try {
      const result = await streamAndStoreDocument(req, originalName, mimeType, userId);
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (err: any) {
      if (err.message === "DOCUMENT_ALREADY_EXISTS") {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Duplicate document", message: "Dokument wurde bereits hochgeladen." }));
        return;
      }
      if (err.message === "DOCUMENT_TOO_LARGE") {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: "Payload too large", message: "Datei überschreitet die erlaubte Größe." }));
        return;
      }
      console.error("[documents] upload error:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err?.message ?? "Internal Server Error" }));
    }
  },
);

export const uploadReceiptCapture = api.raw(
  { expose: true, method: "POST", path: "/documents/receipt-capture", auth: true, bodyLimit: null },
  async (req, res) => {
    const requestStarted = performance.now();
    let timingMark = requestStarted;
    const timings: Array<{ name: string; duration: number }> = [];
    const recordTiming = (name: string) => {
      const now = performance.now();
      timings.push({ name, duration: now - timingMark });
      timingMark = now;
    };
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const authData = getAuthData()!;
    try {
      requirePermission(authData, "documents.upload");
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Missing permission: documents.upload" }));
      return;
    }

    const userId = getUserId();
    const rawFileName = (req.headers["x-file-name"] as string) || "receipt.jpg";
    let originalName = rawFileName;
    try {
      originalName = decodeURIComponent(rawFileName);
    } catch {
      originalName = rawFileName;
    }
    const rawMimeType = ((req.headers["content-type"] as string) || "application/octet-stream")
      .toLowerCase()
      .split(";")[0]
      .trim();
    const mimeType = normalizeReceiptMimeType(originalName, rawMimeType);

    // Optional: cash account chosen by the user when photographing. Persisted
    // so the background OCR worker knows which account to book the transaction to.
    // Alternatively, an existing transaction can be supplied. In that mode the
    // OCR worker links and enriches the transaction, but never changes booking
    // date, amount, counterparty or purpose.
    const rawAccountId = req.headers["x-account-id"] as string | undefined;
    const rawTransactionId = req.headers["x-transaction-id"] as string | undefined;
    let receiptAccountId: number | null = null;
    let receiptTransactionId: number | null = null;
    if (rawAccountId && rawTransactionId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Use either X-Account-Id or X-Transaction-Id, not both" }));
      return;
    }
    if (rawAccountId) {
      const parsed = parseInt(rawAccountId, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid X-Account-Id header" }));
        return;
      }
      const account = await dbFirst<{ account_id: number }>(
        db.select({ account_id: financeAccountAccess.account_id })
          .from(financeAccountAccess)
          .where(and(eq(financeAccountAccess.account_id, parsed), eq(financeAccountAccess.user_id, userId))),
      );
      if (!account) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Account not found" }));
        return;
      }
      receiptAccountId = parsed;
    }
    if (rawTransactionId) {
      const parsed = parseInt(rawTransactionId, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid X-Transaction-Id header" }));
        return;
      }
      const transaction = await dbFirst<{ id: number }>(
        db.select({ id: financeTransaction.id })
          .from(financeTransaction)
          .innerJoin(financeAccountAccess, eq(financeAccountAccess.account_id, financeTransaction.account_id))
          .where(and(
            eq(financeTransaction.id, parsed),
            eq(financeAccountAccess.user_id, userId),
          )),
      );
      if (!transaction) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Transaction not found" }));
        return;
      }
      receiptTransactionId = parsed;
    }
    recordTiming("account");

    if (!RECEIPT_CAPTURE_MIME_TYPES.has(mimeType)) {
      res.statusCode = 415;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "Unsupported file type",
        message: "Bitte ein Foto (JPEG/PNG/WebP/HEIC) oder PDF auswählen.",
      }));
      return;
    }

    try {
      const raw = await readRequestBuffer(req);
      recordTiming("upload");
      const file = mimeType === "application/pdf"
        ? { buffer: raw, originalName, mimeType }
        : {
            buffer: await imageToReceiptPdf(raw, mimeType),
            originalName: receiptPdfFilename(originalName),
            mimeType: "application/pdf",
          };
      recordTiming("convert");
      const receiptCategory = await dbFirst<{ id: number }>(
        db.select({ id: documentCategories.id })
          .from(documentCategories)
          .where(eq(documentCategories.slug, "belege")),
      );
      if (!receiptCategory) {
        throw new Error("receipt category 'belege' not found");
      }
      recordTiming("category");
      const capturePlan = buildReceiptCapturePlan(receiptCategory.id, receiptAccountId, receiptTransactionId);
      const result = await storeDocumentBuffer({
        buffer: file.buffer,
        originalName: file.originalName,
        mimeType: file.mimeType,
        userId,
        scanPriority: RECEIPT_CAPTURE_PRIORITY,
        categoryId: capturePlan.categoryId,
        receiptAccountId: capturePlan.receiptAccountId,
        receiptTransactionId: capturePlan.receiptTransactionId,
        receiptOcrState: capturePlan.receiptOcrState,
        // Cash-account captures are handled exclusively by PaddleOCR. The
        // receipt worker also warms the thumbnail and persists Paddle's raw
        // text, so running the Tesseract text_extract job would duplicate OCR.
        scanServices: capturePlan.scanServices,
      });
      recordTiming("store");
      if (receiptTransactionId != null) {
        await db
          .insert(financeTransactionDocument)
          .values({ transaction_id: receiptTransactionId, document_id: result.id })
          .onConflictDoNothing();
      }
      const totalDuration = performance.now() - requestStarted;
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Server-Timing",
        [...timings, { name: "total", duration: totalDuration }]
          .map(({ name, duration }) => `${name};dur=${duration.toFixed(1)}`)
          .join(", "),
      );
      console.log(
        `[documents] receipt capture accepted doc=${result.id} mime=${mimeType} bytes=${raw.length} ` +
        [...timings, { name: "total", duration: totalDuration }]
          .map(({ name, duration }) => `${name}=${Math.round(duration)}ms`)
          .join(" "),
      );
      res.end(JSON.stringify(result));
    } catch (err: any) {
      if (err.message === "DOCUMENT_ALREADY_EXISTS") {
        res.statusCode = 409;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Duplicate document", message: "Dokument wurde bereits hochgeladen." }));
        return;
      }
      if (err.message === "DOCUMENT_TOO_LARGE") {
        res.statusCode = 413;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Payload too large", message: "Datei überschreitet die erlaubte Größe." }));
        return;
      }
      console.error("[documents] receipt capture upload error:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err?.message ?? "Internal Server Error" }));
    }
  },
);

// ─── Fast receipt OCR extraction via dedicated service ───────────────────────

export const extractReceiptOcr = api.raw(
  { expose: true, method: "POST", path: "/documents/receipt-ocr", auth: true, bodyLimit: null },
  async (req, res) => {
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const authData = getAuthData()!;
    try {
      requirePermission(authData, "documents.upload");
    } catch {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "Missing permission: documents.upload" }));
      return;
    }

    try {
      // Consume the uploaded image FIRST, before any other await. Deferring
      // the raw body read behind another async operation (the dynamic import
      // or the health probe below) leaves the request body stream unread; the
      // request then hangs indefinitely and never reaches extractReceipt — so
      // nothing ever shows up in the receipt-ocr-service log. The sibling
      // /documents/receipt-capture endpoint reads the body first for exactly
      // this reason; keep the two in sync.
      const raw = await readRequestBuffer(req);
      const fileName = (req.headers["x-file-name"] as string) || "receipt.jpg";
      const mimeType = ((req.headers["content-type"] as string) || "image/jpeg")
        .toLowerCase()
        .split(";")[0]
        .trim();

      const { extractReceipt, isReceiptOcrHealthy } = await import("./receipt-ocr-client");

      const healthy = await isReceiptOcrHealthy();
      if (!healthy) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "receipt-ocr-service unavailable" }));
        return;
      }

      const result = await extractReceipt(Buffer.from(raw), fileName, mimeType);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } catch (err: any) {
      console.error("[documents] receipt-ocr extraction error:", err);
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err?.message ?? "receipt-ocr-service error" }));
    }
  },
);

interface ReceiptOcrItemsRequest {
  /** The `raw_text` returned by /documents/receipt-ocr, so no re-OCR is needed. */
  text: string;
}

interface ReceiptOcrItemsResponse {
  items: { name: string; amount: number }[];
}

// Second-stage line-item extraction. Called asynchronously by the client after
// the core fields (amount/date/store) have come back, so the heavy item
// generation never blocks saving the transaction. Best-effort: any failure
// yields an empty list rather than an error the UI has to handle.
export const extractReceiptOcrItems = api(
  { expose: true, method: "POST", path: "/documents/receipt-ocr-items", auth: true },
  async (req: ReceiptOcrItemsRequest): Promise<ReceiptOcrItemsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.upload");

    const text = (req.text || "").trim();
    if (!text) return { items: [] };

    try {
      const { extractReceiptItems } = await import("./receipt-ocr-client");
      const result = await extractReceiptItems(text);
      return { items: result.items };
    } catch (err: any) {
      console.warn("[documents] receipt-ocr items extraction failed:", err?.message ?? err);
      return { items: [] };
    }
  },
);

async function streamAndStoreDocument(
  req: NodeJS.ReadableStream,
  originalName: string,
  mimeType: string,
  userId: number,
): Promise<DocumentSummary> {
  const buffer = await readRequestBuffer(req);
  return storeDocumentBuffer({ buffer, originalName, mimeType, userId });
}

async function storeDocumentBuffer(params: {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  userId: number;
  scanPriority?: number;
  scanServices?: readonly import("./scan-queue").DocumentScanService[];
  /** Initial category set before workers can observe the row. */
  categoryId?: number | null;
  /** Receipt metadata set in the INSERT, before enqueue/trigger. */
  receiptAccountId?: number | null;
  receiptTransactionId?: number | null;
  receiptOcrState?: "pending" | null;
}): Promise<DocumentSummary> {
  const {
    buffer,
    originalName,
    mimeType,
    userId,
    scanPriority = 2,
    scanServices,
    categoryId = null,
    receiptAccountId = null,
    receiptTransactionId = null,
    receiptOcrState = null,
  } = params;
  if (buffer.length > DOCUMENTS_MAX_BYTES) throw new Error("DOCUMENT_TOO_LARGE");
  const ext = guessExtension(originalName, mimeType);
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");

  const existing = await dbFirst<typeof documents.$inferSelect>(
    db.select().from(documents).where(eq(documents.sha256, digest)),
  );
  if (existing) throw new Error("DOCUMENT_ALREADY_EXISTS");

  // New uploads land in the uploader's personal root by default. If the
  // user has set a default group via the upload-defaults preference and
  // is still a member of that group, the document is created with
  // `visibility='group', group_id=<pref>` directly so the file goes
  // straight to the shared root.
  const uploader = await dbFirst<{ email: string }>(
    db.select({ email: users.email }).from(users).where(eq(users.id, userId)),
  );
  const userLoginSlug = slugifyUserLogin(
    uploader?.email ?? `user-${userId}@local`,
    userId,
  );

  const defaultGroupId = await loadDefaultGroupForUser(userId);

  const ownerRootSeg = composeOwnerRootSegment({
    visibility: "private",
    userLoginSlug,
    groupSlug: null,
  });
  const { absPath, dirAbs } = getInitialUploadDiskPath(
    ownerRootSeg,
    digest,
    ext,
    new Date(),
  );
  assertPathUnderDocumentsRoot(absPath);
  await ensureDir(dirAbs);
  await fs.promises.writeFile(absPath, buffer);

  const row = await dbFirst<typeof documents.$inferSelect>(
    db
      .insert(documents)
      .values({
        user_id: userId,
        sha256: digest,
        original_filename: originalName,
        mime_type: mimeType,
        size_bytes: buffer.length,
        disk_path: absPath,
        visibility: defaultGroupId != null ? "group" : "private",
        group_id: defaultGroupId,
        category_id: categoryId,
        // These fields must be present on the row before enqueueDocumentScan
        // calls triggerWorkers. Setting them afterwards allowed a worker to
        // race the category PATCH/relocate and retain a now-stale disk_path.
        receipt_account_id: receiptAccountId,
        receipt_transaction_id: receiptTransactionId,
        receipt_ocr_state: receiptOcrState,
      })
      .returning(),
  );
  if (!row) throw new Error("insert documents: no row returned");

  // When the document was created with a group right away the file still
  // sits under the uploader's private root — relocate to the group root.
  if (defaultGroupId != null) {
    try {
      await relocateDocument(row.id);
    } catch (err) {
      console.warn(
        `[documents] upload: relocate after default-group(${row.id}) failed: ${(err as Error).message}`,
      );
    }
  }

  await enqueueDocumentScan(row.id, scanServices, scanPriority);
  triggerWorkers();

  return toSummary(row, null, []);
}

async function readRequestBuffer(req: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === "string"
        ? Buffer.from(raw, "utf8")
        : Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > DOCUMENTS_MAX_BYTES) throw new Error("DOCUMENT_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function receiptPdfFilename(originalName: string): string {
  const parsed = path.parse(originalName || "receipt");
  const stem = parsed.name || "receipt";
  return `${stem}.pdf`;
}

function normalizeReceiptMimeType(originalName: string, mimeType: string): string {
  if (mimeType === "image/jpg" || mimeType === "image/pjpeg") return "image/jpeg";
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  const ext = path.extname(originalName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  return mimeType;
}

function isHeicBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  return HEIC_BRANDS.has(buf.toString("ascii", 8, 12));
}

/**
 * Wrap a receipt photo into a single-page PDF for storage.
 *
 * Only EXIF auto-rotation + transparency flattening is applied here. Geometric
 * correction (perspective de-warp, crop, and 0/90/180/270 orientation) is done
 * later by the receipt-ocr service, which uses OpenCV contour detection and
 * PaddleOCR text orientation — far more robust than anything we can do here.
 * The worker then replaces this stored PDF with the service-corrected image
 * (see `runReceiptOcr` in document-ops.ts).
 */
async function imageToReceiptPdf(input: Buffer, mimeType: string): Promise<Buffer> {
  // Camera capture in mobile browsers is normally already JPEG. Embedding the
  // original compressed bytes directly avoids an expensive full-resolution
  // MozJPEG encode on the request path; the background receipt worker replaces
  // this provisional page with its cropped and enhanced scan.
  if (mimeType === "image/jpeg" && !isHeicBuffer(input)) {
    const meta = await sharp(input, { failOn: "none" }).metadata();
    return singleJpegPagePdf(input, meta.width || 1000, meta.height || 1000);
  }
  const image = isHeicBuffer(input)
    ? Buffer.from(await heicConvert({ buffer: input, format: "JPEG", quality: 0.9 }))
    : input;
  const { data: jpeg, info } = await sharp(image, { failOn: "none" })
    .rotate()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return singleJpegPagePdf(jpeg, info.width || 1000, info.height || 1000);
}

function extractReceiptAmount(text: string | null | undefined): number | null {
  const valuePattern = String.raw`([0-9]{1,3}(?:[. ][0-9]{3})*(?:,[0-9]{2})|[0-9]+(?:[.,][0-9]{2}))`;
  const labelled = new RegExp(
    String.raw`(?:gesamt(?:betrag|summe)?|summe|total|zu\s+zahlen|betrag|endsumme|karten(?:zahlung)?|ec-cash)\D{0,40}${valuePattern}`,
    "iu",
  );
  const source = text ?? "";
  const match = source.match(labelled);
  if (match?.[1]) return parseGermanAmount(match[1]);

  // Fallback for short receipt OCR where the label may be separated from
  // the amount by line breaks/noise: use the last plausible money value.
  const allAmounts = [...source.matchAll(new RegExp(valuePattern, "gu"))]
    .map((m) => m[1])
    .filter((value): value is string => Boolean(value))
    .map(parseGermanAmount)
    .filter((value): value is number => value != null && value > 0);
  return allAmounts.length > 0 ? allAmounts[allAmounts.length - 1] : null;
}

function parseGermanAmount(value: string): number | null {
  const normalized = value.replace(/[. ](?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

const UPLOAD_DEFAULTS_PREF_KEY = "upload_defaults";

interface UploadDefaultsPref {
  group_id: number | null;
}

/**
 * Read the configured default group for new uploads. Returns null when
 * the user has no preference, the preference is malformed, or the user
 * is no longer a member of the saved group (which we treat the same
 * as "no preference" so a stale pref doesn't fail uploads).
 */
async function loadDefaultGroupForUser(userId: number): Promise<number | null> {
  const row = await dbFirst<{ value: unknown }>(
    db
      .select({ value: documentsUserPref.value })
      .from(documentsUserPref)
      .where(
        and(
          eq(documentsUserPref.user_id, userId),
          eq(documentsUserPref.key, UPLOAD_DEFAULTS_PREF_KEY),
        ),
      ),
  );
  if (!row) return null;
  const v = row.value as UploadDefaultsPref | null;
  const groupId = v?.group_id ?? null;
  if (groupId == null) return null;
  // Still a member?
  try {
    await assertGroupMember(userId, groupId);
  } catch {
    return null;
  }
  return groupId;
}

// ─── List / get / file ──────────────────────────────────────────────────────

export const listDocuments = api(
  { expose: true, method: "GET", path: "/documents", auth: true },
  async ({ category, tags, q, status, needs_review, unreviewed, sender, correspondent, date_from, date_to, tax_relevant, subject_person_id, category_source, sort_by, sort_dir, limit, offset }: ListQuery): Promise<ListDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const lim = Math.min(Math.max(limit ?? 50, 1), 200);
    const off = Math.max(offset ?? 0, 0);
    const isAdmin = authData.permissions.includes("data.manage");
    const groupIds = isAdmin ? [] : await loadUserGroupIds(userId);
    const conds: ReturnType<typeof and>[] = isAdmin
      ? []
      : [visibleDocumentsWhere(userId, groupIds)];

    const filterConds = await buildDocumentFilterConditions({
      category, tags, status, needs_review, unreviewed, sender, correspondent, date_from, date_to, tax_relevant, subject_person_id, category_source,
    });
    if (filterConds === null) {
      // A requested tag doesn't exist — nothing can match.
      return { items: [], total: 0 };
    }
    conds.push(...filterConds);

    if (q && q.trim().length > 0) {
      const pat = `%${q.trim()}%`;
      const matchedByTitle = or(
        ilike(documents.title, pat),
        ilike(documents.sender, pat),
        ilike(documents.original_filename, pat),
        ilike(documents.summary, pat),
      );
      if (matchedByTitle) conds.push(matchedByTitle);
    }

    const VALID_SORT_FIELDS: Record<string, any> = {
      uploaded_at: documents.uploaded_at,
      doc_date: documents.doc_date,
      title: documents.title,
      sender: documents.sender,
      size_bytes: documents.size_bytes,
    };
    const sortCol = VALID_SORT_FIELDS[sort_by ?? ""] ?? documents.uploaded_at;
    const sortFn = sort_dir === "asc" ? asc : desc;

    const rows = await dbAll<typeof documents.$inferSelect & { cat_slug: string | null }>(
      db
        .select({
          id: documents.id,
          user_id: documents.user_id,
          sha256: documents.sha256,
          original_filename: documents.original_filename,
          mime_type: documents.mime_type,
          size_bytes: documents.size_bytes,
          disk_path: documents.disk_path,
          uploaded_at: documents.uploaded_at,
          status: documents.status,
          category_id: documents.category_id,
          title: documents.title,
          doc_date: documents.doc_date,
          sender: documents.sender,
          document_number: documents.document_number,
          correspondent_slug: documents.correspondent_slug,
          correspondent_display: documents.correspondent_display,
          summary: documents.summary,
          extracted_text: documents.extracted_text,
          classification_confidence: documents.classification_confidence,
          force_ocr: documents.force_ocr,
          tax_relevant: documents.tax_relevant,
          tax_year: documents.tax_year,
          tax_year_confidence: documents.tax_year_confidence,
          tax_reviewed: documents.tax_reviewed,
          visibility: documents.visibility,
          group_id: documents.group_id,
          last_error: documents.last_error,
          notes: documents.notes,
          attributes_reviewed: documents.attributes_reviewed,
          category_source: documents.category_source,
          cat_slug: documentCategories.slug,
        })
        .from(documents)
        .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
        .where(conds.length > 0 ? and(...conds) : undefined)
        .orderBy(sortFn(sortCol))
        .limit(lim)
        .offset(off),
    );

    const ids = rows.map((r) => r.id);
    const tagsByDoc = await fetchTagsForDocuments(ids);

    const countWhere = conds.length > 0
      ? sql.join(conds.map((c) => sql`(${c})`), sql` AND `)
      : sql`true`;
    const total = (
      await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text as count FROM documents WHERE ${countWhere}`,
      )
    ).rows[0];

    return {
      items: rows.map((r) => toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? [])),
      total: parseInt(total?.count ?? "0", 10),
    };
  },
);

export const getDocument = api(
  { expose: true, method: "GET", path: "/documents/:id", auth: true },
  async ({ id }: { id: number }): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const row = await loadVisibleDocument(userId, id, isDataAdmin(authData));
    const cat = row.category_id
      ? await dbFirst<{ slug: string }>(
          db.select({ slug: documentCategories.slug }).from(documentCategories).where(eq(documentCategories.id, row.category_id)),
        )
      : undefined;

    const tagsMap = await fetchTagsForDocuments([id]);
    const tags = tagsMap.get(id) ?? [];
    const taxSections = await fetchTaxSectionsForDocument(id);
    const subjectPersons = await fetchSubjectPersonsForDocument(id);

    const preview = (row.extracted_text ?? "").slice(0, 2000);
    return {
      ...toSummary(row, cat?.slug ?? null, tags),
      summary: row.summary,
      extracted_text_preview: preview.length > 0 ? preview : null,
      tax_reviewed: row.tax_reviewed ?? false,
      tax_year_confidence: row.tax_year_confidence ?? null,
      tax_sections: taxSections,
      attributes_reviewed: row.attributes_reviewed ?? false,
      subject_persons: subjectPersons,
      teacher_requested: row.teacher_requested ?? false,
    };
  },
);

export const getDocumentReceiptSuggestion = api(
  { expose: true, method: "GET", path: "/documents/:id/receipt-suggestion", auth: true },
  async ({ id }: { id: number }): Promise<DocumentReceiptSuggestion> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const row = await loadVisibleDocument(userId, id, isDataAdmin(authData));
    const cat = row.category_id
      ? await dbFirst<{ slug: string }>(
          db.select({ slug: documentCategories.slug }).from(documentCategories).where(eq(documentCategories.id, row.category_id)),
        )
      : undefined;
    const tagsMap = await fetchTagsForDocuments([id]);
    const note = [row.title, row.summary, row.original_filename]
      .map((value) => value?.trim())
      .find((value): value is string => Boolean(value)) ?? null;
    const document = toSummary(row, cat?.slug ?? null, tagsMap.get(id) ?? []);

    return {
      document,
      status: document.status,
      last_error: row.last_error ?? null,
      amount: extractReceiptAmount(row.extracted_text),
      doc_date: row.doc_date,
      sender: row.sender?.trim() || null,
      note,
    };
  },
);

/**
 * Stream the PDF back to the client. Only the owner can read it.
 * Path-traversal protection comes from the sha256-based disk path plus
 * `assertPathUnderDocumentsRoot`.
 */
export const getDocumentFile = api.raw(
  { expose: true, method: "GET", path: "/documents/:id/file", auth: true },
  async (req, res) => {
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const authData = getAuthData();
    if (!authData) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    try {
      requirePermission(authData, "documents.view");
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const userId = parseInt(authData.userID, 10);
    const m = /\/documents\/(\d+)\/file/.exec(req.url ?? "");
    const docId = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(docId)) {
      res.statusCode = 400;
      res.end("Invalid id");
      return;
    }

    try {
      const row = await loadVisibleDocument(userId, docId, isDataAdmin(authData));
      assertPathUnderDocumentsRoot(row.disk_path);
      // Prefer the generated searchable ("sandwich") PDF for regular scanned
      // documents. PaddleOCR receipt captures deliberately serve their sharp
      // native scan; a legacy Tesseract sidecar must never override it.
      const ocrPath = ocrPdfFilePath(docId);
      let servePath = row.disk_path;
      let serveType = row.mime_type || "application/pdf";
      if (shouldUseTesseractSidecar(row.receipt_ocr_state)) {
        try {
          await fs.promises.access(ocrPath, fs.constants.R_OK);
          servePath = ocrPath;
          serveType = "application/pdf";
        } catch {
          /* no sidecar — serve the original */
        }
      }
      const stat = await fs.promises.stat(servePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", serveType);
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(row.original_filename)}"`,
      );
      const stream = fs.createReadStream(servePath);
      stream.pipe(res);
      stream.on("error", (err) => {
        console.error("[documents] file stream error:", err);
        res.end();
      });
    } catch (err: any) {
      const code = err instanceof APIError ? (err as any).statusCode ?? 500 : 500;
      res.statusCode = code === 500 ? 404 : code;
      res.end(err?.message ?? "Not found");
    }
  },
);

/**
 * Download a document as an attachment. Unlike `/file` (which serves the
 * bytes inline for the viewer), this sets `Content-Disposition: attachment`
 * so the browser saves it under the original filename.
 *
 * Regular scanned documents carry a selectable text layer: when the original
 * lacks one, a searchable ("sandwich") PDF is built on demand and cached.
 * PaddleOCR receipt captures are excluded because rasterizing their prepared
 * scan through Tesseract visibly reduces thermal-print detail.
 */
export const downloadDocument = api.raw(
  { expose: true, method: "GET", path: "/documents/:id/download", auth: true },
  async (req, res) => {
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const authData = getAuthData();
    if (!authData) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    try {
      requirePermission(authData, "documents.view");
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const userId = parseInt(authData.userID, 10);
    const m = /\/documents\/(\d+)\/download/.exec(req.url ?? "");
    const docId = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(docId)) {
      res.statusCode = 400;
      res.end("Invalid id");
      return;
    }

    try {
      const row = await loadVisibleDocument(userId, docId, isDataAdmin(authData));
      assertPathUnderDocumentsRoot(row.disk_path);

      // Build (or reuse) the searchable sidecar for regular documents. Receipt
      // captures already have PaddleOCR text in their metadata and retain the
      // original prepared scan without a second OCR/rasterization pass.
      let servePath = row.disk_path;
      let serveType = row.mime_type || "application/pdf";
      const ocrPath = shouldUseTesseractSidecar(row.receipt_ocr_state)
        ? await ensureSearchablePdf(docId, row.disk_path)
        : null;
      if (ocrPath) {
        servePath = ocrPath;
        serveType = "application/pdf";
      }

      const stat = await fs.promises.stat(servePath);
      res.statusCode = 200;
      res.setHeader("Content-Type", serveType);
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(row.original_filename)}`,
      );
      const stream = fs.createReadStream(servePath);
      stream.pipe(res);
      stream.on("error", (err) => {
        console.error("[documents] download stream error:", err);
        res.end();
      });
    } catch (err: any) {
      const code = err instanceof APIError ? (err as any).statusCode ?? 500 : 500;
      res.statusCode = code === 500 ? 404 : code;
      res.end(err?.message ?? "Not found");
    }
  },
);

/**
 * Serve a small WebP preview thumbnail of page 1 of the document.
 * Used by the documents grid view (#632). Mirrors `getDocumentFile`'s
 * auth handling; the thumbnail is built lazily and cached on disk.
 *
 * Auth is accepted via the `Authorization` header or a `?token=` query
 * param so the URL can be used directly in an `<img src>` tag (browsers
 * cannot attach custom headers to image requests).
 */
export const getDocumentThumbnail = api.raw(
  { expose: true, method: "GET", path: "/documents/:id/thumbnail", auth: true },
  async (req, res) => {
    try {
      checkModule();
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const authData = getAuthData();
    if (!authData) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    try {
      requirePermission(authData, "documents.view");
    } catch {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const userId = parseInt(authData.userID, 10);
    const m = /\/documents\/(\d+)\/thumbnail/.exec(req.url ?? "");
    const docId = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(docId)) {
      res.statusCode = 400;
      res.end("Invalid id");
      return;
    }

    try {
      const row = await loadVisibleDocument(userId, docId, isDataAdmin(authData));
      const thumbPath = await ensureThumbnail(docId, row.disk_path);
      if (!thumbPath) {
        res.statusCode = 404;
        res.end("No thumbnail");
        return;
      }
      const stat = await fs.promises.stat(thumbPath);
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Cache-Control", "private, max-age=86400");
      const stream = fs.createReadStream(thumbPath);
      stream.pipe(res);
      stream.on("error", (err) => {
        console.error("[documents] thumbnail stream error:", err);
        res.end();
      });
    } catch (err: any) {
      const code = err instanceof APIError ? (err as any).statusCode ?? 500 : 500;
      res.statusCode = code === 500 ? 404 : code;
      res.end(err?.message ?? "Not found");
    }
  },
);

// ─── Mutations ──────────────────────────────────────────────────────────────

export interface UpdateDocumentRequest {
  id: number;
  title?: string | null;
  doc_date?: string | null;
  sender?: string | null;
  document_number?: string | null;
  summary?: string | null;
  category_slug?: string | null;
  tags?: string[];
  /**
   * Explicitly set the "human-pinned attributes" flag. Editing any attribute
   * above already sets it to true implicitly; send `false` to hand the
   * document back to the classifier ("let the AI decide again").
   */
  attributes_reviewed?: boolean;
  /**
   * Replace the user-curated Bezugsperson links with these subject-person ids
   * (must belong to the caller). AI-detected links are kept alongside.
   */
  subject_person_ids?: number[];
  /**
   * Free-form notes on the document (issue #750). Independent metadata —
   * editing it never pins the AI attributes and never relocates the file.
   */
  notes?: string | null;
}

export const updateDocument = api(
  { expose: true, method: "PATCH", path: "/documents/:id", auth: true },
  async (req: UpdateDocumentRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const existing = await loadVisibleDocument(userId, req.id, isDataAdmin(authData));

    const patch: Partial<typeof documents.$inferInsert> = {};
    if (req.title !== undefined) patch.title = req.title?.trim() || null;
    if (req.doc_date !== undefined) patch.doc_date = req.doc_date?.trim() || null;
    if (req.sender !== undefined) patch.sender = req.sender?.trim() || null;
    if (req.document_number !== undefined) patch.document_number = req.document_number?.trim() || null;
    if (req.summary !== undefined) patch.summary = req.summary?.trim() || null;

    if (req.category_slug !== undefined) {
      if (req.category_slug === null || req.category_slug === "") {
        patch.category_id = null;
      } else {
        const cat = await dbFirst<{ id: number }>(
          db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, req.category_slug)),
        );
        if (!cat) throw APIError.invalidArgument(`unknown category slug: ${req.category_slug}`);
        patch.category_id = cat.id;
      }
      // Mirrors cloud_teacher.py writing category_source='cloud' alongside
      // category_id: whoever sets the category value owns its provenance, so
      // the "Kategorie-Quelle" filter reflects a hand-picked category as
      // "Manuell" rather than stale "Cloud Teacher"/"KI".
      patch.category_source = "user";
    }

    // Editing any of the attributes above pins them: a re-classify must not
    // overwrite human-asserted values (mirrors tax_reviewed). The client can
    // also flip the flag explicitly — "let the AI decide again" sends
    // attributes_reviewed=false.
    const attributesChanged = Object.keys(patch).length > 0;
    if (req.attributes_reviewed !== undefined) {
      patch.attributes_reviewed = req.attributes_reviewed;
      if (req.attributes_reviewed === false) {
        // Release the category too, else a cloud/user-sourced category_source
        // keeps blocking runClassify's categoryProtected guard even though
        // attributes_reviewed no longer does — "let the AI decide again"
        // must actually let it decide again.
        patch.category_source = "ai";
      }
    } else if (attributesChanged) {
      patch.attributes_reviewed = true;
    }

    // Notes are independent metadata: applied after `attributesChanged` is
    // computed so editing only the notes neither pins the AI attributes nor
    // triggers a file relocate.
    if (req.notes !== undefined) patch.notes = req.notes?.trim() || null;

    if (Object.keys(patch).length > 0) {
      await db.update(documents).set(patch).where(eq(documents.id, existing.id));
    }

    if (req.tags !== undefined) {
      await replaceTags(existing.id, req.tags);
    }

    const subjectPersonsChanged = req.subject_person_ids !== undefined;
    if (req.subject_person_ids !== undefined) {
      await replaceUserSubjectPersons(existing.id, userId, req.subject_person_ids);
    }

    // Metadata that contributes to the canonical path may have changed;
    // move the file and rebuild tax hardlinks. `relocateDocument` is
    // idempotent when nothing actually moved. Only needed when a
    // path-affecting attribute changed, not when merely toggling the flag.
    if (attributesChanged || subjectPersonsChanged) {
      try {
        await relocateDocument(existing.id);
      } catch (err) {
        console.warn(
          `[documents] relocate after update(${existing.id}) failed: ${(err as Error).message}`,
        );
      }
    }

    return await loadDetail(userId, existing.id, isDataAdmin(authData));
  },
);

export interface SetTeacherRequestedRequest {
  id: number;
  /** true = queue for the next Cloud-Teacher run; false = un-queue. */
  requested: boolean;
}

/**
 * Flag (or un-flag) a document for the next Cloud-Teacher run. Intended for the
 * case where a user finds a document hard to classify themselves and wants the
 * offline cloud pass to take priority on it (see migration 0133). Purely a
 * request marker — the teacher still only acts on untrusted categories and
 * clears the flag once it has written a label.
 */
export const setTeacherRequested = api(
  { expose: true, method: "POST", path: "/documents/:id/teacher-request", auth: true },
  async (req: SetTeacherRequestedRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const existing = await loadVisibleDocument(userId, req.id, isDataAdmin(authData));

    await db
      .update(documents)
      .set(
        req.requested
          ? { teacher_requested: true, teacher_requested_at: new Date().toISOString() }
          : { teacher_requested: false, teacher_requested_at: null },
      )
      .where(eq(documents.id, existing.id));

    return await loadDetail(userId, existing.id, isDataAdmin(authData));
  },
);

export interface UpdateDocumentVisibilityRequest {
  id: number;
  visibility: "private" | "group";
  /** Required when `visibility='group'`; must be a group the caller belongs to. */
  group_id?: number | null;
}

/**
 * Flip a document between private (uploader-only) and group
 * (shared with every member of the named group) visibility.
 *
 * Only the original uploader or a group owner may change visibility
 * — this is a `loadAdministrableDocument` check. Moving a document
 * *into* a group additionally requires active membership in that
 * group. The physical file is relocated immediately so the
 * filesystem view matches the DB.
 */
export const updateDocumentVisibility = api(
  { expose: true, method: "POST", path: "/documents/:id/visibility", auth: true },
  async (req: UpdateDocumentVisibilityRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const existing = await loadAdministrableDocument(userId, req.id, isDataAdmin(authData));

    if (req.visibility === "group") {
      if (req.group_id == null) {
        throw APIError.invalidArgument(
          "group_id is required when visibility='group'",
        );
      }
      await assertGroupMember(userId, req.group_id);
      await db
        .update(documents)
        .set({ visibility: "group", group_id: req.group_id })
        .where(eq(documents.id, existing.id));
    } else {
      await db
        .update(documents)
        .set({ visibility: "private", group_id: null })
        .where(eq(documents.id, existing.id));
    }

    try {
      await relocateDocument(existing.id);
    } catch (err) {
      console.warn(
        `[documents] relocate after visibility change(${existing.id}) failed: ${(err as Error).message}`,
      );
    }

    return await loadDetail(userId, existing.id, isDataAdmin(authData));
  },
);

// ─── Batch updates ──────────────────────────────────────────────────────────

export interface BatchUpdateTagsRequest {
  document_ids: number[];
  /** Tag names to add to every document in `document_ids`. */
  add?: string[];
  /** Tag names to remove from every document in `document_ids`. */
  remove?: string[];
}

export interface BatchUpdateTagsResponse {
  affected_documents: number;
  added_links: number;
  removed_links: number;
}

/**
 * Add and/or remove a set of tags across multiple documents in one call.
 * Documents the caller cannot see are silently skipped — same pattern
 * as `finance.batchTag`.
 */
export const batchUpdateTags = api(
  { expose: true, method: "POST", path: "/documents/batch/tags", auth: true },
  async (req: BatchUpdateTagsRequest): Promise<BatchUpdateTagsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    if (!Array.isArray(req.document_ids) || req.document_ids.length === 0) {
      throw APIError.invalidArgument("document_ids required");
    }
    const add = (req.add ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const remove = (req.remove ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (add.length === 0 && remove.length === 0) {
      throw APIError.invalidArgument("at least one of add / remove required");
    }

    const groupIds = await loadUserGroupIds(userId);
    const visibleRows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            inArray(documents.id, req.document_ids),
            visibleDocumentsWhere(userId, groupIds),
          ),
        ),
    );
    const docIds = visibleRows.map((r) => r.id);
    if (docIds.length === 0) {
      return { affected_documents: 0, added_links: 0, removed_links: 0 };
    }

    let removedLinks = 0;
    let addedLinks = 0;

    if (remove.length > 0) {
      const tagRows = await dbAll<{ id: number }>(
        db.select({ id: documentTags.id }).from(documentTags).where(inArray(documentTags.name, remove)),
      );
      if (tagRows.length > 0) {
        const delRes = await db
          .delete(documentTagLinks)
          .where(
            and(
              inArray(documentTagLinks.document_id, docIds),
              inArray(
                documentTagLinks.tag_id,
                tagRows.map((t) => t.id),
              ),
            ),
          )
          .returning({ document_id: documentTagLinks.document_id });
        removedLinks = delRes.length;
      }
    }

    if (add.length > 0) {
      // Upsert tag rows by name.
      for (const name of add) {
        await db
          .insert(documentTags)
          .values({ name })
          .onConflictDoNothing();
      }
      const tagRows = await dbAll<{ id: number; name: string }>(
        db
          .select({ id: documentTags.id, name: documentTags.name })
          .from(documentTags)
          .where(inArray(documentTags.name, add)),
      );
      for (const docId of docIds) {
        for (const tag of tagRows) {
          const inserted = await db
            .insert(documentTagLinks)
            .values({ document_id: docId, tag_id: tag.id, source: "user" })
            .onConflictDoNothing()
            .returning({ document_id: documentTagLinks.document_id });
          if (inserted.length > 0) addedLinks++;
        }
      }
      // Tags the user explicitly added are human-curated: promote even
      // pre-existing AI links for these (document, tag) pairs to source='user'
      // so a later re-classify (which only replaces source='ai') cannot drop
      // them.
      const tagIds = tagRows.map((t) => t.id);
      if (tagIds.length > 0) {
        await db
          .update(documentTagLinks)
          .set({ source: "user" })
          .where(
            and(
              inArray(documentTagLinks.document_id, docIds),
              inArray(documentTagLinks.tag_id, tagIds),
            ),
          );
      }
    }

    return {
      affected_documents: docIds.length,
      added_links: addedLinks,
      removed_links: removedLinks,
    };
  },
);

export interface BatchUpdateVisibilityRequest {
  document_ids: number[];
  visibility: "private" | "group";
  /** Required when `visibility='group'`. */
  group_id?: number | null;
}

export interface BatchUpdateVisibilityResponse {
  affected_documents: number;
  skipped_unauthorized: number;
}

/**
 * Move multiple documents between private and a single group at once.
 * Each document is checked individually with `loadAdministrableDocument`;
 * documents the caller cannot administer are skipped silently and
 * counted in the response.
 */
export const batchUpdateVisibility = api(
  { expose: true, method: "POST", path: "/documents/batch/visibility", auth: true },
  async (req: BatchUpdateVisibilityRequest): Promise<BatchUpdateVisibilityResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    if (!Array.isArray(req.document_ids) || req.document_ids.length === 0) {
      throw APIError.invalidArgument("document_ids required");
    }
    if (req.visibility === "group") {
      if (req.group_id == null) {
        throw APIError.invalidArgument(
          "group_id is required when visibility='group'",
        );
      }
      await assertGroupMember(userId, req.group_id);
    }

    let affected = 0;
    let skipped = 0;
    for (const id of req.document_ids) {
      let row;
      try {
        row = await loadAdministrableDocument(userId, id, isDataAdmin(authData));
      } catch {
        skipped++;
        continue;
      }
      if (req.visibility === "group") {
        await db
          .update(documents)
          .set({ visibility: "group", group_id: req.group_id! })
          .where(eq(documents.id, row.id));
      } else {
        await db
          .update(documents)
          .set({ visibility: "private", group_id: null })
          .where(eq(documents.id, row.id));
      }
      try {
        await relocateDocument(row.id);
      } catch (err) {
        console.warn(
          `[documents] batch visibility: relocate(${row.id}) failed: ${(err as Error).message}`,
        );
      }
      affected++;
    }

    return { affected_documents: affected, skipped_unauthorized: skipped };
  },
);

export interface BatchReclassifyRequest {
  document_ids: number[];
  /**
   * When true, persist `force_ocr=true` on every document before
   * re-queueing so the text-extract worker skips the PDF text layer and
   * runs OCR — mirrors the single-document `force_ocr` option.
   */
  force_ocr?: boolean;
}

export interface BatchReclassifyResponse {
  affected_documents: number;
}

/**
 * Re-run the OCR / classification / embedding pipeline for multiple
 * documents at once. Documents the caller cannot see are silently
 * skipped — same visibility pattern as `batchUpdateTags`. Workers are
 * triggered once after all rows are re-queued so a large selection does
 * not fan out into one wake-up per document.
 */
export const batchReclassify = api(
  { expose: true, method: "POST", path: "/documents/batch/reclassify", auth: true },
  async (req: BatchReclassifyRequest): Promise<BatchReclassifyResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    if (!Array.isArray(req.document_ids) || req.document_ids.length === 0) {
      throw APIError.invalidArgument("document_ids required");
    }

    const groupIds = await loadUserGroupIds(userId);
    const visibleRows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            inArray(documents.id, req.document_ids),
            visibleDocumentsWhere(userId, groupIds),
          ),
        ),
    );
    const docIds = visibleRows.map((r) => r.id);
    if (docIds.length === 0) {
      return { affected_documents: 0 };
    }

    const patch: Partial<typeof documents.$inferInsert> = {
      status: "pending",
      last_error: null,
    };
    if (req.force_ocr !== undefined) patch.force_ocr = req.force_ocr;
    await db.update(documents).set(patch).where(inArray(documents.id, docIds));

    for (const id of docIds) {
      await requeueDocument(id);
    }
    triggerWorkers();

    return { affected_documents: docIds.length };
  },
);

// ─── Reclassify all documents ───────────────────────────────────────────────

export interface ReclassifyAllRequest {
  mode: "classify_only" | "full" | "resume";
}

export interface ReclassifyAllResponse {
  queued: number;
}

export interface RelocateAllDocumentsResponse {
  processed: number;
  moved: number;
  failed: number;
}

export const reclassifyAll = api(
  { expose: true, method: "POST", path: "/documents/reclassify-all", auth: true },
  async (req: ReclassifyAllRequest): Promise<ReclassifyAllResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");

    const full = req.mode === "full";
    const resume = req.mode === "resume";
    const services: readonly import("./scan-queue").DocumentScanService[] =
      full ? ["text_extract", "classify", "embed"]
      : resume ? ["text_extract", "classify", "embed"]
      : ["classify", "embed"];
    const newStatus = (full || resume) ? "pending" : "classifying";

    const baseQuery = db.select({ id: documents.id }).from(documents);
    const rows = await dbAll<{ id: number }>(
      resume
        ? baseQuery.where(ne(documents.status, "ready"))
        : baseQuery,
    );

    if (rows.length === 0) return { queued: 0 };

    const ids = rows.map((r) => r.id);
    const patch: Partial<typeof documents.$inferInsert> = {
      status: newStatus as any,
      last_error: null,
    };
    if (full) patch.force_ocr = true;
    await db.update(documents).set(patch).where(inArray(documents.id, ids));

    for (const id of ids) {
      await requeueDocument(id, services);
    }
    triggerWorkers();

    return { queued: ids.length };
  },
);

// ─── Rebuild filesystem paths for all documents ────────────────────────────

export const relocateAllDocuments = api(
  { expose: true, method: "POST", path: "/documents/relocate-all", auth: true },
  async (): Promise<RelocateAllDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");

    const rows = await dbAll<{ id: number; disk_path: string }>(
      db.select({ id: documents.id, disk_path: documents.disk_path }).from(documents),
    );

    let moved = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const nextPath = await relocateDocument(row.id);
        if (nextPath !== row.disk_path) moved++;
      } catch (err) {
        failed++;
        console.warn(
          `[documents] relocate-all: document ${row.id} failed: ${(err as Error).message}`,
        );
      }
    }

    return { processed: rows.length, moved, failed };
  },
);

// ─── Upload defaults (per-user preference) ─────────────────────────────────

export interface UploadDefaultsResponse {
  group_id: number | null;
}

export interface SetUploadDefaultsRequest {
  group_id: number | null;
}

/**
 * Get the caller's default group for new uploads. `group_id=null` means
 * new uploads stay private (no default set).
 */
export const getUploadDefaults = api(
  { expose: true, method: "GET", path: "/documents/upload-defaults", auth: true },
  async (): Promise<UploadDefaultsResponse> => {
    checkModule();
    const userId = getUserId();
    const row = await dbFirst<{ value: unknown }>(
      db
        .select({ value: documentsUserPref.value })
        .from(documentsUserPref)
        .where(
          and(
            eq(documentsUserPref.user_id, userId),
            eq(documentsUserPref.key, UPLOAD_DEFAULTS_PREF_KEY),
          ),
        ),
    );
    if (!row) return { group_id: null };
    const v = row.value as UploadDefaultsPref | null;
    return { group_id: v?.group_id ?? null };
  },
);

/**
 * Save the caller's default group for new uploads. Setting
 * `group_id=null` clears the preference (back to private). The caller
 * must currently be a member of the chosen group.
 */
export const setUploadDefaults = api(
  { expose: true, method: "PUT", path: "/documents/upload-defaults", auth: true },
  async (req: SetUploadDefaultsRequest): Promise<UploadDefaultsResponse> => {
    checkModule();
    const userId = getUserId();
    if (req.group_id != null) {
      await assertGroupMember(userId, req.group_id);
    }
    const value: UploadDefaultsPref = { group_id: req.group_id };
    await db
      .insert(documentsUserPref)
      .values({
        user_id: userId,
        key: UPLOAD_DEFAULTS_PREF_KEY,
        value,
      })
      .onConflictDoUpdate({
        target: [documentsUserPref.user_id, documentsUserPref.key],
        set: { value, updated_at: new Date().toISOString() },
      });
    return { group_id: req.group_id };
  },
);

export const deleteDocument = api(
  { expose: true, method: "DELETE", path: "/documents/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.delete");
    const userId = getUserId();

    const row = await loadAdministrableDocument(userId, id, isDataAdmin(authData));
    // Drop tax hardlinks first so we don't leave dangling entries under
    // `_steuer/` after the canonical inode is freed. The DB delete then
    // cascades through tag/tax rows via FK ON DELETE.
    try {
      await dropTaxLinks(id);
    } catch (err) {
      console.warn(
        `[documents] delete: dropTaxLinks(${id}) failed: ${(err as Error).message}`,
      );
    }
    await db.delete(documents).where(eq(documents.id, id));
    try {
      assertPathUnderDocumentsRoot(row.disk_path);
      await fs.promises.unlink(row.disk_path).catch(() => {});
      await pruneEmptyDirs(path.dirname(row.disk_path));
    } catch (err) {
      console.warn(`[documents] delete: failed to unlink ${row.disk_path}: ${(err as Error).message}`);
    }
    await removeThumbnail(id);
    await removeOcrPdf(id);
    return { success: true };
  },
);

export interface ReclassifyDocumentRequest {
  id: number;
  /**
   * When true, persist `force_ocr=true` on the document row before
   * re-queueing. The text-extract worker then skips the PDF text layer
   * and runs OCR — used to recover documents whose pre-baked text
   * layer has missing spaces or garbled glyphs.
   */
  force_ocr?: boolean;
}

export const reclassifyDocument = api(
  { expose: true, method: "POST", path: "/documents/:id/reclassify", auth: true },
  async (req: ReclassifyDocumentRequest): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    await loadVisibleDocument(userId, req.id, isDataAdmin(authData));
    const patch: Partial<typeof documents.$inferInsert> = {
      status: "pending",
      last_error: null,
    };
    if (req.force_ocr !== undefined) patch.force_ocr = req.force_ocr;
    await db.update(documents).set(patch).where(eq(documents.id, req.id));
    await requeueDocument(req.id);
    triggerWorkers();
    return { success: true };
  },
);

// ─── Replace file ───────────────────────────────────────────────────────────

/**
 * Re-read `disk_path` straight from the DB and validate it. Used by the
 * in-place file writers (`replace-file`, `unlock`) right before touching
 * the file, inside the per-document lock, so they never write to a path
 * snapshot that a concurrent relocate has since moved.
 */
async function freshDocumentDiskPath(id: number): Promise<string> {
  const row = await dbFirst<{ disk_path: string }>(
    db.select({ disk_path: documents.disk_path }).from(documents).where(eq(documents.id, id)),
  );
  if (!row) throw new Error(`document ${id} not found`);
  assertPathUnderDocumentsRoot(row.disk_path);
  return row.disk_path;
}

/**
 * Replace the PDF on disk for an existing document. Preserves the document
 * record (id, title, category, tags) but overwrites the file and re-queues
 * for full processing. Useful when the original file was lost on disk.
 */
export const replaceDocumentFile = api.raw(
  { expose: true, method: "POST", path: "/documents/:id/replace-file", auth: true, bodyLimit: null },
  async (req, res) => {
    try { checkModule(); } catch {
      res.statusCode = 403; res.end(JSON.stringify({ error: "Forbidden" })); return;
    }
    const authData = getAuthData()!;
    try { requirePermission(authData, "documents.edit"); } catch {
      res.statusCode = 403; res.end(JSON.stringify({ error: "Missing permission: documents.edit" })); return;
    }
    const userId = getUserId();
    const idMatch = (req.url ?? "").match(/\/documents\/(\d+)\/replace-file/);
    const docId = parseInt(idMatch?.[1] ?? "", 10);
    if (!docId || isNaN(docId)) {
      res.statusCode = 400; res.end(JSON.stringify({ error: "Invalid document id" })); return;
    }
    let row: typeof documents.$inferSelect;
    try {
      row = await loadAdministrableDocument(userId, docId, isDataAdmin(authData));
    } catch {
      res.statusCode = 404; res.end(JSON.stringify({ error: "Document not found" })); return;
    }

    const rawFileName = (req.headers["x-file-name"] as string) || row.original_filename;
    let originalName = rawFileName;
    try { originalName = decodeURIComponent(rawFileName); } catch { /* keep raw */ }
    const mimeType = ((req.headers["content-type"] as string) || "application/pdf")
      .toLowerCase().split(";")[0].trim();
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
      res.statusCode = 415; res.end(JSON.stringify({ error: "Unsupported file type" })); return;
    }

    const hash = crypto.createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const raw of req) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        size += chunk.length;
        if (size > DOCUMENTS_MAX_BYTES) throw new Error("DOCUMENT_TOO_LARGE");
        hash.update(chunk); chunks.push(chunk);
      }
    } catch (err: any) {
      const code = err.message === "DOCUMENT_TOO_LARGE" ? 413 : 500;
      res.statusCode = code; res.end(JSON.stringify({ error: err.message })); return;
    }
    const digest = hash.digest("hex");
    const buffer = Buffer.concat(chunks, size);

    // Reject if a DIFFERENT document already has this exact content.
    const duplicate = await dbFirst<{ id: number }>(
      db.select({ id: documents.id }).from(documents)
        .where(and(eq(documents.sha256, digest), ne(documents.id, docId))),
    );
    if (duplicate) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "Duplicate", message: "Diese Datei existiert bereits als anderes Dokument." }));
      return;
    }

    // Streaming the upload body above can take seconds, during which a
    // concurrent relocate may have moved the file. Serialize against it and
    // re-read `disk_path` fresh inside the lock so the new bytes land on the
    // file the row currently points at — not a stale snapshot path.
    try {
      await withDocumentLock(docId, async () => {
        const diskPath = await freshDocumentDiskPath(docId);
        await ensureDir(path.dirname(diskPath));
        await fs.promises.writeFile(diskPath, buffer);
        await db.update(documents).set({
          sha256: digest,
          size_bytes: size,
          original_filename: originalName,
          mime_type: mimeType,
          status: "pending",
          last_error: null,
        }).where(eq(documents.id, docId));
      });
    } catch (err: any) {
      res.statusCode = 500; res.end(JSON.stringify({ error: err?.message ?? "Write failed" })); return;
    }

    // The content changed — drop the cached searchable sidecar and preview so
    // they don't serve stale bytes. The pipeline rebuilds both on reprocess.
    await removeOcrPdf(docId);
    await removeThumbnail(docId);

    await requeueDocument(docId);
    triggerWorkers();

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true }));
  },
);

// ─── Unlock (decrypt password-protected PDF) ─────────────────────────────────

export interface UnlockDocumentRequest {
  id: number;
  password: string;
}

/**
 * Decrypt a password-protected document and store it unencrypted, so no
 * password is needed from this point on. The supplied password is used only
 * to decrypt (via qpdf) and is never persisted. On success the file is
 * replaced with its plaintext form and re-run through the pipeline
 * (text-extract → classify → embed), moving it out of the `encrypted` state.
 *
 * Returns `invalid_argument` when the password is wrong or the file can't be
 * decrypted, and `already_exists` when the decrypted content collides with a
 * different document.
 */
export const unlockDocument = api(
  { expose: true, method: "POST", path: "/documents/:id/unlock", auth: true },
  async (req: UnlockDocumentRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const password = req.password ?? "";
    if (password.length === 0) {
      throw APIError.invalidArgument("Bitte ein Passwort eingeben.");
    }

    const row = await loadAdministrableDocument(userId, req.id, isDataAdmin(authData));
    assertPathUnderDocumentsRoot(row.disk_path);

    const decrypted = await decryptPdfWithPassword(row.disk_path, password);
    if (!decrypted) {
      throw APIError.invalidArgument(
        "Falsches Passwort oder die Datei konnte nicht entschlüsselt werden.",
      );
    }

    const digest = crypto.createHash("sha256").update(decrypted).digest("hex");
    const size = decrypted.length;

    // The decrypted bytes hash differently than the encrypted original; guard
    // against colliding with another document just like replaceDocumentFile.
    const duplicate = await dbFirst<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.sha256, digest), ne(documents.id, req.id))),
    );
    if (duplicate) {
      throw APIError.alreadyExists(
        "Die entschlüsselte Datei existiert bereits als anderes Dokument.",
      );
    }

    // Serialize the in-place rewrite against any concurrent relocate and
    // re-read the path fresh inside the lock (the `row` snapshot may be
    // stale after decryption ran).
    await withDocumentLock(req.id, async () => {
      const diskPath = await freshDocumentDiskPath(req.id);
      await ensureDir(path.dirname(diskPath));
      await fs.promises.writeFile(diskPath, decrypted);
      await db
        .update(documents)
        .set({
          sha256: digest,
          size_bytes: size,
          status: "pending",
          last_error: null,
        })
        .where(eq(documents.id, req.id));
    });

    // Derived artifacts were built from the encrypted/old content — drop them.
    await removeOcrPdf(req.id);
    await removeThumbnail(req.id);

    await requeueDocument(req.id);
    triggerWorkers();

    return loadDetail(userId, req.id, isDataAdmin(authData));
  },
);

// ─── Tax override ──────────────────────────────────────────────────────────

export interface UpdateDocumentTaxRequest {
  id: number;
  tax_relevant: boolean;
  tax_year?: number | null;
  tax_sections?: string[];
}

/**
 * Manually assign tax-return metadata to a document.
 *
 * Flipping any of these fields marks the document as `tax_reviewed=true`,
 * which keeps future classifier runs from overwriting the choice. Passing
 * `tax_relevant=false` wipes the year, confidence, and all section
 * assignments so the document disappears from the Steuer view.
 */
export const updateDocumentTax = api(
  { expose: true, method: "POST", path: "/documents/:id/tax", auth: true },
  async (req: UpdateDocumentTaxRequest): Promise<DocumentDetail> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const existing = await loadVisibleDocument(userId, req.id, isDataAdmin(authData));

    let year: number | null = null;
    if (req.tax_relevant) {
      if (req.tax_year === undefined || req.tax_year === null) {
        throw APIError.invalidArgument("tax_year is required when tax_relevant=true");
      }
      if (!Number.isInteger(req.tax_year) || req.tax_year < 2000 || req.tax_year > 2100) {
        throw APIError.invalidArgument("tax_year must be an integer between 2000 and 2100");
      }
      year = req.tax_year;
    }

    const slugs = req.tax_sections ?? [];
    if (req.tax_relevant && slugs.length === 0) {
      throw APIError.invalidArgument("tax_sections must not be empty when tax_relevant=true");
    }
    for (const s of slugs) {
      if (!isValidTaxSectionSlug(s.trim().toLowerCase())) {
        throw APIError.invalidArgument(`unknown tax section slug: ${s}`);
      }
    }

    await db
      .update(documents)
      .set({
        tax_relevant: req.tax_relevant,
        tax_year: year,
        // A manual override has full confidence — the human *is* the
        // ground truth from here on.
        tax_year_confidence: req.tax_relevant ? 1 : 0,
        tax_reviewed: true,
      })
      .where(eq(documents.id, existing.id));

    if (req.tax_relevant) {
      await replaceUserTaxSections(
        existing.id,
        slugs.map((s) => s.trim().toLowerCase()),
      );
    } else {
      await replaceUserTaxSections(existing.id, []);
    }

    // Rebuild the `_steuer/` hardlink view against the new tax metadata.
    try {
      await relocateDocument(existing.id);
    } catch (err) {
      console.warn(
        `[documents] relocate after tax update(${existing.id}) failed: ${(err as Error).message}`,
      );
    }

    return await loadDetail(userId, existing.id, isDataAdmin(authData));
  },
);

// ─── Tax backfill ──────────────────────────────────────────────────────────

/**
 * Re-queue the `classify` job for every ready document the caller owns
 * whose tax status hasn't been reviewed yet. Used after rolling out the
 * tax-detection feature so existing uploads get their tax metadata
 * without the user having to re-upload.
 */
export const backfillDocumentTax = api(
  { expose: true, method: "POST", path: "/documents/tax/backfill", auth: true },
  async (): Promise<{ queued: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            visibleDocumentsWhere(userId, groupIds),
            eq(documents.status, "ready"),
            eq(documents.tax_reviewed, false),
          ),
        ),
    );
    for (const r of rows) {
      await requeueDocument(r.id, ["classify"], 3);
    }
    if (rows.length > 0) triggerWorkers();
    return { queued: rows.length };
  },
);

// ─── Embeddings backfill ───────────────────────────────────────────────────

/**
 * Re-queue the `embed` job for every ready document the caller owns and
 * drop the existing embedding rows. Used after embedding-strategy changes
 * that shift the vector space — for example switching the e5-family
 * `query: ` / `passage: ` prefix on/off, changing chunk overlap, or
 * migrating the column type from `vector` to `halfvec`. Idempotent: a
 * second run just re-runs the embed workers on the same rows.
 *
 * The job is scoped to the caller's visible documents; an admin can run
 * it per user. The previous embeddings are deleted up-front so that
 * search keeps returning *something* during the rebuild — partial new
 * vectors live alongside no old vectors, which is preferable to mixing
 * old and new vectors in the same ranking.
 */
export const backfillDocumentEmbeddings = api(
  { expose: true, method: "POST", path: "/documents/embeddings/backfill", auth: true },
  async (): Promise<{ queued: number; cleared: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            visibleDocumentsWhere(userId, groupIds),
            eq(documents.status, "ready"),
          ),
        ),
    );

    let cleared = 0;
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const deleted = await db.execute<{ document_id: number }>(sql`
        DELETE FROM document_embeddings
        WHERE document_id = ANY(${ids}::int[])
        RETURNING document_id
      `);
      cleared = deleted.rows.length;
    }

    for (const r of rows) {
      await requeueDocument(r.id, ["embed"], 3);
    }
    if (rows.length > 0) triggerWorkers();
    return { queued: rows.length, cleared };
  },
);

// ─── Layout backfill ───────────────────────────────────────────────────────

export interface RelocateDocumentsResponse {
  relocated: number;
  skipped: number;
  failed: number;
}

/**
 * One-shot maintenance endpoint: walk every document visible to the
 * caller and call `relocateDocument` so files land at their canonical
 * speaking path. Run once after upgrading to the folder-structure
 * release; harmless to re-run because `relocateDocument` is idempotent.
 */
export const relocateDocumentsBackfill = api(
  { expose: true, method: "POST", path: "/documents/layout/backfill", auth: true },
  async (): Promise<RelocateDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.edit");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<{ id: number; disk_path: string }>(
      db
        .select({ id: documents.id, disk_path: documents.disk_path })
        .from(documents)
        .where(visibleDocumentsWhere(userId, groupIds)),
    );

    let relocated = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        const before = r.disk_path;
        const after = await relocateDocument(r.id);
        if (before === after) skipped += 1;
        else relocated += 1;
      } catch (err) {
        failed += 1;
        console.warn(
          `[documents] layout backfill: relocate(${r.id}) failed: ${(err as Error).message}`,
        );
      }
    }
    return { relocated, skipped, failed };
  },
);

// ─── Tax listing / grouping ────────────────────────────────────────────────

export interface TaxSectionDTO {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  hint: string;
}

/**
 * Canonical list of German tax-return sections the classifier understands.
 * Exposed so the detail view's override form can render the same set of
 * checkboxes without duplicating the list.
 */
export const listTaxSectionsCatalog = api(
  { expose: true, method: "GET", path: "/documents/tax/sections", auth: true },
  async (): Promise<{ items: TaxSectionDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    return {
      items: TAX_SECTIONS.map((s) => ({
        slug: s.slug,
        name: s.name,
        group: s.group,
        hint: s.hint,
      })),
    };
  },
);

// ─── Tax hint admin ────────────────────────────────────────────────────────

export interface TaxHintListResponse {
  items: TaxHintEntry[];
}

/**
 * List every tax-section with its default hint, effective hint and
 * whether it is currently overridden. Powers the hint admin page.
 */
export const listTaxHints = api(
  { expose: true, method: "GET", path: "/documents/tax/hints", auth: true },
  async (): Promise<TaxHintListResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    return { items: await listTaxHintEntries() };
  },
);

export interface UpdateTaxHintRequest {
  slug: string;
  hint: string;
}

/**
 * Set or replace the hint for a single tax section. The new hint is used
 * on the next classification run without a service restart.
 */
export const updateTaxHint = api(
  { expose: true, method: "PUT", path: "/documents/tax/hints/:slug", auth: true },
  async (req: UpdateTaxHintRequest): Promise<TaxHintEntry> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    if (!isValidTaxSectionSlug(req.slug)) {
      throw APIError.notFound(`unknown tax section: ${req.slug}`);
    }
    const hint = typeof req.hint === "string" ? req.hint.trim() : "";
    if (hint.length === 0) {
      throw APIError.invalidArgument("hint must not be empty");
    }
    await upsertTaxHintOverride(req.slug, hint);
    const entries = await listTaxHintEntries();
    const entry = entries.find((e) => e.slug === req.slug);
    if (!entry) throw APIError.internal("hint entry missing after upsert");
    return entry;
  },
);

export interface ResetTaxHintRequest {
  slug: string;
}

/**
 * Remove the override for a section so the canonical default from
 * `documents/tax-sections.ts` is used again on the next classify run.
 */
export const resetTaxHint = api(
  { expose: true, method: "DELETE", path: "/documents/tax/hints/:slug", auth: true },
  async (req: ResetTaxHintRequest): Promise<TaxHintEntry> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    if (!isValidTaxSectionSlug(req.slug)) {
      throw APIError.notFound(`unknown tax section: ${req.slug}`);
    }
    await deleteTaxHintOverride(req.slug);
    const entries = await listTaxHintEntries();
    const entry = entries.find((e) => e.slug === req.slug);
    if (!entry) throw APIError.internal("hint entry missing after reset");
    return entry;
  },
);

export interface ReclassifyTaxSectionRequest {
  slug: string;
  /**
   * When true, include documents the user has already manually reviewed.
   * Default false: tax-reviewed docs are locked and wouldn't change
   * anyway, so re-running them wastes LLM cycles.
   */
  include_reviewed?: boolean;
}

export interface ReclassifyTaxSectionResponse {
  queued: number;
}

/**
 * Re-queue every visible document currently assigned to `slug` for a
 * full classify run. Use this after tweaking the hint so existing
 * documents pick up the new instruction without touching each doc
 * individually.
 */
export const reclassifyTaxSection = api(
  { expose: true, method: "POST", path: "/documents/tax/hints/:slug/reclassify", auth: true },
  async (req: ReclassifyTaxSectionRequest): Promise<ReclassifyTaxSectionResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    if (!isValidTaxSectionSlug(req.slug)) {
      throw APIError.notFound(`unknown tax section: ${req.slug}`);
    }
    const userId = getUserId();
    const groupIds = await loadUserGroupIds(userId);

    const rows = await dbAll<{ id: number }>(
      db
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(
          documentTaxSections,
          eq(documentTaxSections.document_id, documents.id),
        )
        .where(
          and(
            eq(documentTaxSections.tax_section, req.slug),
            visibleDocumentsWhere(userId, groupIds),
            req.include_reviewed ? undefined : eq(documents.tax_reviewed, false),
          ),
        ),
    );

    if (rows.length === 0) return { queued: 0 };

    // Only the classify stage depends on the hint — text_extract output
    // is unchanged, so we skip re-OCR and save LLM/CPU time.
    for (const r of rows) {
      await requeueDocument(r.id, ["classify"], 3);
    }
    triggerWorkers();
    return { queued: rows.length };
  },
);

export interface TaxYearCount {
  year: number;
  count: number;
}

export interface TaxYearsResponse {
  years: TaxYearCount[];
}

/**
 * Distinct tax years for the caller, with a document count per year.
 * Used by the Steuer view's year-selector chips.
 */
export const listTaxYears = api(
  { expose: true, method: "GET", path: "/documents/tax/years", auth: true },
  async (): Promise<TaxYearsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const groupIds = await loadUserGroupIds(userId);
    const visibility = groupIds.length === 0
      ? sql`(visibility = 'private' AND user_id = ${userId})`
      : (() => {
          const groupIdArray = sql`ARRAY[${sql.join(groupIds.map((g) => sql`${g}`), sql`, `)}]::int[]`;
          return sql`(
            (visibility = 'private' AND user_id = ${userId})
            OR (visibility = 'group' AND group_id = ANY(${groupIdArray}))
          )`;
        })();
    const rows = await db.execute<{ tax_year: number; count: string }>(sql`
      SELECT tax_year, COUNT(*)::text as count
      FROM documents
      WHERE ${visibility}
        AND tax_relevant = true
        AND tax_year IS NOT NULL
      GROUP BY tax_year
      ORDER BY tax_year DESC
    `);
    return {
      years: rows.rows.map((r) => ({
        year: r.tax_year,
        count: parseInt(r.count, 10),
      })),
    };
  },
);

export interface TaxDocumentAssignmentDTO {
  document: DocumentSummary;
  confidence: number | null;
  source: "ai" | "cloud" | "user";
}

export interface TaxSectionBucket {
  slug: string;
  name: string;
  group: TaxSectionGroup;
  documents: TaxDocumentAssignmentDTO[];
}

export interface ListTaxDocumentsResponse {
  year: number | null;
  total_documents: number;
  sections: TaxSectionBucket[];
}

interface ListTaxDocumentsQuery {
  year?: Query<number>;
  section?: Query<string>;
}

/**
 * List all tax-relevant documents for the caller, grouped by German
 * tax-return section (Anlage). Sections appear in canonical order
 * (Einkünfte → Abzüge → Bescheid → Rahmen); inside each section
 * user-pinned assignments precede AI ones, then by confidence desc.
 *
 *   ?year=2025   — restrict to one tax year (omit for "all years")
 *   ?section=anlage-n — restrict to one section (still returned as a
 *                      one-element array so the client renderer stays
 *                      uniform)
 */
export const listTaxDocuments = api(
  { expose: true, method: "GET", path: "/documents/tax", auth: true },
  async ({ year, section }: ListTaxDocumentsQuery): Promise<ListTaxDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const sectionFilter =
      typeof section === "string" && section.trim().length > 0
        ? section.trim().toLowerCase()
        : null;
    if (sectionFilter !== null && !isValidTaxSectionSlug(sectionFilter)) {
      throw APIError.invalidArgument(`unknown tax section slug: ${section}`);
    }

    const yearFilter =
      typeof year === "number" && Number.isInteger(year) && year >= 2000 && year <= 2100
        ? year
        : null;

    const groupIds = await loadUserGroupIds(userId);
    const conds = [
      visibleDocumentsWhere(userId, groupIds),
      eq(documents.tax_relevant, true),
    ];
    if (yearFilter !== null) conds.push(eq(documents.tax_year, yearFilter));

    const docRows = await dbAll<typeof documents.$inferSelect & { cat_slug: string | null }>(
      db
        .select({
          id: documents.id,
          user_id: documents.user_id,
          sha256: documents.sha256,
          original_filename: documents.original_filename,
          mime_type: documents.mime_type,
          size_bytes: documents.size_bytes,
          disk_path: documents.disk_path,
          uploaded_at: documents.uploaded_at,
          status: documents.status,
          category_id: documents.category_id,
          title: documents.title,
          doc_date: documents.doc_date,
          sender: documents.sender,
          document_number: documents.document_number,
          correspondent_slug: documents.correspondent_slug,
          correspondent_display: documents.correspondent_display,
          summary: documents.summary,
          extracted_text: documents.extracted_text,
          classification_confidence: documents.classification_confidence,
          force_ocr: documents.force_ocr,
          tax_relevant: documents.tax_relevant,
          tax_year: documents.tax_year,
          tax_year_confidence: documents.tax_year_confidence,
          tax_reviewed: documents.tax_reviewed,
          visibility: documents.visibility,
          group_id: documents.group_id,
          last_error: documents.last_error,
          notes: documents.notes,
          attributes_reviewed: documents.attributes_reviewed,
          cat_slug: documentCategories.slug,
        })
        .from(documents)
        .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
        .where(and(...conds))
        .orderBy(desc(documents.doc_date), desc(documents.uploaded_at)),
    );

    if (docRows.length === 0) {
      return { year: yearFilter, total_documents: 0, sections: [] };
    }

    const docIds = docRows.map((r) => r.id);
    const tagsByDoc = await fetchTagsForDocuments(docIds);
    const summaryById = new Map<number, DocumentSummary>();
    for (const r of docRows) {
      summaryById.set(r.id, toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? []));
    }

    const assignments = await dbAll<{
      document_id: number;
      tax_section: string;
      confidence: number | null;
      source: "ai" | "cloud" | "user";
    }>(
      db
        .select({
          document_id: documentTaxSections.document_id,
          tax_section: documentTaxSections.tax_section,
          confidence: documentTaxSections.confidence,
          source: documentTaxSections.source,
        })
        .from(documentTaxSections)
        .where(inArray(documentTaxSections.document_id, docIds)),
    );

    // Index assignments by slug, dropping unknown slugs and (if
    // requested) slugs outside the section filter.
    const bySlug = new Map<string, TaxDocumentAssignmentDTO[]>();
    const slugsPresent = new Set<string>();
    for (const a of assignments) {
      if (sectionFilter !== null && a.tax_section !== sectionFilter) continue;
      if (!isValidTaxSectionSlug(a.tax_section)) continue;
      const doc = summaryById.get(a.document_id);
      if (!doc) continue;
      slugsPresent.add(a.tax_section);
      const arr = bySlug.get(a.tax_section) ?? [];
      arr.push({ document: doc, confidence: a.confidence, source: a.source });
      bySlug.set(a.tax_section, arr);
    }

    const orderedSections = orderTaxSectionSlugs(Array.from(slugsPresent));
    const sections: TaxSectionBucket[] = [];
    const distinctDocs = new Set<number>();
    for (const meta of orderedSections) {
      const docs = bySlug.get(meta.slug) ?? [];
      docs.sort((a, b) => {
        if (a.source !== b.source) return a.source === "user" ? -1 : 1;
        const ca = a.confidence ?? 0;
        const cb = b.confidence ?? 0;
        if (ca !== cb) return cb - ca;
        const da = a.document.doc_date ?? "";
        const dbb = b.document.doc_date ?? "";
        return dbb.localeCompare(da);
      });
      for (const d of docs) distinctDocs.add(d.document.id);
      sections.push({
        slug: meta.slug,
        name: meta.name,
        group: meta.group,
        documents: docs,
      });
    }

    return {
      year: yearFilter,
      total_documents: distinctDocs.size,
      sections,
    };
  },
);

// ─── Taxonomy + queue ───────────────────────────────────────────────────────

export const listDocumentCategories = api(
  { expose: true, method: "GET", path: "/document-categories", auth: true },
  async (): Promise<{ items: DocumentCategoryDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const rows = await dbAll<typeof documentCategories.$inferSelect>(
      db.select().from(documentCategories),
    );

    // `sort_order` is stored per-parent (each level starts at 0), so a flat
    // ORDER BY would interleave roots with children of other branches. Walk
    // the tree depth-first to return parent → its children → next parent.
    const childrenByParent = new Map<number | null, typeof rows>();
    for (const r of rows) {
      const key = r.parent_id ?? null;
      const list = childrenByParent.get(key);
      if (list) list.push(r);
      else childrenByParent.set(key, [r]);
    }
    const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      a.sort_order - b.sort_order || a.name.localeCompare(b.name);
    for (const list of childrenByParent.values()) list.sort(cmp);

    const ordered: typeof rows = [];
    const visit = (parentId: number | null) => {
      const children = childrenByParent.get(parentId);
      if (!children) return;
      for (const c of children) {
        ordered.push(c);
        visit(c.id);
      }
    };
    visit(null);

    return {
      items: ordered.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        parent_id: r.parent_id ?? null,
        icon: r.icon ?? null,
        sort_order: r.sort_order,
      })),
    };
  },
);

// ─── Search ─────────────────────────────────────────────────────────────────

export interface SearchDocumentSummary extends DocumentSummary {
  extracted_text_preview: string | null;
}

export interface SearchDocumentsResponse {
  items: SearchDocumentSummary[];
  mode: SearchMode;
  query: string;
}

interface SearchQuery {
  q: Query<string>;
  mode?: Query<string>;
  limit?: Query<number>;
  // Filter-panel parameters, mirrored from `ListQuery` so the filter applies
  // to search results too (otherwise searching ignored every active filter).
  category?: Query<string>;
  tags?: Query<string>;
  status?: Query<string>;
  needs_review?: Query<boolean>;
  unreviewed?: Query<boolean>;
  sender?: Query<string>;
  correspondent?: Query<string>;
  date_from?: Query<string>;
  date_to?: Query<string>;
  tax_relevant?: Query<boolean>;
  subject_person_id?: Query<number>;
  category_source?: Query<string>;
}

/**
 * Hybrid search over the caller's documents.
 *
 * `mode=fts` — lexical only (good for exact terms, invoice numbers).
 * `mode=semantic` — embedding-based (good for paraphrases).
 * `mode=hybrid` (default) — Reciprocal Rank Fusion of both branches.
 *
 * Returned documents keep the same shape as `GET /documents` so the
 * frontend can reuse the list renderer.
 */
export const searchDocumentsEndpoint = api(
  { expose: true, method: "GET", path: "/documents/search", auth: true },
  async ({ q, mode, limit, category, tags, status, needs_review, unreviewed, sender, correspondent, date_from, date_to, tax_relevant, subject_person_id, category_source }: SearchQuery): Promise<SearchDocumentsResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();

    const resolvedMode: SearchMode =
      mode === "fts" || mode === "semantic" || mode === "hybrid" ? mode : "hybrid";
    const lim = Math.min(Math.max(limit ?? 20, 1), 100);
    const query = (q ?? "").trim();
    if (query.length === 0) {
      return { items: [], mode: resolvedMode, query };
    }

    const filterConds = await buildDocumentFilterConditions({
      category, tags, status, needs_review, unreviewed, sender, correspondent, date_from, date_to, tax_relevant, subject_person_id, category_source,
    });
    if (filterConds === null) {
      // A requested tag doesn't exist — nothing can match.
      return { items: [], mode: resolvedMode, query };
    }

    const hits = await searchDocuments({
      userId,
      query,
      mode: resolvedMode,
      limit: lim,
    });
    if (hits.length === 0) {
      return { items: [], mode: resolvedMode, query };
    }

    const ids = hits.map((h) => h.document_id);
    const groupIds = await loadUserGroupIds(userId);
    const rows = await dbAll<typeof documents.$inferSelect & { cat_slug: string | null }>(
      db
        .select({
          id: documents.id,
          user_id: documents.user_id,
          sha256: documents.sha256,
          original_filename: documents.original_filename,
          mime_type: documents.mime_type,
          size_bytes: documents.size_bytes,
          disk_path: documents.disk_path,
          uploaded_at: documents.uploaded_at,
          status: documents.status,
          category_id: documents.category_id,
          title: documents.title,
          doc_date: documents.doc_date,
          sender: documents.sender,
          document_number: documents.document_number,
          correspondent_slug: documents.correspondent_slug,
          correspondent_display: documents.correspondent_display,
          summary: documents.summary,
          extracted_text: documents.extracted_text,
          classification_confidence: documents.classification_confidence,
          force_ocr: documents.force_ocr,
          tax_relevant: documents.tax_relevant,
          tax_year: documents.tax_year,
          tax_year_confidence: documents.tax_year_confidence,
          tax_reviewed: documents.tax_reviewed,
          visibility: documents.visibility,
          group_id: documents.group_id,
          last_error: documents.last_error,
          notes: documents.notes,
          attributes_reviewed: documents.attributes_reviewed,
          cat_slug: documentCategories.slug,
        })
        .from(documents)
        .leftJoin(documentCategories, eq(documents.category_id, documentCategories.id))
        .where(and(visibleDocumentsWhere(userId, groupIds), inArray(documents.id, ids), ...filterConds)),
    );

    const byId = new Map<number, (typeof rows)[number]>();
    for (const r of rows) byId.set(r.id, r);

    const tagsByDoc = await fetchTagsForDocuments(ids);

    // Preserve the ranked order — Postgres' WHERE IN is unordered.
    const items = hits
      .map((h) => {
        const r = byId.get(h.document_id);
        if (!r) return null;
        return {
          ...toSummary(r as any, r.cat_slug, tagsByDoc.get(r.id) ?? []),
          extracted_text_preview: documentTextPreview(r.summary ?? r.extracted_text),
        };
      })
      .filter((x): x is SearchDocumentSummary => x !== null);

    return { items, mode: resolvedMode, query };
  },
);

export const getDocumentQueueStatus = api(
  { expose: true, method: "GET", path: "/document-queue/status", auth: true },
  async (): Promise<QueueStatus> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    return await getQueueStatus();
  },
);

export const cancelDocumentQueue = api(
  { expose: true, method: "POST", path: "/document-queue/cancel", auth: true },
  async (): Promise<{ cancelled: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    const cancelled = await cancelPendingJobs();
    return { cancelled };
  },
);

export const retryDocumentQueue = api(
  { expose: true, method: "POST", path: "/document-queue/retry", auth: true },
  async (): Promise<{ retried: number }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "data.manage");
    const retried = await retryFailedJobs();
    triggerWorkers();
    return { retried };
  },
);

// ─── Taxonomy refinement (category suggestions) ─────────────────────────────

export interface CategorySuggestionDTO {
  id: number;
  suggested_name: string;
  parent_slug: string | null;
  example_document_ids: number[];
  rationale: string | null;
  status: "open" | "accepted" | "rejected";
  created_at: string | null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * List taxonomy refinements proposed by the classifier. Defaults to
 * `open` suggestions; pass `?status=` to surface accepted/rejected
 * for audit purposes.
 */
export const listCategorySuggestions = api(
  { expose: true, method: "GET", path: "/document-category-suggestions", auth: true },
  async ({ status }: { status?: Query<string> }): Promise<{ items: CategorySuggestionDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const filter = status === "accepted" || status === "rejected" ? status : "open";
    const rows = await dbAll<typeof documentCategorySuggestions.$inferSelect>(
      db
        .select()
        .from(documentCategorySuggestions)
        .where(eq(documentCategorySuggestions.status, filter as any))
        .orderBy(desc(documentCategorySuggestions.created_at)),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        suggested_name: r.suggested_name,
        parent_slug: r.parent_slug,
        example_document_ids: r.example_document_ids ?? [],
        rationale: r.rationale,
        status: r.status,
        created_at: r.created_at ?? null,
      })),
    };
  },
);

export interface AcceptSuggestionRequest {
  id: number;
  /** Optional admin override for the auto-derived slug. */
  slug?: string;
  /** Optional admin override for the suggested name. */
  name?: string;
}

/**
 * Accept a category suggestion: create the new `document_categories`
 * row (if no slug collision) and mark the suggestion as accepted.
 * Returns the new category id so the UI can offer a follow-up
 * "reclassify these examples" action.
 */
export const acceptCategorySuggestion = api(
  { expose: true, method: "POST", path: "/document-category-suggestions/:id/accept", auth: true },
  async (req: AcceptSuggestionRequest): Promise<{ category_id: number; slug: string }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const suggestion = await dbFirst<typeof documentCategorySuggestions.$inferSelect>(
      db.select().from(documentCategorySuggestions).where(eq(documentCategorySuggestions.id, req.id)),
    );
    if (!suggestion) throw APIError.notFound("suggestion not found");
    if (suggestion.status !== "open") {
      throw APIError.failedPrecondition(`suggestion is ${suggestion.status}`);
    }

    const name = (req.name ?? suggestion.suggested_name).trim();
    if (!name) throw APIError.invalidArgument("name must not be empty");
    const slug = (req.slug ?? slugify(name)).trim();
    if (!slug) throw APIError.invalidArgument("slug must not be empty");

    let parentId: number | null = null;
    if (suggestion.parent_slug) {
      const parent = await dbFirst<{ id: number }>(
        db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, suggestion.parent_slug)),
      );
      parentId = parent?.id ?? null;
    }

    const existing = await dbFirst<{ id: number }>(
      db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.slug, slug)),
    );
    let categoryId: number;
    if (existing) {
      categoryId = existing.id;
    } else {
      const inserted = await dbFirst<{ id: number }>(
        db
          .insert(documentCategories)
          .values({ slug, name, parent_id: parentId })
          .returning({ id: documentCategories.id }),
      );
      if (!inserted) throw new Error("insert documentCategories: no row returned");
      categoryId = inserted.id;
    }

    await db
      .update(documentCategorySuggestions)
      .set({ status: "accepted" })
      .where(eq(documentCategorySuggestions.id, req.id));

    return { category_id: categoryId, slug };
  },
);

export const rejectCategorySuggestion = api(
  { expose: true, method: "POST", path: "/document-category-suggestions/:id/reject", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const updated = await db
      .update(documentCategorySuggestions)
      .set({ status: "rejected" })
      .where(and(eq(documentCategorySuggestions.id, id), eq(documentCategorySuggestions.status, "open")));
    if ((updated as any)?.rowCount === 0) {
      throw APIError.failedPrecondition("suggestion is not open");
    }
    return { success: true };
  },
);

// ─── Hint suggestions (mined from reviewed docs) ────────────────────────────

export interface HintSuggestionDTO {
  id: number;
  kind: "tax-section" | "category";
  target_slug: string;
  draft_hint: string;
  rationale: string | null;
  example_document_ids: number[];
  status: "open" | "accepted" | "rejected";
  created_at: string | null;
  updated_at: string | null;
}

export const listHintSuggestions = api(
  { expose: true, method: "GET", path: "/document-hint-suggestions", auth: true },
  async ({ status, kind }: {
    status?: Query<string>;
    kind?: Query<string>;
  }): Promise<{ items: HintSuggestionDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const conditions: SQL[] = [];
    const filterStatus = status === "accepted" || status === "rejected" ? status : "open";
    conditions.push(eq(documentHintSuggestions.status, filterStatus as any));
    if (kind === "tax-section" || kind === "category") {
      conditions.push(eq(documentHintSuggestions.kind, kind));
    }

    const rows = await dbAll<typeof documentHintSuggestions.$inferSelect>(
      db
        .select()
        .from(documentHintSuggestions)
        .where(and(...conditions))
        .orderBy(desc(documentHintSuggestions.updated_at)),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind as "tax-section" | "category",
        target_slug: r.target_slug,
        draft_hint: r.draft_hint,
        rationale: r.rationale,
        example_document_ids: r.example_document_ids ?? [],
        status: r.status,
        created_at: r.created_at ?? null,
        updated_at: r.updated_at ?? null,
      })),
    };
  },
);

export const acceptHintSuggestion = api(
  { expose: true, method: "POST", path: "/document-hint-suggestions/:id/accept", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const suggestion = await dbFirst<typeof documentHintSuggestions.$inferSelect>(
      db.select().from(documentHintSuggestions).where(eq(documentHintSuggestions.id, id)),
    );
    if (!suggestion) throw APIError.notFound("hint suggestion not found");
    if (suggestion.status !== "open") {
      throw APIError.failedPrecondition(`suggestion is ${suggestion.status}`);
    }

    await db
      .update(documentHintSuggestions)
      .set({ status: "accepted", updated_at: new Date().toISOString() })
      .where(eq(documentHintSuggestions.id, id));

    return { success: true };
  },
);

export const rejectHintSuggestion = api(
  { expose: true, method: "POST", path: "/document-hint-suggestions/:id/reject", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");

    const updated = await db
      .update(documentHintSuggestions)
      .set({ status: "rejected", updated_at: new Date().toISOString() })
      .where(and(eq(documentHintSuggestions.id, id), eq(documentHintSuggestions.status, "open")));
    if ((updated as any)?.rowCount === 0) {
      throw APIError.failedPrecondition("suggestion is not open");
    }
    return { success: true };
  },
);

// ─── Subject persons (Bezugspersonen) ──────────────────────────────────────

export interface SubjectPersonDTO {
  id: number;
  full_name: string;
  relation_tag: string;
  created_at: string;
  updated_at: string;
}

export interface SubjectPersonListResponse {
  items: SubjectPersonDTO[];
}

export interface CreateSubjectPersonRequest {
  full_name: string;
  relation_tag: string;
}

export interface UpdateSubjectPersonRequest {
  id: number;
  full_name?: string;
  relation_tag?: string;
}

export interface DeleteSubjectPersonRequest {
  id: number;
}

async function documentIdsForOwnedSubjectPerson(
  userId: number,
  subjectPersonId: number,
): Promise<number[]> {
  const rows = await dbAll<{ document_id: number }>(
    db
      .select({ document_id: documentSubjectPersons.document_id })
      .from(documentSubjectPersons)
      .innerJoin(
        userSubjectPersons,
        eq(userSubjectPersons.id, documentSubjectPersons.subject_person_id),
      )
      .where(
        and(
          eq(documentSubjectPersons.subject_person_id, subjectPersonId),
          eq(userSubjectPersons.user_id, userId),
        ),
      ),
  );
  return rows.map((row) => row.document_id);
}

async function relocateSubjectPersonDocuments(documentIds: readonly number[]): Promise<void> {
  for (const documentId of documentIds) {
    try {
      await relocateDocument(documentId);
    } catch (err) {
      console.warn(
        `[documents] relocate after subject-person change(${documentId}) failed: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * List the caller's "Bezugspersonen" — the mapping of names that
 * appear on documents (e.g. "Erika Mustermann") to relationship tags
 * (e.g. "mutter") that the classifier should add as document tags
 * whenever it encounters the corresponding name on a page.
 */
export const listSubjectPersonsEndpoint = api(
  { expose: true, method: "GET", path: "/documents/subject-persons", auth: true },
  async (): Promise<SubjectPersonListResponse> => {
    checkModule();
    const userId = getUserId();
    const items = await listSubjectPersons(userId);
    return { items };
  },
);

export const createSubjectPersonEndpoint = api(
  { expose: true, method: "POST", path: "/documents/subject-persons", auth: true },
  async (req: CreateSubjectPersonRequest): Promise<SubjectPersonDTO> => {
    checkModule();
    const userId = getUserId();
    return await createSubjectPerson(userId, req);
  },
);

export const updateSubjectPersonEndpoint = api(
  { expose: true, method: "PATCH", path: "/documents/subject-persons/:id", auth: true },
  async (req: UpdateSubjectPersonRequest): Promise<SubjectPersonDTO> => {
    checkModule();
    const userId = getUserId();
    const affectedDocumentIds = req.full_name !== undefined
      ? await documentIdsForOwnedSubjectPerson(userId, req.id)
      : [];
    const updated = await updateSubjectPerson(userId, req.id, {
      full_name: req.full_name,
      relation_tag: req.relation_tag,
    });
    await relocateSubjectPersonDocuments(affectedDocumentIds);
    return updated;
  },
);

export const deleteSubjectPersonEndpoint = api(
  { expose: true, method: "DELETE", path: "/documents/subject-persons/:id", auth: true },
  async (req: DeleteSubjectPersonRequest): Promise<{ success: boolean }> => {
    checkModule();
    const userId = getUserId();
    const affectedDocumentIds = await documentIdsForOwnedSubjectPerson(userId, req.id);
    await deleteSubjectPerson(userId, req.id);
    await relocateSubjectPersonDocuments(affectedDocumentIds);
    return { success: true };
  },
);

// ─── Internal helpers ───────────────────────────────────────────────────────

async function loadDetail(userId: number, id: number, isAdmin = false): Promise<DocumentDetail> {
  const row = await loadVisibleDocument(userId, id, isAdmin);
  const cat = row.category_id
    ? await dbFirst<{ slug: string }>(
        db.select({ slug: documentCategories.slug }).from(documentCategories).where(eq(documentCategories.id, row.category_id)),
      )
    : undefined;
  const tagsMap = await fetchTagsForDocuments([id]);
  const taxSections = await fetchTaxSectionsForDocument(id);
  const subjectPersons = await fetchSubjectPersonsForDocument(id);
  const preview = (row.extracted_text ?? "").slice(0, 2000);
  return {
    ...toSummary(row, cat?.slug ?? null, tagsMap.get(id) ?? []),
    summary: row.summary,
    extracted_text_preview: preview.length > 0 ? preview : null,
    tax_reviewed: row.tax_reviewed ?? false,
    tax_year_confidence: row.tax_year_confidence ?? null,
    tax_sections: taxSections,
    attributes_reviewed: row.attributes_reviewed ?? false,
    subject_persons: subjectPersons,
    teacher_requested: row.teacher_requested ?? false,
  };
}

// Manual tag editing (PATCH /documents/:id): the caller submits the full
// desired tag set, so every resulting link is human-curated and written with
// source='user'. That marks them as owned by the user, so a later re-classify
// (replaceTagLinks, which only touches source='ai') leaves them intact.
async function replaceTags(documentId: number, tags: readonly string[]): Promise<void> {
  await db.delete(documentTagLinks).where(eq(documentTagLinks.document_id, documentId));
  const seen = new Set<string>();
  for (const raw of tags) {
    const name = raw.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const inserted = await db
      .insert(documentTags)
      .values({ name })
      .onConflictDoNothing()
      .returning({ id: documentTags.id });
    let tagId: number | undefined = inserted[0]?.id;
    if (tagId === undefined) {
      const found = await dbFirst<{ id: number }>(
        db.select({ id: documentTags.id }).from(documentTags).where(eq(documentTags.name, name)),
      );
      tagId = found?.id;
    }
    if (tagId === undefined) continue;
    await db
      .insert(documentTagLinks)
      .values({ document_id: documentId, tag_id: tagId, source: "user" })
      .onConflictDoNothing();
  }
}

export function toSummary(
  row: typeof documents.$inferSelect,
  categorySlug: string | null,
  tags: string[],
): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    status: row.status,
    uploaded_at: row.uploaded_at ?? null,
    doc_date: row.doc_date,
    sender: row.sender,
    document_number: row.document_number ?? null,
    correspondent_slug: row.correspondent_slug ?? null,
    correspondent_display: row.correspondent_display ?? null,
    category_id: row.category_id,
    category_slug: categorySlug,
    classification_confidence: row.classification_confidence,
    tags,
    tax_relevant: row.tax_relevant ?? false,
    tax_year: row.tax_year ?? null,
    last_error: row.last_error ?? null,
    visibility: row.visibility,
    group_id: row.group_id,
    notes: row.notes ?? null,
    attributes_reviewed: row.attributes_reviewed ?? false,
    category_source: row.category_source ?? "ai",
  };
}

async function fetchTaxSectionsForDocument(documentId: number): Promise<DocumentTaxSectionDTO[]> {
  const rows = await dbAll<{
    tax_section: string;
    confidence: number | null;
    source: "ai" | "cloud" | "user";
  }>(
    db
      .select({
        tax_section: documentTaxSections.tax_section,
        confidence: documentTaxSections.confidence,
        source: documentTaxSections.source,
      })
      .from(documentTaxSections)
      .where(eq(documentTaxSections.document_id, documentId)),
  );
  const items: DocumentTaxSectionDTO[] = [];
  for (const r of rows) {
    const meta = findTaxSection(r.tax_section);
    if (!meta) continue;
    items.push({
      slug: meta.slug,
      name: meta.name,
      group: meta.group,
      confidence: r.confidence,
      source: r.source,
    });
  }
  // Sort: user-sourced first, then descending confidence, stable by slug.
  items.sort((a, b) => {
    if (a.source !== b.source) return a.source === "user" ? -1 : 1;
    const ca = a.confidence ?? 0;
    const cb = b.confidence ?? 0;
    if (ca !== cb) return cb - ca;
    return a.slug.localeCompare(b.slug);
  });
  return items;
}

async function fetchSubjectPersonsForDocument(
  documentId: number,
): Promise<DocumentSubjectPersonDTO[]> {
  const rows = await dbAll<DocumentSubjectPersonDTO>(
    db
      .select({
        id: userSubjectPersons.id,
        full_name: userSubjectPersons.full_name,
        relation_tag: userSubjectPersons.relation_tag,
        source: documentSubjectPersons.source,
      })
      .from(documentSubjectPersons)
      .innerJoin(
        userSubjectPersons,
        eq(userSubjectPersons.id, documentSubjectPersons.subject_person_id),
      )
      .where(eq(documentSubjectPersons.document_id, documentId))
      .orderBy(asc(userSubjectPersons.full_name)),
  );
  // User-curated links first, then by name.
  rows.sort((a, b) => {
    if (a.source !== b.source) return a.source === "user" ? -1 : 1;
    return a.full_name.localeCompare(b.full_name);
  });
  return rows;
}

/**
 * Replace the user-source Bezugsperson links of a document with `ids`. Only ids
 * that belong to `userId` are accepted; AI-source links are left untouched so a
 * re-classify's detections remain alongside the manual selection.
 */
async function replaceUserSubjectPersons(
  documentId: number,
  userId: number,
  ids: readonly number[],
): Promise<void> {
  const unique = [...new Set(ids)];
  const owned =
    unique.length === 0
      ? []
      : (
          await dbAll<{ id: number }>(
            db
              .select({ id: userSubjectPersons.id })
              .from(userSubjectPersons)
              .where(
                and(
                  eq(userSubjectPersons.user_id, userId),
                  inArray(userSubjectPersons.id, unique),
                ),
              ),
          )
        ).map((r) => r.id);

  await db
    .delete(documentSubjectPersons)
    .where(
      and(
        eq(documentSubjectPersons.document_id, documentId),
        eq(documentSubjectPersons.source, "user"),
      ),
    );

  for (const id of owned) {
    await db
      .insert(documentSubjectPersons)
      .values({ document_id: documentId, subject_person_id: id, source: "user" })
      .onConflictDoUpdate({
        target: [documentSubjectPersons.document_id, documentSubjectPersons.subject_person_id],
        set: { source: "user" },
      });
  }
}

// ─── Correspondents: facet + user overrides ────────────────────────────────

export interface CorrespondentFacet {
  slug: string;
  display: string;
  count: number;
}

export interface CorrespondentFacetResponse {
  items: CorrespondentFacet[];
}

/**
 * Distinct correspondents across the caller's visible documents, with a
 * document count each (most frequent first). Powers the "nach Korrespondent"
 * filter facet in the document list. Reads the persisted
 * `correspondent_slug`/`correspondent_display` columns (migration 0130).
 */
export const listCorrespondents = api(
  { expose: true, method: "GET", path: "/documents/correspondents", auth: true },
  async (): Promise<CorrespondentFacetResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.view");
    const userId = getUserId();
    const groupIds = await loadUserGroupIds(userId);

    const rows = await dbAll<{ slug: string | null; display: string | null; count: number }>(
      db
        .select({
          slug: documents.correspondent_slug,
          display: sql<string>`max(${documents.correspondent_display})`,
          count: sql<number>`count(*)::int`,
        })
        .from(documents)
        .where(
          and(
            visibleDocumentsWhere(userId, groupIds),
            sql`${documents.correspondent_slug} IS NOT NULL`,
          ),
        )
        .groupBy(documents.correspondent_slug)
        .orderBy(sql`count(*) DESC`),
    );

    return {
      items: rows
        .filter((r): r is { slug: string; display: string | null; count: number } => r.slug != null)
        .map((r) => ({ slug: r.slug, display: r.display ?? r.slug, count: Number(r.count) })),
    };
  },
);

export interface CorrespondentOverrideDTO {
  id: number;
  sender_pattern: string;
  correspondent_slug: string;
  correspondent_display: string;
}

export interface CorrespondentOverrideListResponse {
  items: CorrespondentOverrideDTO[];
}

/** List the household's correspondent overrides (admin/taxonomy management). */
export const listCorrespondentOverrides = api(
  { expose: true, method: "GET", path: "/documents/correspondent-overrides", auth: true },
  async (): Promise<CorrespondentOverrideListResponse> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    const items = await dbAll<CorrespondentOverrideDTO>(
      db
        .select({
          id: documentCorrespondentOverrides.id,
          sender_pattern: documentCorrespondentOverrides.sender_pattern,
          correspondent_slug: documentCorrespondentOverrides.correspondent_slug,
          correspondent_display: documentCorrespondentOverrides.correspondent_display,
        })
        .from(documentCorrespondentOverrides)
        .orderBy(asc(documentCorrespondentOverrides.sender_pattern)),
    );
    return { items };
  },
);

export interface CreateCorrespondentOverrideRequest {
  /** Free-form sender fragment; normalised server-side (e.g. "Janitos AG" → "janitosag"). */
  sender_pattern: string;
  /** Human-readable correspondent name (e.g. "Janitos"). */
  correspondent_display: string;
  /** Optional explicit slug; derived from the display name when omitted. */
  correspondent_slug?: string;
}

/**
 * Create or replace (upsert on sender_pattern) a correspondent override.
 * Takes effect the next time an affected document is relocated — run the
 * "Dateipfade aktualisieren" backfill to apply it across the corpus.
 */
export const createCorrespondentOverride = api(
  { expose: true, method: "POST", path: "/documents/correspondent-overrides", auth: true },
  async (req: CreateCorrespondentOverrideRequest): Promise<CorrespondentOverrideDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    const userId = getUserId();

    const pattern = normalizeForMatch(req.sender_pattern);
    if (pattern.length < 2) {
      throw APIError.invalidArgument("sender_pattern must have at least 2 usable characters");
    }
    const display = (req.correspondent_display ?? "").trim();
    if (display.length === 0) {
      throw APIError.invalidArgument("correspondent_display must not be empty");
    }
    const slug = slugifyName(
      req.correspondent_slug && req.correspondent_slug.trim().length > 0
        ? req.correspondent_slug
        : display,
      40,
    );
    if (slug.length === 0) {
      throw APIError.invalidArgument("correspondent_slug reduces to empty");
    }

    const existing = await dbFirst<{ id: number }>(
      db
        .select({ id: documentCorrespondentOverrides.id })
        .from(documentCorrespondentOverrides)
        .where(eq(documentCorrespondentOverrides.sender_pattern, pattern)),
    );
    let id: number;
    if (existing) {
      await db
        .update(documentCorrespondentOverrides)
        .set({ correspondent_slug: slug, correspondent_display: display })
        .where(eq(documentCorrespondentOverrides.id, existing.id));
      id = existing.id;
    } else {
      const inserted = await db
        .insert(documentCorrespondentOverrides)
        .values({
          sender_pattern: pattern,
          correspondent_slug: slug,
          correspondent_display: display,
          created_by: userId,
        })
        .returning({ id: documentCorrespondentOverrides.id });
      id = inserted[0].id;
    }
    invalidateCorrespondentOverridesCache();
    return { id, sender_pattern: pattern, correspondent_slug: slug, correspondent_display: display };
  },
);

export interface DeleteCorrespondentOverrideRequest {
  id: number;
}

/** Remove a correspondent override; affected documents revert to the registry. */
export const deleteCorrespondentOverride = api(
  { expose: true, method: "DELETE", path: "/documents/correspondent-overrides/:id", auth: true },
  async (req: DeleteCorrespondentOverrideRequest): Promise<{ deleted: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "documents.manage_taxonomy");
    await db
      .delete(documentCorrespondentOverrides)
      .where(eq(documentCorrespondentOverrides.id, req.id));
    invalidateCorrespondentOverridesCache();
    return { deleted: true };
  },
);
