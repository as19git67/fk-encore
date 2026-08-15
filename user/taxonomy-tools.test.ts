/**
 * The scoreboard tool's request handling.
 *
 * The label matters more than a normal option: it becomes part of a report
 * filename on the sidecar, so it is both the thing that makes a measurement
 * findable later and the thing that must not be able to walk out of the
 * reports directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAuthData } from "~encore/auth";

import { runTool } from "./taxonomy-tools";

/** Captures what the sidecar was asked to run, and answers like an SSE start. */
function stubSidecar(status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return {
        ok: status < 400,
        status,
        headers: new Headers({ "Content-Type": "text/event-stream" }),
        // The relay reads the stream; an empty one ends the run immediately.
        body: null,
        text: async () => "",
      } as unknown as Response;
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: ["data.manage"] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runTool: tool names", () => {
  it("accepts the scoreboard", async () => {
    const calls = stubSidecar();
    await runTool({ tool: "scoreboard", label: "qwen3-14b" });
    expect(calls[0]!.url).toMatch(/\/run\/scoreboard$/);
  });

  it("still rejects an unknown tool", async () => {
    stubSidecar();
    await expect(runTool({ tool: "rm-rf" })).rejects.toThrow(/unknown tool/);
  });
});

describe("runTool: scoreboard label", () => {
  it("passes the label and the comparison target through", async () => {
    const calls = stubSidecar();
    await runTool({ tool: "scoreboard", label: "qwen3-14b", compare_with: "mistral-small" });
    expect(calls[0]!.body).toEqual({ label: "qwen3-14b", compare_with: "mistral-small" });
  });

  it("trims surrounding whitespace", async () => {
    const calls = stubSidecar();
    await runTool({ tool: "scoreboard", label: "  qwen3-14b  " });
    expect(calls[0]!.body.label).toBe("qwen3-14b");
  });

  it("requires a label", async () => {
    // Without one the measurement has no name to be found under later.
    const calls = stubSidecar();
    await expect(runTool({ tool: "scoreboard" })).rejects.toThrow(/needs a label/);
    expect(calls).toHaveLength(0);
  });

  it("treats a blank label as missing", async () => {
    stubSidecar();
    await expect(runTool({ tool: "scoreboard", label: "   " })).rejects.toThrow(/needs a label/);
  });

  it.each([
    ["a path escape", "../../etc/passwd"],
    ["a separator", "a/b"],
    ["a backslash", "a\\b"],
    ["a space", "qwen 14b"],
    ["a wildcard", "qwen*"],
    ["something too long", "x".repeat(41)],
  ])("rejects %s", async (_name, label) => {
    // These end up in a filename on the sidecar and in the glob that finds
    // snapshots again.
    const calls = stubSidecar();
    await expect(runTool({ tool: "scoreboard", label })).rejects.toThrow(/label must be/);
    expect(calls).toHaveLength(0);
  });

  it("applies the same rule to compare_with", async () => {
    const calls = stubSidecar();
    await expect(
      runTool({ tool: "scoreboard", label: "ok", compare_with: "../x" }),
    ).rejects.toThrow(/compare_with must be/);
    expect(calls).toHaveLength(0);
  });

  it("omits compare_with when it is blank", async () => {
    const calls = stubSidecar();
    await runTool({ tool: "scoreboard", label: "ok", compare_with: "  " });
    expect(calls[0]!.body).toEqual({ label: "ok" });
  });

  it("does not attach a label to the other tools", async () => {
    // The sidecar would reject it, and it would be meaningless anyway.
    const calls = stubSidecar();
    await runTool({ tool: "diagnose", label: "ignored" });
    expect(calls[0]!.body.label).toBeUndefined();
  });
});

describe("runTool: permissions", () => {
  it("refuses a caller without data.manage", async () => {
    vi.mocked(getAuthData).mockReturnValue({ userID: "1", permissions: [] });
    stubSidecar();
    await expect(runTool({ tool: "scoreboard", label: "x" })).rejects.toThrow(/data.manage/);
  });
});
