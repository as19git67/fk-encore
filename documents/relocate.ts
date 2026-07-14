/**
 * Moves a document's on-disk file to the canonical location derived
 * from its current metadata, and rebuilds the `_steuer/` hardlink
 * view to mirror the assigned tax sections.
 *
 * Called whenever the fields that contribute to the path change:
 *   - after `classify` (category, title, doc_date, sender, tax fields)
 *   - after a user edit (`PATCH /documents/:id`)
 *   - after a visibility toggle (`POST /documents/:id/visibility`)
 *   - after tax override (`POST /documents/:id/tax`)
 *
 * All fs operations are path-guarded via `assertPathUnderDocumentsRoot`
 * so a poisoned DB row cannot direct the move outside of DOCUMENTS_DIR.
 */

import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import {
  documentCategories,
  documentTaxSections,
  documents,
  groups,
  users,
} from "../db/schema";
import {
  DOCUMENTS_DIR,
  STEUER_SEGMENT,
  type DocumentLocationContext,
  assertPathUnderDocumentsRoot,
  ensureDir,
  pruneEmptyDirs,
  resolveDocumentDiskPath,
  resolveTaxLinkPath,
  slugifyUserLogin,
} from "./documents.service";
import { withDocumentLock } from "./document-lock";
import { buildCorrespondentFolderSlug } from "./correspondent";

console.log("[boot] documents/relocate.ts: all imports resolved");

type DocumentRow = typeof documents.$inferSelect;

/**
 * Build the location context for a document from its DB row. Joins in
 * the uploader's login slug, the group slug (if any), and the
 * category chain so the caller can hand the result to
 * `resolveDocumentDiskPath` without more queries.
 */
export async function loadDocumentLocationContext(
  doc: DocumentRow,
): Promise<DocumentLocationContext> {
  const userRow = await dbFirst<{ email: string }>(
    db.select({ email: users.email }).from(users).where(eq(users.id, doc.user_id)),
  );
  const email = userRow?.email ?? `user-${doc.user_id}@local`;
  const userLoginSlug = slugifyUserLogin(email, doc.user_id);

  let groupSlug: string | null = null;
  if (doc.group_id != null) {
    const h = await dbFirst<{ slug: string }>(
      db.select({ slug: groups.slug }).from(groups).where(eq(groups.id, doc.group_id)),
    );
    groupSlug = h?.slug ?? null;
  }

  const categorySlugs = doc.category_id != null
    ? await loadCategoryChain(doc.category_id)
    : null;

  const uploadedAt = doc.uploaded_at ? new Date(doc.uploaded_at) : new Date();
  const ext = path.extname(doc.original_filename).toLowerCase() || ".pdf";

  // `tags_text` is the trigger-maintained, lowercase, space-separated list of
  // the document's tag names (see schema). It already holds the reference-number
  // tags (`versicherungsnr:…`/`vertragsnr:…`) the correspondent needs for its
  // contract anchor, so we can derive the correspondent without an extra query.
  const tagNames = doc.tags_text
    ? doc.tags_text.split(/\s+/).filter((t) => t.length > 0)
    : [];
  const correspondentSlug = buildCorrespondentFolderSlug({
    sender: doc.sender,
    title: doc.title,
    tags: tagNames,
  });

  return {
    visibility: doc.visibility,
    userLoginSlug,
    groupSlug,
    categorySlugs,
    correspondentSlug,
    status: doc.status,
    docDate: doc.doc_date,
    documentNumber: doc.document_number,
    uploadedAt,
    sender: doc.sender,
    title: doc.title,
    originalFilename: doc.original_filename,
    sha256: doc.sha256,
    ext,
  };
}

