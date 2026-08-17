/**
 * The scoreboard tool's request handling.
 *
 * The label matters more than a normal option: it becomes part of a report
 * filename on the sidecar, so it is both the thing that makes a measurement
 * findable later and the thing that must not be able to walk out of the
 * reports directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getAuthData } from "~encore/auth";
import { documents as documentsClient, realtime, user } from "~encore/clients";

import db from "../db/database";
import { documents as documentsTable } from "../db/schema";
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

describe("runTool: scoreboard reclassify_reference", () => {
  const USER_ID = 990920;
  const DOC_IDS = [990921, 990922];

  /** Answers the reference-doc-ids lookup (GET) and the scoreboard run (POST)
   * differently, since reclassify_reference talks to the sidecar twice. */
  function stubSidecarWithReference(docIds: number[]) {
    const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/scoreboard/reference-doc-ids")) {
          calls.push({ url, method });
          return {
            ok: true,
            status: 200,
            json: async () => ({ source: "2026-08-16-cloud_audit_full.json", doc_ids: docIds }),
          } as unknown as Response;
        }
        calls.push({ url, method, body: JSON.parse(String(init?.body ?? "{}")) });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "text/event-stream" }),
          body: null,
          text: async () => "",
        } as unknown as Response;
      }),
    );
    return calls;
  }

  async function seedDocuments(status: "ready" | "classifying" = "ready"): Promise<void> {
    await db.execute(
      sql`INSERT INTO users (id, email, name, password_hash)
          VALUES (${USER_ID}, ${`u${USER_ID}@test.local`}, ${`User${USER_ID}`}, 'x')
          ON CONFLICT (id) DO NOTHING`,
    );
    for (const id of DOC_IDS) {
      await db
        .insert(documentsTable)
        .values({
          id,
          user_id: USER_ID,
          sha256: `sha-${id}`,
          original_filename: `doc-${id}.pdf`,
          mime_type: "application/pdf",
          size_bytes: 1024,
          disk_path: `/tmp/doc-${id}.pdf`,
          status,
        })
        .onConflictDoUpdate({ target: documentsTable.id, set: { status } });
    }
  }

  beforeEach(() => {
    // publishToolEvent() no-ops when there is nobody to tell — give it a
    // recipient so the progress/error lines this flow relies on actually go out.
    vi.mocked(user.listUserIdsWithPermission).mockResolvedValue({ userIds: ["1"] });
  });

  afterEach(async () => {
    await db.delete(documentsTable).where(eq(documentsTable.user_id, USER_ID));
    vi.mocked(documentsClient.batchReclassify).mockReset().mockResolvedValue({ affected_documents: 0 });
    vi.mocked(realtime.publishEvent).mockClear();
    vi.mocked(user.listUserIdsWithPermission).mockResolvedValue({ userIds: [] });
  });

  it("reclassifies the reference set, waits for it, then measures", async () => {
    await seedDocuments("ready"); // already terminal — the poll loop exits on its first check
    vi.mocked(documentsClient.batchReclassify).mockResolvedValue({ affected_documents: 2 });
    const calls = stubSidecarWithReference(DOC_IDS);

    const result = await runTool({ tool: "scoreboard", label: "candidate", reclassify_reference: true });
    expect(result).toEqual({ status: "started" });

    // The scoreboard run itself happens in the background, after reclassify.
    await vi.waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/run/scoreboard"))).toBe(true);
    });

    expect(documentsClient.batchReclassify).toHaveBeenCalledWith({ document_ids: DOC_IDS });
    const scoreboardCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/run/scoreboard"));
    expect(scoreboardCall?.body).toEqual({ label: "candidate" });
  });

  it("returns immediately without waiting for reclassify to finish", async () => {
    await seedDocuments("ready");
    let releaseReclassify: (() => void) | undefined;
    vi.mocked(documentsClient.batchReclassify).mockReturnValue(
      new Promise((resolve) => {
        releaseReclassify = () => resolve({ affected_documents: 2 });
      }),
    );
    stubSidecarWithReference(DOC_IDS);

    const result = await runTool({ tool: "scoreboard", label: "candidate", reclassify_reference: true });
    expect(result).toEqual({ status: "started" }); // resolved before batchReclassify's promise did

    releaseReclassify?.();
  });

  it("reports the reference set as empty instead of measuring against nothing", async () => {
    const calls = stubSidecarWithReference([]);

    await runTool({ tool: "scoreboard", label: "candidate", reclassify_reference: true });

    await vi.waitFor(() => {
      expect(vi.mocked(realtime.publishEvent).mock.calls.some(([arg]) =>
        String((arg as { payload?: { message?: string } }).payload?.message).includes("empty"),
      )).toBe(true);
    });
    expect(calls.some((c) => c.url.endsWith("/run/scoreboard"))).toBe(false);
  });

  it("does not reclassify anything when the option is left off", async () => {
    const calls = stubSidecar();
    await runTool({ tool: "scoreboard", label: "candidate" });
    expect(documentsClient.batchReclassify).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes("/scoreboard/reference-doc-ids"))).toBe(false);
  });
});
