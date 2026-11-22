/**
 * Binder labels — HTTP endpoints (layout in binder-sheet.ts).
 *
 *   GET    /label/binder/pages      → the user's saved pages, by name
 *   GET    /label/binder/pages/:id  → one page with its labels
 *   POST   /label/binder/pages      → save a page under a new name
 *   PUT    /label/binder/pages/:id  → change a saved page (also its name)
 *   DELETE /label/binder/pages/:id  → remove it
 *   POST   /label/binder/pdf        → the sheet as PDF, saved or not
 *
 * Saving and opening pages needs `label.view`, like the label templates;
 * the PDF needs `label.print`. Pages are per user, names unique per user
 * regardless of case.
 */

import { api, APIError } from "encore.dev/api";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import { and, asc, eq, sql } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import db from "../db/database";
import { labelBinderPages } from "../db/schema";
import { requirePermission } from "../user/auth-handler";
import {
  BINDER_SHEET,
  MAX_LABEL_TEXT,
  renderBinderPdf,
  type BinderAlign,
  type BinderDirection,
  type BinderSheetSpec,
} from "./binder-sheet";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

const MAX_PAGES = 500;
const MAX_NAME = 80;
const DIRECTIONS = new Set<BinderDirection>(["across", "along"]);
const ALIGNS = new Set<BinderAlign>(["left", "center"]);

export interface BinderPageSummary {
  id: number;
  name: string;
  /** The first line of text on the page, without Markdown — a hint in the list. */
  excerpt: string;
  updatedAt: string;
}

export interface BinderPage {
  id: number;
  name: string;
  labels: string[];
  direction: BinderDirection;
  align: BinderAlign;
  createdAt: string;
  updatedAt: string;
}

interface BinderPageInput {
  name: string;
  labels: string[];
  direction: BinderDirection;
  align: BinderAlign;
}

interface UpdateBinderPageRequest extends BinderPageInput {
  id: number;
}

type Row = typeof labelBinderPages.$inferSelect;

/** Exactly four labels, each a string within the limit. */
export function normalizeLabels(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > BINDER_SHEET.labels) {
    throw APIError.invalidArgument(`Eine Seite hat ${BINDER_SHEET.labels} Etiketten`);
  }
  const out: string[] = [];
  for (let i = 0; i < BINDER_SHEET.labels; i++) {
    const v = input[i] ?? "";
    if (typeof v !== "string") throw APIError.invalidArgument("Ein Etikett ist Text");
    if (v.length > MAX_LABEL_TEXT) {
      throw APIError.invalidArgument(`Ein Etikett darf höchstens ${MAX_LABEL_TEXT} Zeichen haben`);
    }
    out.push(v);
  }
  return out;
}

function normalizeOptions(input: { direction?: unknown; align?: unknown }): { direction: BinderDirection; align: BinderAlign } {
  const direction = (input.direction ?? "across") as BinderDirection;
  const align = (input.align ?? "center") as BinderAlign;
  if (!DIRECTIONS.has(direction)) throw APIError.invalidArgument("Ungültige Schreibrichtung");
  if (!ALIGNS.has(align)) throw APIError.invalidArgument("Ungültige Ausrichtung");
  return { direction, align };
}

function normalizeInput(req: BinderPageInput) {
  const name = typeof req.name === "string" ? req.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > MAX_NAME) {
    throw APIError.invalidArgument(`Der Name muss 1 bis ${MAX_NAME} Zeichen lang sein`);
  }
  return { name, labels: normalizeLabels(req.labels), ...normalizeOptions(req) };
}

