import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isRegionStatus,
  REGION_STATUSES,
} from "./state-machine";

describe("isRegionStatus", () => {
  it("recognises every documented status", () => {
    for (const s of REGION_STATUSES) {
      expect(isRegionStatus(s)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isRegionStatus("started")).toBe(false);
    expect(isRegionStatus("")).toBe(false);
  });
});

describe("canTransition", () => {
  it("allows the happy path from pending_approval → ready_running", () => {
    expect(canTransition("pending_approval", "importing")).toBe(true);
    expect(canTransition("importing", "ready_running")).toBe(true);
    expect(canTransition("ready_running", "ready_stopped")).toBe(true);
    expect(canTransition("ready_stopped", "ready_running")).toBe(true);
  });

  it("allows recovery from failed/blocked back into the pipeline", () => {
    expect(canTransition("failed", "importing")).toBe(true);
    expect(canTransition("blocked_disk", "pending_approval")).toBe(true);
  });

  it("blocks illegal transitions", () => {
    expect(canTransition("pending_approval", "ready_running")).toBe(false);
    expect(canTransition("ready_running", "importing")).toBe(false);
    expect(canTransition("ready_stopped", "pending_approval")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("throws with an explanatory message on illegal transitions", () => {
    expect(() => assertTransition("ready_running", "importing")).toThrow(
      /invalid region status transition: ready_running → importing/,
    );
  });

  it("returns silently on legal transitions", () => {
    expect(() => assertTransition("pending_approval", "importing")).not.toThrow();
  });
});