/** Walk `parent_id` up to the root — returns slugs root-first. */
async function loadCategoryChain(leafId: number): Promise<string[] | null> {
  // Categories rarely go deeper than 4, and the full set is small — one
  // fetch + in-memory walk is cheaper than N queries.
  const rows = await dbAll<{ id: number; slug: string; parent_id: number | null }>(
    db
      .select({
        id: documentCategories.id,
        slug: documentCategories.slug,
        parent_id: documentCategories.parent_id,
      })
      .from(documentCategories),
  );
  const byId = new Map<number, { slug: string; parent_id: number | null }>();
  for (const r of rows) byId.set(r.id, { slug: r.slug, parent_id: r.parent_id });

  const chain: string[] = [];
  const seen = new Set<number>();
  let cur: number | null = leafId;
  while (cur != null) {
    if (seen.has(cur)) break; // defensive: broken parent cycle
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) return null;
    chain.push(node.slug);
    cur = node.parent_id;
  }
  return chain.reverse();
}

/**
 * Move the underlying file to match the canonical path for `ctx` and
 * rewrite the `_steuer/` hardlinks.
 *
 * Idempotent: if the file already lives at the target path, only the
 * tax hardlink view is rebuilt. Returns the new absolute path so the
 * caller can persist it back to `documents.disk_path`.
 */
export async function relocateDocument(documentId: number): Promise<string> {
  // Serialize against every other file+disk_path mutation for this
  // document so a concurrent relocate/replace can't move the file out
  // from under us (see document-lock.ts).
  return withDocumentLock(documentId, () => relocateDocumentLocked(documentId));
}

async function relocateDocumentLocked(documentId: number): Promise<string> {
  const row = await dbFirst<DocumentRow>(
    db.select().from(documents).where(eq(documents.id, documentId)),
  );
  if (!row) throw new Error(`document ${documentId} not found`);

  const ctx = await loadDocumentLocationContext(row);
  const target = resolveDocumentDiskPath(ctx);
  assertPathUnderDocumentsRoot(target.absPath);

  const oldAbs = row.disk_path;
  const moved = oldAbs !== target.absPath;

  // Drop any previous tax links before the move — we'll recreate them
  // against the new absolute path afterwards. Derive the search root
  // from the old path so we also clean up links from the *previous*
  // owner root when visibility flipped between private/household.
  if (oldAbs) {
    await removeTaxLinksForDocument(oldAbs, row.sha256);
  }

  if (moved) {
    if (oldAbs && oldAbs.length > 0) {
      assertPathUnderDocumentsRoot(oldAbs);
    }
    await ensureDir(target.dirAbs);

    if (oldAbs && fs.existsSync(oldAbs)) {
      await moveFile(oldAbs, target.absPath);
      await pruneEmptyDirs(path.dirname(oldAbs));
    }

    // Invariant: `disk_path` must always point at a file that exists.
    // Only commit the new path once the file is provably sitting at the
    // target — either we just moved it there, or it was already there.
    // Otherwise (source gone, nothing at target — e.g. a concurrent
    // relocate already moved the file elsewhere) leave `disk_path`
    // untouched so we never record a phantom path.
    if (!fs.existsSync(target.absPath)) {
      console.warn(
        `[documents] relocate(${documentId}): no file at source or target — ` +
          `keeping disk_path=${row.disk_path}`,
      );
      return row.disk_path;
    }

    await db
      .update(documents)
      .set({ disk_path: target.absPath })
      .where(eq(documents.id, documentId));
  }

  await rebuildTaxLinks(documentId, target.absPath, ctx);

  return target.absPath;
}

/**
 * Move across filesystem boundaries. `fs.rename` returns EXDEV when
 * src and dst live on different mounts (inbox volume + documents
 * volume is a common production layout). Fall back to copy+unlink in
 * that case.
 */
async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await fs.promises.rename(src, dst);
    return;
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
  }
  await fs.promises.copyFile(src, dst);
  await fs.promises.unlink(src);
}

/**
 * Drop every file living under the old owner's `_steuer/` subtree whose
 * name ends with the document's hash suffix. Works across visibility
 * changes because we walk the owner root derived from the old path,
 * not from the current DB state.
 */
