/**
 * Storage-layout helpers and constants for the documents module.
 *
 * Documents live under `DOCUMENTS_DIR` in a *speaking* folder tree:
 *
 *   DOCUMENTS_DIR/
 *   ├── _gruppe/<group-slug>/<category-path>/<year>/<name>.pdf
 *   └── <user-login-slug>/<category-path>/<year>/<name>.pdf
 *
 * where:
 *   - `_gruppe/<slug>/...` is used when `documents.visibility='group'`
 *     and every member of that group sees the same physical tree;
 *   - `<user-login-slug>/...` is used for `visibility='private'` and is
 *     derived from the local-part of the uploader's e-mail address.
 *
 * Documents that have not been classified yet (status != 'ready' or no
 * category assigned) land in `<owner-root>/_inbox/YYYY-MM/` and get
 * relocated once `classify` has filled in the category + metadata.
 *
 * Tax-relevant documents additionally appear under
 * `<owner-root>/_steuer/<year>/<anlage>/...` via **hardlinks** so the
 * filesystem view doubles as a steuer view without duplicating bytes.
 *
 * The `sha256` digest still acts as the global dedup key (unique in the
 * `documents` table) and the last 8 hex chars are appended to the
 * speaking filename to make collisions impossible when two documents
 * from the same sender on the same day would otherwise produce the
 * same name.
 */

import fs from "fs";
import path from "path";

console.log("[boot] documents/documents.service.ts: all imports resolved");

export const DOCUMENTS_DIR = path.resolve(
  process.env.DOCUMENTS_DIR || "uploads/documents",
);

export const DOCUMENTS_INBOX_DIR = path.resolve(
  process.env.DOCUMENTS_INBOX_DIR || "uploads/documents-inbox",
);

/** Hard upload limit in bytes (default 50 MB). */
export const DOCUMENTS_MAX_BYTES =
  parseInt(process.env.DOCUMENTS_MAX_SIZE_MB ?? "50", 10) * 1024 * 1024;

/** Only PDFs for now — scanners always emit PDF. */
export const SUPPORTED_MIME_TYPES = new Set(["application/pdf"]);
export const SUPPORTED_EXTENSIONS = new Set([".pdf"]);

/** Sub-directory of the owner root that holds not-yet-classified documents. */
export const INBOX_SEGMENT = "_inbox";
/** Sub-directory of the owner root that hosts tax-view hardlinks. */
export const STEUER_SEGMENT = "_steuer";
/** Sub-directory of DOCUMENTS_DIR for group-scoped documents. */
export const GROUP_SEGMENT = "_gruppe";

export function guessExtension(filename: string, mimeType: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (SUPPORTED_EXTENSIONS.has(ext)) return ext;
  if (mimeType === "application/pdf") return ".pdf";
  return ext || ".bin";
}

// ─── Slug helpers ──────────────────────────────────────────────────────────

/**
 * Normalise a free-form string into a safe filesystem slug.
 * Lowercases, folds German umlauts, strips diacritics, collapses non
 * `[a-z0-9]` runs to `-`, trims edge hyphens, truncates to `maxLen`.
 * Returns "" for input that reduces to nothing — callers decide how
 * to fall back.
 */
