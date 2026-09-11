/**
 * The scoring rule for the negotiation chat (§11.3, Weg 3).
 *
 * The rule has to hold one line above all: doing more than was asked is
 * never offset by also doing the right thing.
 */

import { describe, expect, it } from "vitest";
import { CHAT_CASES, CHAT_PLAN, CHAT_TOOLS } from "./chat-cases";
import { scoreChat, totalsOfChat } from "./chat-score";
import { buildChatPrompt, parseCalls } from "./run-chat";

const caseOf = (id: string) => CHAT_CASES.find((benchCase) => benchCase.id === id)!;

describe("scoreChat", () => {
  it("accepts the expected call, ignoring arguments it does not name", () => {
    const score = scoreChat(caseOf("zu-viel-laufen"), [
      { tool: "constraint_setzen", args: { feld: "maxWalkMinutes", wert: 20 } },
    ]);
    expect(score.hit).toBe(true);
    expect(score.overreach).toEqual([]);
  });

  it("rejects the right tool with the wrong subject", () => {
    // A ref is an identity: the wrong one is a different spot, not a
    // different phrasing.
    const score = scoreChat(caseOf("burg-bleibt"), [
      { tool: "anheften", args: { ref: "way:1" } },
    ]);
    expect(score.hit).toBe(false);
    expect(score.missing).toEqual(["anheften(ref=way:3)"]);
  });

  it("counts a forbidden call as overreach even when the right call is there", () => {
    const score = scoreChat(caseOf("zu-viel-laufen"), [
      { tool: "constraint_setzen", args: { feld: "maxWalkMinutes" } },
      { tool: "spot_entfernen", args: { ref: "way:2" } },
    ]);
    expect(score.hit).toBe(true);
    expect(score.overreach).toEqual(["spot_entfernen"]);
  });

  it("wants every expected call when several belong together", () => {
    const benchCase = caseOf("drei-museen");
    const half = scoreChat(benchCase, [{ tool: "spot_entfernen", args: { ref: "way:13" } }]);
    expect(half.hit).toBe(false);

    const both = scoreChat(benchCase, [
      { tool: "spot_entfernen", args: { ref: "way:13" } },
      { tool: "neu_verteilen", args: { tag: 1 } },
    ]);
    expect(both.hit).toBe(true);
  });

  it("treats a day index as a number however it is written", () => {
    const score = scoreChat(caseOf("drei-museen"), [
      { tool: "spot_entfernen", args: { ref: "way:9" } },
      { tool: "neu_verteilen", args: { tag: "1" } },
    ]);
    expect(score.hit).toBe(true);
  });

  it("counts asking instead of guessing as the hit it is", () => {
    const asked = scoreChat(caseOf("zu-voll-welcher-tag"), [
      { tool: "rueckfrage", args: { frage: "Welchen Tag meinst du?" } },
    ]);
    expect(asked.hit).toBe(true);

    const guessed = scoreChat(caseOf("zu-voll-welcher-tag"), [
      { tool: "neu_verteilen", args: { tag: 1 } },
    ]);
    expect(guessed.hit).toBe(false);
    expect(guessed.overreach).toEqual(["neu_verteilen"]);
  });

  it("wants silence where the sentence asks for nothing", () => {
    const quiet = scoreChat(caseOf("danke"), [{ tool: "nichts", args: {} }]);
    expect(quiet.hit).toBe(true);

    const busy = scoreChat(caseOf("danke"), [
      { tool: "neu_verteilen", args: { tag: 0 } },
    ]);
    expect(busy.hit).toBe(false);
    expect(busy.overreach).toEqual(["neu_verteilen"]);
  });
});

describe("totalsOfChat", () => {
  it("counts one act of overreach per case, not per call", () => {
    const score = scoreChat(caseOf("zu-viel-laufen"), [
      { tool: "spot_entfernen", args: {} },
      { tool: "spot_verbergen", args: {} },
    ]);
    expect(totalsOfChat([score]).overreaching).toBe(1);
  });

  it("keeps a track that could not answer apart from a wrong one", () => {
    const totals = totalsOfChat([null, scoreChat(caseOf("danke"), [{ tool: "nichts", args: {} }])]);
    expect(totals.failures).toBe(1);
    expect(totals.hits).toBe(1);
  });
});

describe("parseCalls", () => {
  it("reads the documented shape", () => {
    expect(parseCalls({ calls: [{ tool: "nichts", args: {} }] }))
      .toEqual([{ tool: "nichts", args: {} }]);
  });

  it("tolerates a bare array, other key names and a plain string", () => {
    expect(parseCalls([{ name: "anheften", arguments: { ref: "way:3" } }]))
      .toEqual([{ tool: "anheften", args: { ref: "way:3" } }]);
    expect(parseCalls({ calls: ["nichts"] })).toEqual([{ tool: "nichts", args: {} }]);
  });

  it("drops an entry with no tool name rather than guessing one", () => {
    expect(parseCalls({ calls: [{ args: { ref: "way:3" } }] })).toEqual([]);
  });
});

describe("the chat cases", () => {
  it("have unique ids and a note each", () => {
    const ids = CHAT_CASES.map((benchCase) => benchCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const benchCase of CHAT_CASES) {
      expect(benchCase.note.length, benchCase.id).toBeGreaterThan(10);
    }
  });

  it("only expect tools that exist", () => {
    const known = new Set(CHAT_TOOLS.map((tool) => tool.name));
    for (const benchCase of CHAT_CASES) {
      for (const call of benchCase.expected) {
        expect(known.has(call.tool), `${benchCase.id}: ${call.tool}`).toBe(true);
      }
      for (const name of benchCase.forbidden ?? []) {
        expect(known.has(name), `${benchCase.id}: ${name}`).toBe(true);
      }
    }
  });

  it("only name refs that are in the plan", () => {
    // An expectation pointing at a spot the plan does not contain would
    // fail every track for a fault of the fixture's.
    const refs = new Set(
      CHAT_PLAN.days.flatMap((day) => day.blocks.flatMap((block) => block.stops.map((s) => s.ref))),
    );
    for (const benchCase of CHAT_CASES) {
      for (const call of benchCase.expected) {
        const ref = call.args?.ref;
        if (typeof ref === "string") expect(refs.has(ref), `${benchCase.id}: ${ref}`).toBe(true);
      }
    }
  });

  it("cover asking, silence and plain action", () => {
    const tools = CHAT_CASES.flatMap((benchCase) => benchCase.expected.map((call) => call.tool));
    expect(tools).toContain("rueckfrage");
    expect(tools).toContain("nichts");
    expect(tools).toContain("constraint_setzen");
  });

  it("put the whole plan and every tool in front of the model", () => {
    const prompt = buildChatPrompt(caseOf("zu-viel-laufen"));
    for (const tool of CHAT_TOOLS) expect(prompt).toContain(tool.name);
    expect(prompt).toContain("Stiftskirche Sankt Kolomann");
    expect(prompt).toContain("zu viel Laufen");
  });
});