async function removeTaxLinksForDocument(
  oldAbsPath: string,
  sha256: string,
): Promise<void> {
  const ownerRoot = deriveOwnerRootFromPath(oldAbsPath);
  if (!ownerRoot) return;
  const steuerRoot = path.join(ownerRoot, STEUER_SEGMENT);
  if (!fs.existsSync(steuerRoot)) return;

  const suffix = `__${sha256.slice(0, 8)}`;
  await walkAndUnlink(steuerRoot, suffix);
  await pruneEmptyDirs(steuerRoot);
}

/** Given an absolute path under DOCUMENTS_DIR, return the owner-root absolute path. */
function deriveOwnerRootFromPath(absPath: string): string | null {
  const root = path.resolve(DOCUMENTS_DIR);
  const resolved = path.resolve(absPath);
  if (!resolved.startsWith(root + path.sep)) return null;
  const rel = resolved.slice(root.length + 1);
  const segments = rel.split(path.sep);
  if (segments.length === 0) return null;
  // `_gruppe/<slug>/...` → owner root is `_gruppe/<slug>`.
  if (segments[0] === "_gruppe" && segments.length >= 2) {
    return path.join(root, segments[0], segments[1]);
  }
  return path.join(root, segments[0]);
}

async function walkAndUnlink(dir: string, matchSuffix: string): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndUnlink(p, matchSuffix);
      continue;
    }
    if (!entry.isFile()) continue;
    // Match our hash-suffixed filenames, e.g. `2024-03-15_finanz__a3f1b2c4.pdf`.
    const base = entry.name;
    const dot = base.lastIndexOf(".");
    const stem = dot >= 0 ? base.slice(0, dot) : base;
    if (stem.endsWith(matchSuffix)) {
      await fs.promises.unlink(p).catch(() => {});
    }
  }
}

/**
 * Create (or refresh) one hardlink per assigned tax section under
 * `<owner-root>/_steuer/<tax_year>/<section>/`. Skips documents that
 * carry no tax metadata, haven't reached `ready`, or have no concrete
 * tax year.
 */
async function rebuildTaxLinks(
  documentId: number,
  canonicalAbs: string,
  ctx: DocumentLocationContext,
): Promise<void> {
  if (ctx.status !== "ready") return;
  const row = await dbFirst<{ tax_relevant: boolean; tax_year: number | null }>(
    db
      .select({ tax_relevant: documents.tax_relevant, tax_year: documents.tax_year })
      .from(documents)
      .where(eq(documents.id, documentId)),
  );
  if (!row || !row.tax_relevant || row.tax_year == null) return;

  const sections = await dbAll<{ tax_section: string }>(
    db
      .select({ tax_section: documentTaxSections.tax_section })
      .from(documentTaxSections)
      .where(eq(documentTaxSections.document_id, documentId)),
  );
  if (sections.length === 0) return;

  for (const s of sections) {
    const linkPath = resolveTaxLinkPath(ctx, row.tax_year, s.tax_section);
    assertPathUnderDocumentsRoot(linkPath.absPath);
    await ensureDir(linkPath.dirAbs);
    // Remove any stale entry first so hardlinking can't fail with EEXIST.
    await fs.promises.unlink(linkPath.absPath).catch(() => {});
    try {
      await fs.promises.link(canonicalAbs, linkPath.absPath);
    } catch (err: any) {
      // Hardlinks only work inside a single filesystem. On the rare
      // cross-device case fall back to a symlink — less robust against
      // orphaning when the original is removed, but the best we can
      // do without duplicating bytes.
      if (err?.code === "EXDEV") {
        await fs.promises.symlink(canonicalAbs, linkPath.absPath);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Remove every tax hardlink for a document — used by the delete
 * endpoint before `unlink`-ing the canonical file, and by tax-override
 * writes that wipe the tax_relevant flag.
 */
export async function dropTaxLinks(documentId: number): Promise<void> {
  const row = await dbFirst<DocumentRow>(
    db.select().from(documents).where(eq(documents.id, documentId)),
  );
  if (!row) return;
  await removeTaxLinksForDocument(row.disk_path, row.sha256);
}
