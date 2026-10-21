import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// The endpoints write real files; keep them out of the working tree.
const tmpRoot = vi.hoisted(() => {
  const os = require("os") as typeof import("os");
  const fsSync = require("fs") as typeof import("fs");
  const pathMod = require("path") as typeof import("path");
  const dir = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), "text-docs-"));
  process.env.DOCUMENTS_DIR = dir;
  return dir;
});

vi.mock("./scan-worker", () => ({ triggerWorkers: vi.fn() }));

import fs from "fs";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";
import db from "../db/database";
import { documents } from "../db/schema";
import { createTextDocument, updateTextDocument } from "./documents";
import { textDocumentFilename, validateTextDocument } from "./text-documents";
import { markdownTokens, renderMarkdownPdf } from "./markdown-pdf";
import { extractPdfText } from "./text-extract";

const USER_ID = 991701;
const OTHER_ID = 991702;

function setAuth(userId = USER_ID) {
  vi.mocked(getAuthData).mockReturnValue({
    userID: String(userId),
    permissions: ["module.documents", "documents.view", "documents.upload", "documents.edit"],
  });
}

async function ensureUser(id: number): Promise<void> {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${id}, ${`u${id}@test.local`}, ${`User${id}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
}

beforeEach(async () => {
  await ensureUser(USER_ID);
  await ensureUser(OTHER_ID);
  await db.delete(documents).where(eq(documents.user_id, USER_ID));
  setAuth();
});

afterAll(async () => {
  await db.delete(documents).where(eq(documents.user_id, USER_ID));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("validateTextDocument", () => {
  it("trims the title and normalises line endings", () => {
    expect(validateTextDocument({ title: "  Ein   Titel ", markdown: "a\r\nb  \n\n" })).toEqual({
      title: "Ein Titel",
      markdown: "a\nb\n",
    });
  });

  it("refuses a missing title", () => {
    expect(() => validateTextDocument({ title: "   ", markdown: "x" })).toThrow(/title/);
  });

  it("keeps an empty text empty", () => {
    expect(validateTextDocument({ title: "Leer", markdown: "  \n" }).markdown).toBe("");
  });
});

describe("textDocumentFilename", () => {
  it("names the PDF after the title", () => {
    expect(textDocumentFilename("Notizen zur Heizung")).toBe("notizen-zur-heizung.pdf");
    expect(textDocumentFilename("???")).toBe("textdokument.pdf");
  });
});

describe("renderMarkdownPdf", () => {
  const markdown = [
    "# Wartung",
    "",
    "Ein Absatz mit **fett**, *kursiv* und [Link](https://beispiel.test).",
    "",
    "- erster Punkt",
    "- [x] erledigt",
    "",
    "> Zitat",
    "",
    "```",
    "code()",
    "```",
    "",
    "| A | B |",
    "|---|--:|",
    "| 1 | 2 |",
    "",
    "<script>alert(1)</script>",
  ].join("\n");

  it("renders a PDF whose text layer carries the content", async () => {
    const pdf = await renderMarkdownPdf({ title: "Heizung", markdown });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const file = `${tmpRoot}/render.pdf`;
    fs.writeFileSync(file, pdf);
    const { text } = await extractPdfText(file, {});
    for (const part of ["Heizung", "Wartung", "fett", "erster Punkt", "Zitat", "code()", "<script>"]) {
      expect(text).toContain(part);
    }
  });

  it("parses GitHub-flavoured Markdown", () => {
    const types = markdownTokens(markdown).map((t) => t.type).filter((t) => t !== "space");
    expect(types).toEqual(["heading", "paragraph", "list", "blockquote", "code", "table", "html"]);
  });
});

describe("text document endpoints", () => {
  it("files a text document with its Markdown and a rendered PDF", async () => {
    const doc = await createTextDocument({ title: "Gartenplan", markdown: "## Beete\n\n- Tomaten\n" });
    expect(doc.title).toBe("Gartenplan");
    expect(doc.markdown_source).toBe("## Beete\n\n- Tomaten\n");
    expect(doc.mime_type).toBe("application/pdf");
    expect(doc.original_filename).toBe("gartenplan.pdf");

    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(fs.readFileSync(row!.disk_path).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(doc.content_revision).toBe(row!.sha256);
  });

  it("saves a new version and re-renders the PDF", async () => {
    const created = await createTextDocument({ title: "Liste", markdown: "eins\n" });
    const updated = await updateTextDocument({
      id: created.id,
      title: "Liste neu",
      markdown: "eins\nzwei\n",
      base_revision: created.content_revision,
    });
    expect(updated.title).toBe("Liste neu");
    expect(updated.markdown_source).toBe("eins\nzwei\n");
    expect(updated.content_revision).not.toBe(created.content_revision);
    expect(updated.status).toBe("pending");
  });

  it("refuses a save over a newer version", async () => {
    const created = await createTextDocument({ title: "Konflikt", markdown: "a\n" });
    await updateTextDocument({ id: created.id, title: "Konflikt", markdown: "b\n", base_revision: created.content_revision });
    await expect(
      updateTextDocument({ id: created.id, title: "Konflikt", markdown: "c\n", base_revision: created.content_revision }),
    ).rejects.toThrow(/changed in the meantime/);
  });

  it("does not edit an uploaded document as text", async () => {
    const created = await createTextDocument({ title: "Upload", markdown: "x\n" });
    await db.update(documents).set({ markdown_source: null }).where(eq(documents.id, created.id));
    await expect(updateTextDocument({ id: created.id, title: "Upload", markdown: "y\n" })).rejects.toThrow(/only text documents/);
  });

  it("keeps a private text document from other users", async () => {
    const created = await createTextDocument({ title: "Privat", markdown: "geheim\n" });
    await db.update(documents).set({ visibility: "private", group_id: null }).where(eq(documents.id, created.id));
    setAuth(OTHER_ID);
    await expect(updateTextDocument({ id: created.id, title: "Privat", markdown: "x\n" })).rejects.toThrow(/not found/);
  });
});