export function slugifyName(input: string, maxLen: number = 60): string {
  if (!input) return "";
  // Umlaut folding must happen *before* NFD-normalisation: Unicode
  // decomposition turns "ö" into "o" + U+0308 (combining diaeresis),
  // and the diacritic-strip below would then reduce it to plain "o"
  // instead of the German-reading "oe".
  return input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

/**
 * Derive a folder-safe slug from a user's e-mail address. Uses the
 * local-part so "max.mueller@example.com" → "max-mueller". The result
 * is guaranteed non-empty: if slugification yields "" (e.g. purely
 * numeric usernames), we fall back to `user-<id>`.
 */
export function slugifyUserLogin(email: string, userId: number): string {
  const local = (email.split("@", 1)[0] ?? "").trim();
  const slug = slugifyName(local, 50);
  return slug.length > 0 ? slug : `user-${userId}`;
}

// ─── Path context + builder ────────────────────────────────────────────────

export interface DocumentLocationContext {
  /** Access scope of the document. */
  visibility: "private" | "group";
  /** Slug of the uploader's login — required when visibility='private'. */
  userLoginSlug: string | null;
  /** Slug of the owning group — required when visibility='group'. */
  groupSlug: string | null;
  /**
   * Ordered list of category slugs from root to leaf. `null` or empty
   * when no category has been assigned yet — caller lands in the
   * _inbox folder instead.
   */
  categorySlugs: string[] | null;
  /** Current document status — non-`ready` documents live in _inbox. */
  status: "pending" | "extracting" | "classifying" | "ready" | "failed";
  /** Date on the document (YYYY-MM-DD) if the classifier found one. */
  docDate: string | null;
  /** Upload timestamp — used as fallback when docDate is missing. */
  uploadedAt: Date;
  /** Extracted sender/absender (used in filename). */
  sender: string | null;
  /** Classified title (used in filename). */
  title: string | null;
  /** Original uploaded filename — fallback for title + last-resort name. */
  originalFilename: string;
  /** Lower-case sha256 of the file content. First 8 hex chars suffix the filename. */
  sha256: string;
  /** File extension including dot (".pdf"). */
  ext: string;
}

export interface ResolvedDocumentPath {
  absPath: string;
  relPath: string;
  dirAbs: string;
  fileName: string;
  /** True if the path points into the per-owner `_inbox/` sub-tree. */
  inbox: boolean;
}

/** Build the owner-root relative path segment. */
function ownerRootSegment(ctx: DocumentLocationContext): string {
  if (ctx.visibility === "group") {
    if (!ctx.groupSlug) {
      throw new Error("group document without groupSlug");
    }
    return path.join(GROUP_SEGMENT, ctx.groupSlug);
  }
  if (!ctx.userLoginSlug) {
    throw new Error("private document without userLoginSlug");
  }
  return ctx.userLoginSlug;
}

function isClassified(ctx: DocumentLocationContext): boolean {
  return ctx.status === "ready"
    && Array.isArray(ctx.categorySlugs)
    && ctx.categorySlugs.length > 0;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yearMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function parseYearFromDocDate(docDate: string | null): number | null {
  if (!docDate) return null;
  const m = /^(\d{4})-/.exec(docDate);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Build the speaking filename for a document — shape:
 *   `YYYY-MM-DD_<sender>_<title>__<hash8>.ext`
 * Missing parts collapse: a doc without a sender becomes
 * `YYYY-MM-DD_<title>__<hash8>.ext`; both missing → `YYYY-MM-DD__<hash8>.ext`.
 * The `__<hash8>` suffix guarantees uniqueness even when two documents
 * share date + sender + title; it also gives a quick handle for DB lookup.
 */
export function buildSpeakingFileName(ctx: DocumentLocationContext): string {
  const date = ctx.docDate ?? isoDate(ctx.uploadedAt);
  const senderSlug = slugifyName(ctx.sender ?? "", 40);
  const titleSource = ctx.title && ctx.title.trim().length > 0
    ? ctx.title
    : ctx.originalFilename.replace(/\.[^.]+$/, "");
  const titleSlug = slugifyName(titleSource, 60);
  const parts = [date, senderSlug, titleSlug].filter((p) => p.length > 0);
  const nameBase = parts.join("_") || "dokument";
  const hashSuffix = ctx.sha256.slice(0, 8);
  const ext = ctx.ext.startsWith(".") ? ctx.ext : `.${ctx.ext}`;
  return `${nameBase}__${hashSuffix}${ext}`;
}

/**
 * Resolve the canonical on-disk path for a document given its full
 * metadata context. Returns `_inbox` placement when the document is not
 * yet classified; otherwise the full category-tree location.
 */
export function resolveDocumentDiskPath(
  ctx: DocumentLocationContext,
): ResolvedDocumentPath {
  const ownerSeg = ownerRootSegment(ctx);
  const fileName = buildSpeakingFileName(ctx);

  let relDir: string;
  let inbox: boolean;
  if (isClassified(ctx)) {
    const catPath = (ctx.categorySlugs ?? []).join(path.sep);
    const year = parseYearFromDocDate(ctx.docDate) ?? ctx.uploadedAt.getUTCFullYear();
    relDir = path.join(ownerSeg, catPath, String(year));
    inbox = false;
  } else {
    relDir = path.join(ownerSeg, INBOX_SEGMENT, yearMonth(ctx.uploadedAt));
    inbox = true;
  }

  const relPath = path.join(relDir, fileName);
  const absPath = path.join(DOCUMENTS_DIR, relPath);
  const dirAbs = path.join(DOCUMENTS_DIR, relDir);
  return { absPath, relPath, dirAbs, fileName, inbox };
}

/**
 * Resolve the hardlink location for a tax-section view. Lives under
 * `<owner-root>/_steuer/<year>/<section>/` and shares the same speaking
 * filename as the canonical file. Hardlinks (not symlinks) are used so
 * that an `unlink` of the canonical file leaves the inode reachable via
 * the _steuer view until that name is removed too.
 */
export function resolveTaxLinkPath(
  ctx: DocumentLocationContext,
  taxYear: number,
  taxSectionSlug: string,
): ResolvedDocumentPath {
  const ownerSeg = ownerRootSegment(ctx);
  const fileName = buildSpeakingFileName(ctx);
  const relDir = path.join(ownerSeg, STEUER_SEGMENT, String(taxYear), taxSectionSlug);
  const relPath = path.join(relDir, fileName);
  const absPath = path.join(DOCUMENTS_DIR, relPath);
  const dirAbs = path.join(DOCUMENTS_DIR, relDir);
  return { absPath, relPath, dirAbs, fileName, inbox: false };
}

// ─── Legacy single-shot path (for initial upload before metadata exists) ──

/**
 * Minimal path used at *upload time* — the caller doesn't yet know the
 * category, sender, or title (those come from the classify worker).
 * The document lands under the owner's `_inbox/YYYY-MM/` with a
 * sha256-based filename that `relocateDocument` replaces once the
 * classifier has run.
 *
 * This is intentionally distinct from `resolveDocumentDiskPath`: at
 * upload we have no metadata, so a hash-only filename avoids collisions
 * without having to guess at speaking parts that would churn seconds
 * later.
 */
export function getInitialUploadDiskPath(
  ownerRootSeg: string,
  sha256: string,
  ext: string,
  when: Date | string = new Date(),
): { absPath: string; relPath: string; dirAbs: string } {
  const d = when instanceof Date ? when : new Date(when);
  const relDir = path.join(ownerRootSeg, INBOX_SEGMENT, yearMonth(d));
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  const relPath = path.join(relDir, `${sha256}${safeExt}`);
  const absPath = path.join(DOCUMENTS_DIR, relPath);
  const dirAbs = path.join(DOCUMENTS_DIR, relDir);
  return { absPath, relPath, dirAbs };
}

/**
 * Compose the owner root segment from raw inputs, without requiring a
 * full `DocumentLocationContext`. Used by the upload path which does not
 * have the category/status context yet.
 */
export function composeOwnerRootSegment(params: {
  visibility: "private" | "group";
  userLoginSlug: string | null;
  groupSlug: string | null;
}): string {
  return ownerRootSegment({
    ...params,
    categorySlugs: null,
    status: "pending",
    docDate: null,
    uploadedAt: new Date(),
    sender: null,
    title: null,
    originalFilename: "",
    sha256: "",
    ext: ".pdf",
  } as any);
}

/**
 * @deprecated — kept so existing callers keep compiling during the
 * migration. New code should use `resolveDocumentDiskPath` with the
 * full metadata context. Returns the legacy `YYYY/YYYY-MM/<sha256>.pdf`
 * shard used by older uploads; a backfill script relocates these.
 */
export function getDocumentDiskPath(
  sha256: string,
  ext: string,
  when: Date | string = new Date(),
): { absPath: string; relPath: string; dirAbs: string } {
  const d = when instanceof Date ? when : new Date(when);
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const relDir = path.join(year, `${year}-${month}`);
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  const relPath = path.join(relDir, `${sha256}${safeExt}`);
  const absPath = path.join(DOCUMENTS_DIR, relPath);
  const dirAbs = path.join(DOCUMENTS_DIR, relDir);
  return { absPath, relPath, dirAbs };
}

// ─── FS guards + helpers ───────────────────────────────────────────────────

/**
 * Path-traversal guard: make sure the provided absolute path really
 * lives under DOCUMENTS_DIR. Used before any fs operation on a row's
 * disk_path so a poisoned DB entry cannot trick the service into
 * touching files outside the document root.
 */
export function assertPathUnderDocumentsRoot(absPath: string): void {
  const resolved = path.resolve(absPath);
  const root = path.resolve(DOCUMENTS_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`document path outside DOCUMENTS_DIR: ${absPath}`);
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Recursively remove directories upward from `startDir` as long as they
 * are empty and still live under DOCUMENTS_DIR. Stops at the root — the
 * per-owner directory itself is kept around.
 */
export async function pruneEmptyDirs(startDir: string): Promise<void> {
  let dir = path.resolve(startDir);
  const root = path.resolve(DOCUMENTS_DIR);
  while (dir.startsWith(root + path.sep) && dir !== root) {
    try {
      const entries = await fs.promises.readdir(dir);
      if (entries.length > 0) return;
      await fs.promises.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
