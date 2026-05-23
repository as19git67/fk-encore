/**
 * Demo-data seed for the E2E pipeline (Issue #401 / Track AB).
 *
 * Activated only when `E2E_SEED_DEMO=1` is set in the process environment.
 * Lays down the minimum data the Playwright specs need to stop skipping:
 *
 *   - 3 demo photos for the admin user — gallery.spec.ts requires >= 3
 *     visible cells before it exercises hover, multi-select and keyboard
 *     navigation.
 *   - 1 demo PDF in the documents module — gives DocumentsView a row so
 *     the page renders something more interesting than the empty state.
 *   - 1 manual finance account + 2 transactions + an ACL grant for the
 *     admin user — finance.spec.ts needs at least one booking before it
 *     opens the batch-tag dialog and exercises the tag autocomplete.
 *
 * Every step is idempotent: a re-run after a backend restart converges
 * on the same state and silently skips anything that already exists.
 * The seed never crashes the boot — failures log a warning and the
 * function returns, because demo data is nice-to-have, not load-bearing.
 *
 * NOT to be invoked from production: the demo bookings carry obviously
 * fake amounts and the account is labelled "E2E Demo", so any operator
 * who turns the flag on by accident will see what happened immediately.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import sharp from "sharp";
import * as schema from "./schema";

const DEMO_PHOTO_COUNT = 3;
const DEMO_PHOTO_BASE = "e2e-demo-photo";

// Marker used to keep the bankcontact/account idempotent across reboots.
const DEMO_ACCOUNT_LABEL = "E2E Demo (Privat)";
const DEMO_ACCOUNT_NUMBER = "DE00E2E0001";
const DEMO_BANK_NAME = "E2E Demo-Bank";

// Marker used to dedupe the demo PDF without colliding with real uploads.
// Also serves as the SHA-256 placeholder for the document row.
const DEMO_DOC_FILENAME = "e2e-demo-rechnung.pdf";

export function isDemoSeedEnabled(): boolean {
  const flag = (process.env.E2E_SEED_DEMO ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes" || flag === "on";
}

export async function seedDemo(db: any): Promise<void> {
  if (!isDemoSeedEnabled()) return;

  console.log("[seed-demo] E2E_SEED_DEMO enabled — laying down demo data");

  // Admin user is the owner of all demo data. If it doesn't exist yet
  // (the main seed runs first, so this branch only fires when the
  // operator turned demo seeding on without configuring ADMIN_PASSWORD)
  // we bail rather than guess.
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminRow = (
    await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, adminEmail))
  )[0] as { id: number } | undefined;

  if (!adminRow) {
    console.warn(
      `[seed-demo] admin user (${adminEmail}) not found — demo seed skipped. ` +
        `Set ADMIN_PASSWORD so the main seed creates the admin first.`,
    );
    return;
  }

  try {
    await seedDemoPhotos(db, adminRow.id);
  } catch (err: any) {
    console.warn(`[seed-demo] photos: ${err?.message ?? err}`);
  }

  try {
    await seedDemoDocuments(db, adminRow.id);
  } catch (err: any) {
    console.warn(`[seed-demo] documents: ${err?.message ?? err}`);
  }

  try {
    await seedDemoFinance(db, adminRow.id);
  } catch (err: any) {
    console.warn(`[seed-demo] finance: ${err?.message ?? err}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Photos
// ──────────────────────────────────────────────────────────────────────────

async function seedDemoPhotos(db: any, userId: number): Promise<void> {
  const uploadDir = path.resolve(
    process.env.PHOTO_UPLOAD_DIR || "/mnt/data/photos",
  );
  await fs.mkdir(uploadDir, { recursive: true });

  // Idempotency: count existing demo photos by filename prefix. Real
  // uploads use a timestamp-based scheme (YYYY/YYYY-MM/...) so a
  // hand-rolled filename like `e2e-demo-photo-1.jpg` can never collide.
  const existing = (
    await db
      .select({ id: schema.photos.id })
      .from(schema.photos)
      .where(
        and(
          eq(schema.photos.user_id, userId),
          eq(schema.photos.filename, `${DEMO_PHOTO_BASE}-1.jpg`),
        ),
      )
  ) as { id: number }[];

  if (existing.length > 0) {
    console.log("[seed-demo] photos already present — skipping");
    return;
  }

  // Three distinct colour swatches so the gallery shows visibly different
  // tiles. 480x320 is large enough for the thumbnail pipeline to do
  // something useful without inflating the image bytes.
  const swatches: Array<{ r: number; g: number; b: number }> = [
    { r: 240, g: 90, b: 70 },
    { r: 70, g: 180, b: 240 },
    { r: 120, g: 200, b: 100 },
  ];

  for (let i = 0; i < DEMO_PHOTO_COUNT; i++) {
    const filename = `${DEMO_PHOTO_BASE}-${i + 1}.jpg`;
    const absPath = path.join(uploadDir, filename);
    const swatch = swatches[i % swatches.length];

    // sharp produces a real JPEG, so the photo-transforms pipeline can
    // generate thumbnails the gallery uses for cell tiles. Hand-rolled
    // JPEG bytes would technically suffice but break the moment any
    // worker tries to decode them.
    const buf = await sharp({
      create: {
        width: 480,
        height: 320,
        channels: 3,
        background: swatch,
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    await fs.writeFile(absPath, buf);

    // taken_at is staggered so the gallery's date-based ordering shows
    // them in a deterministic order across runs. Stable timestamps also
    // keep image hashes deterministic should the spec ever screenshot.
    const takenAt = new Date(2024, 5, 15 + i, 12, 0, 0).toISOString();
    const hash = crypto.createHash("sha256").update(buf).digest("hex");

    await db.insert(schema.photos).values({
      user_id: userId,
      filename,
      original_name: filename,
      mime_type: "image/jpeg",
      size: buf.byteLength,
      hash,
      taken_at: takenAt,
      width: 480,
      height: 320,
    });
  }

  console.log(`[seed-demo] inserted ${DEMO_PHOTO_COUNT} demo photos`);
}

// ──────────────────────────────────────────────────────────────────────────
// Documents
// ──────────────────────────────────────────────────────────────────────────

async function seedDemoDocuments(db: any, userId: number): Promise<void> {
  const docsDir = path.resolve(
    process.env.DOCUMENTS_DIR || "uploads/documents",
  );
  await fs.mkdir(docsDir, { recursive: true });

  // Minimal valid 1-page PDF. Mirrors the fixture shipped with
  // documents.spec.ts so the dedup hash stays stable across reboots
  // and the spec's drop-fixture won't trip the 409 dedup path.
  const pdfBuffer = Buffer.from(buildSampleDocumentPdf(), "latin1");
  const sha256 = crypto.createHash("sha256").update(pdfBuffer).digest("hex");

  const existing = (
    await db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(eq(schema.documents.sha256, sha256))
  )[0] as { id: number } | undefined;

  if (existing) {
    console.log("[seed-demo] demo document already present — skipping");
    return;
  }

  const relPath = path.posix.join("_inbox", DEMO_DOC_FILENAME);
  const absPath = path.join(docsDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, pdfBuffer);

  await db.insert(schema.documents).values({
    user_id: userId,
    sha256,
    original_filename: DEMO_DOC_FILENAME,
    mime_type: "application/pdf",
    size_bytes: pdfBuffer.byteLength,
    disk_path: relPath,
    status: "ready",
    title: "E2E Demo-Rechnung",
    doc_date: "2024-06-15",
    sender: "E2E Demo GmbH",
    summary: "Demo-Beleg für die Playwright-Pipeline.",
    visibility: "private",
  });

  console.log("[seed-demo] inserted 1 demo document");
}

function buildSampleDocumentPdf(): string {
  return `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj
4 0 obj<</Length 50>>stream
BT /F1 18 Tf 20 100 Td (E2E Demo Rechnung) Tj ET
endstream endobj
xref
0 5
0000000000 65535 f
0000000010 00000 n
0000000053 00000 n
0000000098 00000 n
0000000165 00000 n
trailer<</Size 5/Root 1 0 R>>
startxref
259
%%EOF
`;
}

// ──────────────────────────────────────────────────────────────────────────
// Finance
// ──────────────────────────────────────────────────────────────────────────

async function seedDemoFinance(db: any, userId: number): Promise<void> {
  // The admin role intentionally lacks `finance.admin` (it bypasses the
  // ACL), so the admin user can only see accounts via finance_account_access.
  // We create a manual account (no bankcontact) and grant the admin
  // write-level access on it.

  // Pick the giro account type — the demo doesn't care, anything that
  // exists in finance_account_type works.
  const giroType = (
    await db
      .select({ id: schema.financeAccountType.id })
      .from(schema.financeAccountType)
      .where(eq(schema.financeAccountType.kind, "giro"))
  )[0] as { id: number } | undefined;

  if (!giroType) {
    console.warn(
      "[seed-demo] finance_account_type 'giro' missing — finance demo skipped",
    );
    return;
  }

  let accountId = (
    await db
      .select({ id: schema.financeAccount.id })
      .from(schema.financeAccount)
      .where(eq(schema.financeAccount.label, DEMO_ACCOUNT_LABEL))
  )[0]?.id as number | undefined;

  if (!accountId) {
    accountId = (
      await db
        .insert(schema.financeAccount)
        .values({
          bankcontact_id: null,
          fints_account_number: null,
          type_id: giroType.id,
          currency_code: "EUR",
          account_number: DEMO_ACCOUNT_NUMBER,
          label: DEMO_ACCOUNT_LABEL,
        })
        .returning({ id: schema.financeAccount.id })
    )[0]?.id as number | undefined;
    console.log(`[seed-demo] inserted demo finance account #${accountId}`);
  }

  if (!accountId) {
    console.warn("[seed-demo] failed to obtain demo account id");
    return;
  }

  // ACL grant — admin sees the account and its bookings.
  const accessExisting = (
    await db
      .select({ user_id: schema.financeAccountAccess.user_id })
      .from(schema.financeAccountAccess)
      .where(
        and(
          eq(schema.financeAccountAccess.account_id, accountId),
          eq(schema.financeAccountAccess.user_id, userId),
        ),
      )
  )[0];

  if (!accessExisting) {
    await db.insert(schema.financeAccountAccess).values({
      account_id: accountId,
      user_id: userId,
      level: "write",
    });
  }

  // Two deterministic demo bookings — one credit, one debit. dedupe_hash
  // is a stable function of (date, amount, counterparty) so re-runs find
  // the existing rows via the unique (account_id, dedupe_hash) index and
  // skip the insert.
  const bookings: Array<{
    bookingDate: string;
    amount: string;
    counterparty: string;
    purpose: string;
  }> = [
    {
      bookingDate: "2024-06-03",
      amount: "1500.00",
      counterparty: "E2E Demo Arbeitgeber",
      purpose: "Gehaltszahlung Juni",
    },
    {
      bookingDate: "2024-06-10",
      amount: "-49.90",
      counterparty: "E2E Demo Supermarkt",
      purpose: "Einkauf",
    },
  ];

  for (const b of bookings) {
    const dedupeHash = crypto
      .createHash("sha256")
      .update(
        [
          b.bookingDate,
          "",
          b.amount,
          "EUR",
          b.purpose,
          "",
        ].join("|"),
      )
      .digest("hex");

    const existing = (
      await db
        .select({ id: schema.financeTransaction.id })
        .from(schema.financeTransaction)
        .where(
          and(
            eq(schema.financeTransaction.account_id, accountId),
            eq(schema.financeTransaction.dedupe_hash, dedupeHash),
          ),
        )
    )[0];

    if (existing) continue;

    await db.insert(schema.financeTransaction).values({
      account_id: accountId,
      booking_date: b.bookingDate,
      value_date: b.bookingDate,
      amount: b.amount,
      currency_code: "EUR",
      purpose: b.purpose,
      counterparty: b.counterparty,
      dedupe_hash: dedupeHash,
    });
  }

  console.log(
    `[seed-demo] ensured ${bookings.length} demo transactions on account #${accountId}`,
  );
}
