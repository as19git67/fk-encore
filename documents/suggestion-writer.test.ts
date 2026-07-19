import { describe, it, expect } from "vitest";
import {
  AUTO_SENDER_MARKER,
  USER_PROPOSED_MARKER,
  planSuggestion,
  planUserProposal,
  suggestionRationale,
  userProposalRationale,
  type OpenSuggestion,
} from "./suggestion-writer";

const marker = (sender: string) => `${AUTO_SENDER_MARKER}${sender}`;

describe("planSuggestion", () => {
  it("is a no-op for an empty/normalizing-to-empty sender", () => {
    expect(planSuggestion([], null, 1)).toEqual({ kind: "noop" });
    expect(planSuggestion([], "   ", 1)).toEqual({ kind: "noop" });
  });

  it("inserts a new suggestion when none exists for the sender", () => {
    const plan = planSuggestion([], "Neuer Absender", 42);
    expect(plan).toEqual({ kind: "insert", marker: marker("neuerabsender") });
  });

  it("appends the document to an existing open suggestion for the same sender", () => {
    const open: OpenSuggestion[] = [
      {
        id: 5,
        rationale: suggestionRationale(marker("acmegmbh"), "Acme GmbH"),
        example_document_ids: [1, 2],
      },
    ];
    const plan = planSuggestion(open, "ACME  GmbH", 3);
    expect(plan).toEqual({ kind: "append", id: 5, exampleIds: [1, 2, 3] });
  });

  it("does not append a document id that is already recorded", () => {
    const open: OpenSuggestion[] = [
      { id: 5, rationale: marker("acmegmbh"), example_document_ids: [1, 2, 3] },
    ];
    expect(planSuggestion(open, "Acme GmbH", 3)).toEqual({ kind: "noop" });
  });

  it("caps the example list at 20 (keeps the most recent)", () => {
    const ids = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    const open: OpenSuggestion[] = [
      { id: 5, rationale: marker("acmegmbh"), example_document_ids: ids },
    ];
    const plan = planSuggestion(open, "Acme GmbH", 21);
    expect(plan.kind).toBe("append");
    if (plan.kind === "append") {
      expect(plan.exampleIds).toHaveLength(20);
      expect(plan.exampleIds[0]).toBe(2); // 1 dropped from the front
      expect(plan.exampleIds.at(-1)).toBe(21);
    }
  });

  it("matches the right sender when several suggestions are open", () => {
    const open: OpenSuggestion[] = [
      { id: 1, rationale: marker("foo"), example_document_ids: [10] },
      { id: 2, rationale: marker("bar"), example_document_ids: [20] },
    ];
    expect(planSuggestion(open, "Bar", 21)).toEqual({
      kind: "append",
      id: 2,
      exampleIds: [20, 21],
    });
  });
});

describe("suggestionRationale", () => {
  it("prefixes the machine marker so planSuggestion can dedup on it", () => {
    const r = suggestionRationale(marker("acme"), "Acme GmbH");
    expect(r.startsWith(marker("acme"))).toBe(true);
    expect(r).toContain("Acme GmbH");
  });
});

const userMarker = (name: string) => `${USER_PROPOSED_MARKER}${name}`;

describe("planUserProposal", () => {
  it("is a no-op for a name that normalizes to empty", () => {
    expect(planUserProposal([], "   ", 1)).toEqual({ kind: "noop" });
  });

  it("inserts a new suggestion keyed on the proposed name", () => {
    const plan = planUserProposal([], "Vereinsbeiträge", 42);
    expect(plan).toEqual({ kind: "insert", marker: userMarker("vereinsbeiträge") });
  });

  it("appends to an existing open proposal with the same name", () => {
    const open: OpenSuggestion[] = [
      {
        id: 7,
        rationale: userProposalRationale(userMarker("vereinsbeiträge"), 1),
        example_document_ids: [1],
      },
    ];
    const plan = planUserProposal(open, "Vereinsbeiträge", 2);
    expect(plan).toEqual({ kind: "append", id: 7, exampleIds: [1, 2] });
  });

  it("does not collide with an auto-sender suggestion of a similar key", () => {
    const open: OpenSuggestion[] = [
      { id: 9, rationale: marker("vereinsbeiträge"), example_document_ids: [1] },
    ];
    // Same normalized key but different marker prefix → treated as new.
    expect(planUserProposal(open, "Vereinsbeiträge", 2)).toEqual({
      kind: "insert",
      marker: userMarker("vereinsbeiträge"),
    });
  });
});
