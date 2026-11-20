/**
 * Text documents through the assistant: notes filed and added to at once
 * with "Rückgängig", a rewrite as a proposal, and the editor's "Assistent
 * schreiben lassen". Every name and figure is made up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("./llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./llm-client")>();
  return { ...real, chat: vi.fn() };
});

import db from "../db/database";
import { assistantProposal } from "../db/schema";
import { __resetRateLimiterForTests } from "../user/rateLimiter";
import { clients, resetClients } from "./clients.test-helper";
import { chat, type ChatReply } from "./llm-client";
import { cleanComposed, composeQuestion, composeText } from "./compose";
import { catalogLines } from "./catalog";
import { executeProposal, undoProposal, writeTool, type ProposalRow } from "./proposals";
import { appendToTextDocument, createTextDocument, rewriteTextDocument } from "./tools/text-documents";
import { WRITE_TOOLS_BY_NAME } from "./tools/writes";
import type { ToolContext } from "./types";

const USER = 991801;
const PERMS = ["module.assistant", "module.documents", "documents.view", "documents.upload"];
const UNDO_PERMS = [...PERMS, "documents.delete"];
const EDIT_PERMS = [...PERMS, "documents.edit"];

function setAuth(permissions = PERMS) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(USER), permissions });
}

function ctx(permissions = PERMS): ToolContext {
  return { user: { userID: String(USER), permissions } } as ToolContext;
}

function text(content: string): ChatReply {
  return { content, tool_calls: [], finish_reason: "stop" };
}

beforeEach(async () => {
  await db.execute(
    sql`INSERT INTO users (id, email, name, password_hash)
        VALUES (${USER}, ${`u${USER}@test.local`}, ${`User${USER}`}, 'x')
        ON CONFLICT (id) DO NOTHING`,
  );
  await db.delete(assistantProposal).where(eq(assistantProposal.user_id, USER));
  resetClients();
  vi.mocked(chat).mockReset();
  __resetRateLimiterForTests();
  setAuth();
});

describe("create_text_document", () => {
  it("files the note at once and shows it as done", async () => {
    clients.documents.createTextDocument.mockResolvedValue({ id: 42, title: "Gartenplan", content_revision: "rev-1" });
    const outcome = await writeTool(createTextDocument).run({ title: "  Gartenplan  ", markdown: "## Beete\n\n- Tomaten\n" }, ctx());
    expect(outcome.text).toContain("Done #");
    expect(outcome.text).not.toContain("NOT executed");
    expect(clients.documents.createTextDocument).toHaveBeenCalledWith({ title: "Gartenplan", markdown: "## Beete\n\n- Tomaten" });
    const row = outcome.block!.rows[0] as unknown as ProposalRow;
    expect(row.status).toBe("executed");
    expect(row.immediate).toBe(true);
    expect(row.undoable).toBe(true);
    expect(row.result_route).toBe("/dokumente/42");
  });

  it("refuses a note without text and stores nothing", async () => {
    await expect(writeTool(createTextDocument).run({ title: "Leer", markdown: "  " }, ctx())).rejects.toThrow(/markdown is required/);
    expect(clients.documents.createTextDocument).not.toHaveBeenCalled();
    const stored = await db.select().from(assistantProposal).where(eq(assistantProposal.user_id, USER));
    expect(stored).toHaveLength(0);
  });

  it("stores nothing when filing fails", async () => {
    clients.documents.createTextDocument.mockRejectedValue(new Error("the document is too large"));
    await expect(writeTool(createTextDocument).run({ title: "Groß", markdown: "x" }, ctx())).rejects.toThrow(/too large/);
    const stored = await db.select().from(assistantProposal).where(eq(assistantProposal.user_id, USER));
    expect(stored).toHaveLength(0);
  });

  it("deletes the note again on undo while it is unchanged", async () => {
    clients.documents.createTextDocument.mockResolvedValue({ id: 42, title: "Gartenplan", content_revision: "rev-1" });
    const outcome = await writeTool(createTextDocument).run({ title: "Gartenplan", markdown: "Tomaten" }, ctx());
    const id = Number((outcome.block!.rows[0] as unknown as ProposalRow).proposal_id);
    clients.documents.getDocument.mockResolvedValue({ id: 42, title: "Gartenplan", markdown_source: "Tomaten\n", content_revision: "rev-1" });
    const undone = await undoProposal(id, ctx(UNDO_PERMS), WRITE_TOOLS_BY_NAME);
    expect(undone.error).toBeNull();
    expect(undone.status).toBe("undone");
    expect(undone.undoable).toBe(false);
    expect(undone.result_summary).toBe("Notiz „Gartenplan“ wieder gelöscht");
    expect(clients.documents.deleteDocument).toHaveBeenCalledWith({ id: 42 });
    // A second click finds it undone and does nothing more.
    const again = await undoProposal(id, ctx(UNDO_PERMS), WRITE_TOOLS_BY_NAME);
    expect(again.status).toBe("undone");
    expect(clients.documents.deleteDocument).toHaveBeenCalledTimes(1);
  });

  it("keeps a note that was edited since, and says why", async () => {
    clients.documents.createTextDocument.mockResolvedValue({ id: 42, title: "Gartenplan", content_revision: "rev-1" });
    const outcome = await writeTool(createTextDocument).run({ title: "Gartenplan", markdown: "Tomaten" }, ctx());
    const id = Number((outcome.block!.rows[0] as unknown as ProposalRow).proposal_id);
    clients.documents.getDocument.mockResolvedValue({ id: 42, title: "Gartenplan", markdown_source: "Tomaten und Gurken\n", content_revision: "rev-2" });
    const kept = await undoProposal(id, ctx(UNDO_PERMS), WRITE_TOOLS_BY_NAME);
    expect(kept.status).toBe("executed");
    expect(kept.error).toMatch(/inzwischen geändert/);
    expect(kept.undoable).toBe(true);
    expect(clients.documents.deleteDocument).not.toHaveBeenCalled();
  });

  it("needs the right to delete documents for undo", async () => {
    clients.documents.createTextDocument.mockResolvedValue({ id: 42, title: "Gartenplan", content_revision: "rev-1" });
    const outcome = await writeTool(createTextDocument).run({ title: "Gartenplan", markdown: "Tomaten" }, ctx());
    const id = Number((outcome.block!.rows[0] as unknown as ProposalRow).proposal_id);
    const kept = await undoProposal(id, ctx(), WRITE_TOOLS_BY_NAME);
    expect(kept.status).toBe("executed");
    expect(kept.error).toMatch(/Recht, Dokumente zu löschen/);
  });

  it("is listed as running at once", () => {
    expect(catalogLines([writeTool(createTextDocument)])).toContain("create_text_document (runs at once)");
  });
});

describe("append_to_text_document", () => {
  const NOTES = { documents: [
    { id: 7, title: "Einkaufsliste", excerpt: "Brot", uploaded_at: null },
    { id: 8, title: "Heizung Wartung", excerpt: "Filter", uploaded_at: null },
    { id: 9, title: "Heizung Ablesen", excerpt: "Zähler", uploaded_at: null },
  ] };

  it("finds the note by its title and adds only the new text", async () => {
    clients.documents.listTextDocuments.mockResolvedValue(NOTES);
    clients.documents.getDocument.mockResolvedValue({ id: 7, title: "Einkaufsliste", markdown_source: "- Brot\n", content_revision: "rev-1" });
    clients.documents.appendToTextDocument.mockResolvedValue({ id: 7, title: "Einkaufsliste", markdown_source: "- Brot\n\n- Milch\n", content_revision: "rev-2" });
    const outcome = await writeTool(appendToTextDocument).run({ note: "einkaufsliste", markdown: "- Milch" }, ctx(EDIT_PERMS));
    expect(clients.documents.appendToTextDocument).toHaveBeenCalledWith({ id: 7, text: "- Milch", base_revision: "rev-1" });
    const row = outcome.block!.rows[0] as unknown as ProposalRow;
    expect(row.status).toBe("executed");
    expect(row.result_summary).toBe("An Notiz „Einkaufsliste“ angehängt");
  });

  it("names the candidates instead of guessing between two notes", async () => {
    clients.documents.listTextDocuments.mockResolvedValue(NOTES);
    await expect(writeTool(appendToTextDocument).run({ note: "Heizung", markdown: "x" }, ctx(EDIT_PERMS)))
      .rejects.toThrow(/several notes match "Heizung": "Heizung Wartung" \(document_id 8\), "Heizung Ablesen" \(document_id 9\)/);
    expect(clients.documents.appendToTextDocument).not.toHaveBeenCalled();
  });

  it("lists the notes when no title fits", async () => {
    clients.documents.listTextDocuments.mockResolvedValue(NOTES);
    await expect(writeTool(appendToTextDocument).run({ note: "Urlaub", markdown: "x" }, ctx(EDIT_PERMS)))
      .rejects.toThrow(/no note is called "Urlaub".*Einkaufsliste.*create_text_document/);
  });

  it("puts the text back as it was on undo", async () => {
    clients.documents.listTextDocuments.mockResolvedValue(NOTES);
    clients.documents.getDocument.mockResolvedValueOnce({ id: 7, title: "Einkaufsliste", markdown_source: "- Brot\n", content_revision: "rev-1" });
    clients.documents.appendToTextDocument.mockResolvedValue({ id: 7, title: "Einkaufsliste", markdown_source: "- Brot\n\n- Milch\n", content_revision: "rev-2" });
    const outcome = await writeTool(appendToTextDocument).run({ note: "Einkaufsliste", markdown: "- Milch" }, ctx(EDIT_PERMS));
    const id = Number((outcome.block!.rows[0] as unknown as ProposalRow).proposal_id);
    clients.documents.getDocument.mockResolvedValueOnce({ id: 7, title: "Einkaufsliste", markdown_source: "- Brot\n\n- Milch\n", content_revision: "rev-2" });
    const undone = await undoProposal(id, ctx(EDIT_PERMS), WRITE_TOOLS_BY_NAME);
    expect(undone.status).toBe("undone");
    expect(clients.documents.updateTextDocument).toHaveBeenCalledWith({ id: 7, title: "Einkaufsliste", markdown: "- Brot\n", base_revision: "rev-2" });
  });
});

describe("rewrite_text_document", () => {
  it("waits on a card with the new text", async () => {
    clients.documents.getDocument.mockResolvedValue({ id: 7, title: "Einkaufsliste", markdown_source: "- Brot\n- Eier\n", content_revision: "rev-1" });
    const outcome = await writeTool(rewriteTextDocument).run({ document_id: 7, markdown: "- Brot" }, ctx(EDIT_PERMS));
    expect(outcome.text).toContain("NOT executed");
    const row = outcome.block!.rows[0] as unknown as ProposalRow;
    expect(row.status).toBe("pending");
    expect(row.immediate).toBe(false);
    expect(row.text_document).toEqual({ title: "Einkaufsliste", markdown: "- Brot" });
    expect(clients.documents.updateTextDocument).not.toHaveBeenCalled();

    clients.documents.updateTextDocument.mockResolvedValue({ id: 7, title: "Einkaufsliste", markdown_source: "- Brot\n", content_revision: "rev-2" });
    const done = await executeProposal(Number(row.proposal_id), ctx(EDIT_PERMS), WRITE_TOOLS_BY_NAME);
    expect(done.status).toBe("executed");
    expect(clients.documents.updateTextDocument).toHaveBeenCalledWith({ id: 7, title: "Einkaufsliste", markdown: "- Brot", base_revision: "rev-1" });
  });

  it("refuses a document that is no text document", async () => {
    clients.documents.getDocument.mockResolvedValue({ id: 5, title: "Rechnung", markdown_source: null, content_revision: "rev-1" });
    await expect(writeTool(rewriteTextDocument).run({ document_id: 5, markdown: "x" }, ctx(EDIT_PERMS))).rejects.toThrow(/no text document/);
  });
});

describe("compose helpers", () => {
  it("hands the document so far and the instruction to the agent", () => {
    const q = composeQuestion({ instruction: "Schreib einen Schlusssatz", title: "Einladung", text: "Liebe Nachbarn," });
    expect(q).toContain("Title of the document: Einladung");
    expect(q).toContain("<<<\nLiebe Nachbarn,\n>>>");
    expect(q.trim().endsWith("Instruction: Schreib einen Schlusssatz")).toBe(true);
  });

  it("strips a code fence and a lead-in line", () => {
    expect(cleanComposed("```markdown\n## Hallo\n\nText\n```")).toBe("## Hallo\n\nText");
    expect(cleanComposed("Hier ist der Text:\n\nLiebe Nachbarn")).toBe("Liebe Nachbarn");
  });
});

describe("composeText", () => {
  it("returns the text the model wrote, offering read tools only", async () => {
    vi.mocked(chat).mockResolvedValue(text("Wir laden herzlich zum Sommerfest ein."));
    const res = await composeText({ instruction: "Eine Einladung zum Sommerfest" });
    expect(res.markdown).toBe("Wir laden herzlich zum Sommerfest ein.");
    const offered = (vi.mocked(chat).mock.calls[0]![0].tools ?? []) as Array<{ function?: { name?: string } }>;
    const names = offered.map((t) => t.function?.name);
    expect(names).not.toContain("create_text_document");
    expect(names).not.toContain("render_letter");
  });

  it("needs the assistant module", async () => {
    setAuth(["module.documents"]);
    await expect(composeText({ instruction: "Etwas" })).rejects.toThrow();
  });

  it("refuses an empty instruction", async () => {
    await expect(composeText({ instruction: "  " })).rejects.toThrow(/instruction is empty/);
  });
});
