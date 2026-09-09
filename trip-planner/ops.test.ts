/**
 * The vocabulary of a change (§6.3).
 *
 * What has to hold before any of it is applied: a payload that does not
 * carry what its operation needs is refused rather than half-applied,
 * an undo is a real inverse rather than a plausible guess, and the one
 * operation without an inverse says so instead of inventing one.
 */

import { describe, expect, it } from "vitest";
import {
  describe as sentenceFor,
  inverseOf,
  isOpKind,
  isUndoable,
  validatePayload,
  OP_KINDS,
} from "./ops";

describe("what counts as an operation", () => {
  it("knows its own vocabulary and nothing else", () => {
    expect(isOpKind("hide-spot")).toBe(true);
    expect(isOpKind("delete-everything")).toBe(false);
    expect(OP_KINDS).toContain("vote");
  });

  it("refuses a payload that is missing what it needs", () => {
    expect(validatePayload("hide-spot", {})).toMatch(/osmRef/);
    expect(validatePayload("vote", { osmRef: "node:1" })).toMatch(/value/);
    expect(validatePayload("spot-note", { osmRef: "node:1" })).toMatch(/legIndex/);
    expect(validatePayload("stop-to-pool", { stopId: "acht" })).toMatch(/stopId/);
  });

  it("accepts one that carries it", () => {
    expect(validatePayload("hide-spot", { osmRef: "node:1" })).toBeNull();
    expect(validatePayload("vote", { osmRef: "node:1", value: "want" })).toBeNull();
    expect(validatePayload("spot-note", { osmRef: "node:1", legIndex: 0 })).toBeNull();
    expect(validatePayload("stop-to-pool", { stopId: 8 })).toBeNull();
  });
});

describe("taking one back", () => {
  it("turns hiding into unhiding, and the other way round", () => {
    expect(inverseOf("hide-spot", { osmRef: "node:1" }, null))
      .toEqual({ kind: "unhide-spot", payload: { osmRef: "node:1" } });
    expect(inverseOf("unhide-spot", { osmRef: "node:1" }, null))
      .toEqual({ kind: "hide-spot", payload: { osmRef: "node:1" } });
  });

  it("puts back the answer a vote replaced", () => {
    const back = inverseOf(
      "vote",
      { osmRef: "node:1", value: "rather-not" },
      { value: "want", heart: true },
    );

    expect(back?.payload).toMatchObject({ value: "want", heart: true });
  });

  it("undoes a first vote to a shrug rather than inventing an opinion", () => {
    // There is no "unvote": nobody having said anything and somebody
    // saying "egal" are the nearest two states, and the second is the
    // one that does not put words in a mouth.
    const back = inverseOf("vote", { osmRef: "node:1", value: "want" }, null);

    expect(back?.payload).toMatchObject({ value: "meh", heart: false });
  });

  it("puts back the note it replaced, including the empty one", () => {
    const back = inverseOf(
      "spot-note",
      { legIndex: 0, osmRef: "node:1", note: "Eingang hinten" },
      null,
    );

    expect(back?.payload).toMatchObject({ note: null, title: null, photoStop: false });
  });

  it("says plainly that a stop put back in the pool cannot be undone", () => {
    // The day was re-solved around the gap. Planning something similar
    // into roughly the same slot would be a new decision (§6.3).
    expect(isUndoable("stop-to-pool")).toBe(false);
    expect(inverseOf("stop-to-pool", { stopId: 8 }, null)).toBeNull();
  });
});

describe("what the journal says", () => {
  it("uses the spot's name when the trip knows one", () => {
    expect(sentenceFor("hide-spot", { osmRef: "node:1" }, "Stadtmuseum"))
      .toBe("Stadtmuseum für diese Reise ausgeblendet");
  });

  it("falls back to the reference rather than to nothing", () => {
    expect(sentenceFor("hide-spot", { osmRef: "node:1" })).toContain("node:1");
  });

  it("tells a heart wish from an ordinary want", () => {
    expect(sentenceFor("vote", { osmRef: "node:1", value: "want", heart: true }, "Turm"))
      .toBe("Turm zum Herzenswunsch gemacht");
    expect(sentenceFor("vote", { osmRef: "node:1", value: "want" }, "Turm"))
      .toBe("Turm: will ich");
    expect(sentenceFor("vote", { osmRef: "node:1", value: "meh" }, "Turm"))
      .toBe("Turm: egal");
  });
});
