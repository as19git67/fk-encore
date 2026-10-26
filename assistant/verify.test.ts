import { describe, it, expect } from "vitest";

import { CHECK_ANSWER_NAME, checkRequest, isCheckRequest, MAX_RESULT_CHARS, parseVerdict, turnResults, ungroundedNudge, unverifiedNote, verifyByDefault, wrongAreaNudge } from "./verify";
import type { ChatMessage } from "./types";

function verdict(args: Record<string, unknown>) {
  return { tool_calls: [{ id: "v1", type: "function" as const, function: { name: CHECK_ANSWER_NAME, arguments: JSON.stringify(args) } }] };
}

const AREAS = [
  { id: "finance" as const, description: "Bookings.", tools: ["list_transactions"], inPlay: true },
  { id: "meters" as const, description: "Meters.", tools: ["list_meters"], inPlay: false },
];

describe("the checker's request (stage 5 of assistent-wegfindung.md)", () => {
  it("carries the question, each result with its tool, the answer and the areas, bound to check_answer", () => {
    const req = checkRequest({
      question: "Was habe ich im Baumarkt ausgegeben?",
      results: [{ tool: "list_transactions", arguments: '{"q":"baumarkt"}', content: "2 rows\n| 2026-10-01 | -45,00 € |" }],
      answer: "45,00 € am 1. Oktober.",
      areas: AREAS,
    });
    expect(isCheckRequest(req)).toBe(true);
    expect(req.tools).toHaveLength(1);
    expect(req.max_tokens).toBeLessThan(400);
    const body = (req.messages[1] as { content: string }).content;
    expect(body).toContain("Question:\nWas habe ich im Baumarkt ausgegeben?");
    expect(body).toContain('Result 1, list_transactions({"q":"baumarkt"}):\n2 rows');
    expect(body).toContain("Answer:\n45,00 € am 1. Oktober.");
    expect(body).toContain("- finance (used this turn): Bookings. Tools: list_transactions");
    expect(body).toContain("- meters: Meters. Tools: list_meters");
    expect((req.messages[0] as { content: string }).content).toContain("Not your task: style");
  });

  it("says when no tool was called, and cuts a long result", () => {
    const none = checkRequest({ question: "q", results: [], answer: "a", areas: AREAS });
    expect((none.messages[1] as { content: string }).content).toContain("(no tool was called this turn)");
    const long = checkRequest({ question: "q", results: [{ tool: "t", arguments: "{}", content: "x".repeat(MAX_RESULT_CHARS + 50) }], answer: "a", areas: AREAS });
    const body = (long.messages[1] as { content: string }).content;
    expect(body).toContain("… (cut for the check)");
    expect(body.length).toBeLessThan(MAX_RESULT_CHARS + 600);
  });

  it("is told apart from a loop round and from the other bound calls", () => {
    expect(isCheckRequest({ messages: [], tools: [{}], tool_choice: "auto" })).toBe(false);
    expect(isCheckRequest({ messages: [], tools: [{}], tool_choice: { type: "function", function: { name: "write_plan" } } })).toBe(false);
  });
});

describe("the verdict", () => {
  it("is read from the bound call, with the area only when it is one", () => {
    expect(parseVerdict(verdict({ grounded: true, missing: "", wrong_area: "none" }))).toEqual({ grounded: true, missing: "", wrongArea: null });
    expect(parseVerdict(verdict({ grounded: false, missing: "  Die Summe 45 €  steht in keinem Ergebnis. ", wrong_area: "meters" })))
      .toEqual({ grounded: false, missing: "Die Summe 45 € steht in keinem Ergebnis.", wrongArea: "meters" });
    expect(parseVerdict(verdict({ grounded: false, missing: "x", wrong_area: "weather" }))?.wrongArea).toBeNull();
  });

  it("is null when the model gave none the loop can use", () => {
    expect(parseVerdict({ tool_calls: [] })).toBeNull();
    expect(parseVerdict(verdict({ missing: "x" }))).toBeNull();
    expect(parseVerdict({ tool_calls: [{ id: "v", type: "function", function: { name: CHECK_ANSWER_NAME, arguments: "{not json" } }] })).toBeNull();
  });
});

describe("what the check reads", () => {
  it("pairs each tool result with its call and leaves the meta tools out", () => {
    const turn: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [
        { id: "p", type: "function", function: { name: "write_plan", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "p", content: "Plan: …" },
      { role: "assistant", content: null, tool_calls: [
        { id: "a", type: "function", function: { name: "list_transactions", arguments: '{"q":"baumarkt"}' } },
        { id: "b", type: "function", function: { name: "switch_area", arguments: '{"area":"meters"}' } },
      ] },
      { role: "tool", tool_call_id: "a", content: "2 rows" },
      { role: "tool", tool_call_id: "b", content: "Tools of meters: …" },
    ];
    expect(turnResults(turn, new Set(["write_plan", "switch_area"]))).toEqual([
      { tool: "list_transactions", arguments: '{"q":"baumarkt"}', content: "2 rows" },
    ]);
  });
});

describe("what goes back, and what the user reads", () => {
  it("names the claim in the nudge, the area with its package, and the gap under the answer", () => {
    expect(ungroundedNudge("Die Summe 45 € steht in keinem Ergebnis.")).toContain("found a claim they do not hold: Die Summe 45 € steht in keinem Ergebnis.");
    expect(ungroundedNudge("")).toContain("a figure, name or row that no tool result holds");
    expect(wrongAreaNudge("meters", "Tools of meters:\n- list_meters: …")).toContain("the question is about meters, whose tools were not used this turn. They are offered now:\n\nTools of meters:");
    expect(unverifiedNote("Die Summe 45 €.")).toBe("_Hinweis: Diese Angabe konnte ich nicht in den gelesenen Daten belegen: Die Summe 45 €._");
    expect(unverifiedNote("")).toContain("einzelne Angaben");
  });

  it("is on unless ASSISTANT_VERIFY is 0 (the test suite sets 0)", () => {
    expect(verifyByDefault()).toBe(false);
    const before = process.env.ASSISTANT_VERIFY;
    process.env.ASSISTANT_VERIFY = "1";
    try {
      expect(verifyByDefault()).toBe(true);
      delete process.env.ASSISTANT_VERIFY;
      expect(verifyByDefault()).toBe(true);
    } finally {
      process.env.ASSISTANT_VERIFY = before;
    }
  });
});
