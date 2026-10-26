import { describe, it, expect, vi } from "vitest";

import {
  isSummaryRequest,
  MAX_SUMMARY_CHARS,
  parseSummary,
  SUMMARIZE_TURN_NAME,
  SUMMARY_TOKENS,
  summarizedTurn,
  summarizeTurn,
  summaryNote,
  summaryRequest,
} from "./summary";
import type { ChatReply } from "./llm-client";
import type { ChatMessage } from "./types";

const TURN: ChatMessage[] = [
  { role: "user", content: "Zeig mir die Buchungen vom Baumarkt im September." },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_transactions", arguments: "{\"q\":\"Baumarkt\"}" } }] },
  { role: "tool", tool_call_id: "c1", content: "id | date | amount\n9401 | 2026-09-03 | -98.40\n(1 row)" },
  { role: "assistant", content: "Eine Buchung beim Baumarkt im September: 98,40 € am 3. September." },
];

function summaryCall(args: unknown): ChatReply {
  return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: "s", type: "function", function: { name: SUMMARIZE_TURN_NAME, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] };
}

describe("the summary request (stage 4 of assistent-wegfindung.md)", () => {
  it("sends the turn as it happened after its own instructions, bound to summarize_turn", () => {
    const req = summaryRequest(TURN);
    expect(req.messages[0]).toMatchObject({ role: "system" });
    expect((req.messages[0] as { content: string }).content).toContain(SUMMARIZE_TURN_NAME);
    expect(req.messages.slice(1)).toEqual(TURN);
    expect(req.tool_choice).toEqual({ type: "function", function: { name: SUMMARIZE_TURN_NAME } });
    expect(req.tools).toHaveLength(1);
    expect(req.max_tokens).toBe(SUMMARY_TOKENS);
    expect(isSummaryRequest(req)).toBe(true);
    expect(isSummaryRequest({ messages: TURN })).toBe(false);
  });

  it("asks for the user's language, figures and row counts, and forbids ids and tool names", () => {
    const prompt = (summaryRequest(TURN).messages[0] as { content: string }).content;
    for (const word of ["user's language", "how many rows", "never ids", "never tool names"]) expect(prompt).toContain(word);
  });
});

describe("parseSummary", () => {
  it("takes the summary the tool call carries, whitespace folded", () => {
    expect(parseSummary(summaryCall({ summary: "Gefragt war nach dem Baumarkt im September.\n  Eine Buchung über 98,40 €." })))
      .toBe("Gefragt war nach dem Baumarkt im September. Eine Buchung über 98,40 €.");
  });

  it("returns null for another tool, no tool, malformed arguments or a summary too short to mean anything", () => {
    expect(parseSummary({ tool_calls: [] })).toBeNull();
    expect(parseSummary({ tool_calls: [{ id: "x", type: "function", function: { name: "write_plan", arguments: "{}" } }] })).toBeNull();
    expect(parseSummary(summaryCall("{not json"))).toBeNull();
    expect(parseSummary(summaryCall({ summary: 42 }))).toBeNull();
    expect(parseSummary(summaryCall({ summary: "Nichts." }))).toBeNull();
  });

  it("cuts a summary that would save nothing over the turn it replaces", () => {
    const long = "Wort ".repeat(400);
    const out = parseSummary(summaryCall({ summary: long }))!;
    expect(out.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("the replayed form", () => {
  it("notes the tools with their row counts, a proposal as such, and the way back to the rows", () => {
    expect(summaryNote([
      { tool: "list_transactions", digest: "[earlier result of list_transactions: 3 rows, ids 9401,9402,9403]" },
      { tool: "get_document_summary", digest: "[earlier result of get_document_summary: 1 row, ids 40]" },
      { tool: "tag_transactions", digest: "[earlier proposal #5: Bei 3 Buchungen „Renovierung“ setzen]" },
      { tool: "consumption_report", digest: null },
    ])).toBe("[summary of an earlier turn; tools then: list_transactions (3 rows), get_document_summary (1 row), tag_transactions (proposal), consumption_report. Follow-ups on those rows use from_previous_result.]");
    expect(summaryNote([])).toBe("[summary of an earlier turn. Follow-ups on those rows use from_previous_result.]");
  });

  it("is the question and the summary with its note in the answer's place", () => {
    const turn = summarizedTurn("Zeig mir die Buchungen vom Baumarkt.", "Eine Buchung über 98,40 €.", "[note]");
    expect(turn).toEqual([
      { role: "user", content: "Zeig mir die Buchungen vom Baumarkt." },
      { role: "assistant", content: "Eine Buchung über 98,40 €.\n\n[note]" },
    ]);
  });
});

describe("summarizeTurn", () => {
  it("returns the model's summary, or null when it wrote none", async () => {
    const chat = vi.fn(async () => summaryCall({ summary: "Gefragt war nach dem Baumarkt; eine Buchung über 98,40 € am 3. September." }));
    expect(await summarizeTurn(chat, TURN)).toBe("Gefragt war nach dem Baumarkt; eine Buchung über 98,40 € am 3. September.");
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ tool_choice: { type: "function", function: { name: SUMMARIZE_TURN_NAME } } }), undefined, undefined);
    const silent = vi.fn(async (): Promise<ChatReply> => ({ content: "…", tool_calls: [], finish_reason: "stop" }));
    expect(await summarizeTurn(silent, TURN)).toBeNull();
  });
});