/** First non-empty line of the page, with the Markdown marks taken off. */
export function excerptOf(labels: string[]): string {
  for (const label of labels) {
    for (const line of label.split("\n")) {
      const plain = line
        .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "")
        .replace(/[*_~`]/g, "")
        .trim();
      if (plain && !/^-{3,}$/.test(plain)) return plain.length > 60 ? `${plain.slice(0, 59).trimEnd()}…` : plain;
    }
  }
  return "";
}

function toPage(row: Row): BinderPage {
  return {
    id: row.id,
    name: row.name,
    labels: normalizeLabels(row.labels ?? []),
    direction: DIRECTIONS.has(row.direction as BinderDirection) ? (row.direction as BinderDirection) : "across",
    align: ALIGNS.has(row.align as BinderAlign) ? (row.align as BinderAlign) : "center",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

function nameTaken(name: string): APIError {
  return APIError.alreadyExists(`Eine Seite „${name}“ gibt es schon`);
}

async function ownPage(userId: number, id: number): Promise<Row> {
  const [row] = await db
    .select()
    .from(labelBinderPages)
    .where(and(eq(labelBinderPages.id, id), eq(labelBinderPages.user_id, userId)));
  if (!row) throw APIError.notFound("Seite nicht gefunden");
  return row;
}

export const listBinderPages = api(
  { expose: true, method: "GET", path: "/label/binder/pages", auth: true },
  async (): Promise<{ pages: BinderPageSummary[] }> => {
    const userId = requireUser("label.view");
    const rows = await db
      .select()
      .from(labelBinderPages)
      .where(eq(labelBinderPages.user_id, userId))
      .orderBy(asc(sql`lower(${labelBinderPages.name})`));
    return {
      pages: rows.map((row) => ({
        id: row.id,
        name: row.name,
        excerpt: excerptOf(Array.isArray(row.labels) ? row.labels : []),
        updatedAt: row.updated_at,
      })),
    };
  },
);

export const getBinderPage = api(
  { expose: true, method: "GET", path: "/label/binder/pages/:id", auth: true },
  async ({ id }: { id: number }): Promise<BinderPage> => {
    const userId = requireUser("label.view");
    return toPage(await ownPage(userId, id));
  },
);

export const createBinderPage = api(
  { expose: true, method: "POST", path: "/label/binder/pages", auth: true },
  async (req: BinderPageInput): Promise<BinderPage> => {
    const userId = requireUser("label.view");
    const input = normalizeInput(req);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(labelBinderPages)
      .where(eq(labelBinderPages.user_id, userId));
    if (count >= MAX_PAGES) {
      throw APIError.resourceExhausted(`Es lassen sich höchstens ${MAX_PAGES} Seiten speichern`);
    }
    try {
      const [row] = await db
        .insert(labelBinderPages)
        .values({ user_id: userId, ...input })
        .returning();
      return toPage(row!);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(input.name);
      throw err;
    }
  },
);

export const updateBinderPage = api(
  { expose: true, method: "PUT", path: "/label/binder/pages/:id", auth: true },
  async (req: UpdateBinderPageRequest): Promise<BinderPage> => {
    const userId = requireUser("label.view");
    const input = normalizeInput(req);
    await ownPage(userId, req.id);
    try {
      const [row] = await db
        .update(labelBinderPages)
        .set({ ...input, updated_at: sql`now()` })
        .where(and(eq(labelBinderPages.id, req.id), eq(labelBinderPages.user_id, userId)))
        .returning();
      return toPage(row!);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(input.name);
      throw err;
    }
  },
);

export const deleteBinderPage = api(
  { expose: true, method: "DELETE", path: "/label/binder/pages/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ deleted: boolean }> => {
    const userId = requireUser("label.view");
    const removed = await db
      .delete(labelBinderPages)
      .where(and(eq(labelBinderPages.id, id), eq(labelBinderPages.user_id, userId)))
      .returning({ id: labelBinderPages.id });
    if (removed.length === 0) throw APIError.notFound("Seite nicht gefunden");
    return { deleted: true };
  },
);

// ---------- PDF ----------

const STATUS: Record<string, number> = {
  not_found: 404,
  unauthenticated: 401,
  permission_denied: 403,
  invalid_argument: 400,
};

/** "Ordneretiketten Steuer.pdf"; characters a file name cannot hold become "-". */
export function binderFilename(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/[\\/:*?"<>|#\u0000-\u001f]+/g, "-").trim();
  return clean ? `Ordneretiketten ${clean}.pdf` : "Ordneretiketten.pdf";
}

/**
 * Renders what the page shows right now, so a page prints before (or
 * without) being saved. The body is `{ name?, labels, direction, align,
 * outlines? }`.
 */
export const binderPdf = api.raw(
  { expose: true, method: "POST", path: "/label/binder/pdf", auth: true },
  async (req: IncomingMessage, res: ServerResponse) => {
    try {
      requireUser("label.print");
      let body: Record<string, unknown>;
      try {
        body = ((await json(req)) ?? {}) as Record<string, unknown>;
      } catch {
        throw APIError.invalidArgument("Ungültige Anfrage");
      }
      const spec: BinderSheetSpec = {
        labels: normalizeLabels(body.labels ?? []),
        ...normalizeOptions(body),
        outlines: body.outlines === true,
      };
      const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
      const filename = binderFilename(name);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      const doc = renderBinderPdf(spec, name ? `Ordneretiketten ${name}` : "Ordneretiketten");
      doc.pipe(res);
      doc.end();
    } catch (err) {
      res.statusCode = err instanceof APIError ? STATUS[err.code] ?? 500 : 500;
      res.end(err instanceof Error ? err.message : "error");
    }
  },
);
