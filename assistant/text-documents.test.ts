/**
 * Text documents through the assistant: filing one as a proposal, and the
 * editor's "Assistent schreiben lassen". Every name and figure is made up.
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
import { executeProposal, writeTool, type ProposalRow } from "./proposals";
import { createTextDocument } from "./tools/text-documents";
import { WRITE_TOOLS_BY_NAME } from "./tools/writes";
import type { ToolContext } from "./types";

const USER = 991801;
const PERMS = ["module.assistant", "module.documents", "documents.view", "documents.upload"];

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
  it("proposes the document with its text on the card", async () => {
    const outcome = await writeTool(createTextDocument).run({ title: "  Gartenplan  ", markdown: "## Beete\n\n- Tomaten\n" }, ctx());
    expect(outcome.text).toContain("NOT executed");
    const row = outcome.block!.rows[0] as unknown as ProposalRow;
    expect(row.summary).toBe("Textdokument „Gartenplan“ ablegen");
    expect(row.text_document).toEqual({ title: "Gartenplan", markdown: "## Beete\n\n- Tomaten" });
    expect(clients.documents.createTextDocument).not.toHaveBeenCalled();
  });

  it("refuses a proposal without text", async () => {
    await expect(writeTool(createTextDocument).run({ title: "Leer", markdown: "  " }, ctx())).rejects.toThrow(/markdown is required/);
  });

  it("files the document when the user confirms", async () => {
    clients.documents.createTextDocument.mockResolvedValue({ id: 42, title: "Gartenplan" });
    const outcome = await writeTool(createTextDocument).run({ title: "Gartenplan", markdown: "Tomaten" }, ctx());
    const id = Number((outcome.block!.rows[0] as unknown as ProposalRow).proposal_id);
    const done = await executeProposal(id, ctx(), WRITE_TOOLS_BY_NAME);
    expect(done.status).toBe("executed");
    expect(done.result_route).toBe("/dokumente/42");
    expect(clients.documents.createTextDocument).toHaveBeenCalledWith({ title: "Gartenplan", markdown: "Tomaten" });
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
