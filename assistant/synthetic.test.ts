/**
 * The synthetic database of the assistant benchmark (stage 6, part 2 of
 * assistent-wegfindung.md): the seeder lays the dataset down for the
 * benchmark account and takes it back; the real tools read it through the
 * real service functions; a case runs through the loop with real tools; the
 * run endpoint starts a synthetic run through the internal launch with the
 * account's auth. The model is scripted; everything else is real.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { getAuthData } from "~encore/auth";
import { eq, sql } from "drizzle-orm";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);
vi.mock("./llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("./llm-client")>();
  return { ...real, chat: vi.fn() };
});
// The semantic branch of the document search would call the embedding
// service; without one the search falls back to the words, as in a sandbox.
vi.mock("../documents/llm-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("../documents/llm-client")>();
  return { ...real, embedTexts: vi.fn(async () => []) };
});

import db from "../db/database";
import { assistantBenchmarkRun, assistantBenchmarkSeed, documents, financeAccount, meters, users } from "../db/schema";
import { clients } from "./clients.test-helper";
import { chat, type ChatReply, type ChatRequest } from "./llm-client";
import { catalogFor } from "./catalog";
import { runBenchCase } from "./bench/runner";
import { CHOOSE_AREAS_NAME, isRouterRequest } from "./router";
import {
  BAUMARKT_SEPTEMBER_SUM,
  BENCH_ACCOUNT_EMAIL,
  ensureBenchAccount,
  MAHNUNG_DEADLINE,
  removeSyntheticData,
  seedSyntheticData,
  SEEDED_ACCOUNT_LABELS,
  syntheticCases,
  syntheticRowCount,
  UNSEEDED,
  verifySight,
  type SeedIds,
} from "./bench/synthetic";
import {
  __settleBenchmarkForTests,
  benchUser,
  getBenchmarkRun,
  launchSyntheticRun,
  listBenchmarkCases,
  removeSyntheticBenchmarkData,
  startBenchmarkRun,
} from "./benchmark";
import { listAccounts } from "../finance/accounts";
import { listTransactions } from "../finance/transactions";
import { transactionTotals } from "../finance/transaction-totals-api";
import { listMeters } from "../meter/meter";
import { getMeterReport } from "../meter/reports";
import {
  getDocument,
  getDocumentText,
  listCorrespondents,
  listDocumentCategories,
  listDocuments,
  listTaxDocuments,
  searchDocumentsEndpoint,
} from "../documents/documents";

type Fn = (...args: unknown[]) => unknown;

/** The service endpoints behind the tools, called for real: what `~encore/clients` does in the service. */
function wireRealServices(): void {
  const wire = (mock: { mockImplementation: (fn: Fn) => unknown }, fn: Fn) => mock.mockImplementation(fn);
  wire(clients.finance.listAccounts, () => listAccounts());
  wire(clients.finance.listTransactions, (p) => listTransactions(p as never));
  wire(clients.finance.transactionTotals, (p) => transactionTotals(p as never));
  wire(clients.meter.listMeters, (p) => listMeters((p ?? {}) as never));
  wire(clients.meter.getMeterReport, (p) => getMeterReport(p as never));
  wire(clients.documents.listDocumentCategories, () => listDocumentCategories());
  wire(clients.documents.listCorrespondents, () => listCorrespondents());
  wire(clients.documents.searchDocumentsEndpoint, (p) => searchDocumentsEndpoint(p as never));
  wire(clients.documents.listDocuments, (p) => listDocuments(p as never));
  wire(clients.documents.getDocument, (p) => getDocument(p as never));
  wire(clients.documents.getDocumentText, (p) => getDocumentText(p as never));
  wire(clients.documents.listTaxDocuments, (p) => listTaxDocuments(p as never));
}

/** The whole account as the assistant sees it: its id and every tool permission. */
function benchAuth(id: number) {
  return { userID: String(id), permissions: benchUser().permissions };
}

/** A model that routes to the three seeded areas, makes the given calls in turn, then answers. */
function scripted(calls: Array<{ tool: string; args: Record<string, unknown> }>, answer: string) {
  let next = 0;
  return vi.fn(async (req: ChatRequest): Promise<ChatReply> => {
    if (isRouterRequest(req)) {
      const args = JSON.stringify({ areas: ["finance", "documents", "meters"], needs_plan: false });
      return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: "route", type: "function", function: { name: CHOOSE_AREAS_NAME, arguments: args } }] };
    }
    if (typeof req.tool_choice === "object" && req.tool_choice.function.name === "write_plan") {
      const steps = calls.slice(next).map((x) => ({ tool: x.tool, goal: x.tool }));
      return { content: null, finish_reason: "tool_calls", tool_calls: [{ id: "plan", type: "function", function: { name: "write_plan", arguments: JSON.stringify({ steps }) } }] };
    }
    const call = calls[next];
    if (!call || req.tool_choice === "none") return { content: answer, tool_calls: [], finish_reason: "stop" };
    next++;
    return {
      content: null,
      finish_reason: "tool_calls",
      tool_calls: [{ id: `c${next}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args) } }],
    };
  });
}

let account: number;

beforeAll(async () => {
  account = await ensureBenchAccount();
});

beforeEach(async () => {
  wireRealServices();
  vi.mocked(getAuthData).mockReturnValue(benchAuth(account));
});

afterAll(async () => {
  await removeSyntheticData();
});

describe("the benchmark account", () => {
  it("exists once, cannot log in, and is found again", async () => {
    const again = await ensureBenchAccount();
    expect(again).toBe(account);
    const rows = await db.select({ email: users.email, hash: users.password_hash }).from(users).where(eq(users.id, account));
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(BENCH_ACCOUNT_EMAIL);
    expect(rows[0].hash.startsWith("$2a$10$NOLOGIN")).toBe(true);
  });
});

describe("seeding and removing", () => {
  it("lays the dataset down for the account, registers every top-level row, and takes it all back", async () => {
    const ids = await seedSyntheticData(account);
    expect(ids.owner).toBe(account);
    expect(await syntheticRowCount()).toBeGreaterThanOrEqual(2 + 2 + 7);

    // What the account sees through the services is exactly the dataset.
    const accounts = await listAccounts();
    expect(accounts.items.map((a) => a.label).sort()).toEqual([...SEEDED_ACCOUNT_LABELS].sort());
    const docs = await listDocuments({ limit: 50 } as never);
    expect(docs.total).toBe(7);
    const ms = await listMeters({});
    expect(ms.meters.map((m) => m.name).sort()).toEqual(["Strom Haus", "Wasser Haus"]);

    await removeSyntheticData();
    expect(await syntheticRowCount()).toBe(0);
    expect(await db.select({ id: documents.id }).from(documents).where(eq(documents.user_id, account))).toHaveLength(0);
    expect(await db.select({ id: meters.id }).from(meters).where(eq(meters.owner_user_id, account))).toHaveLength(0);
    expect(await db.select({ id: financeAccount.id }).from(financeAccount).where(eq(financeAccount.id, ids.accounts.giro))).toHaveLength(0);
  });

  it("seeds afresh on a second run: new ids, the same dataset, nothing doubled", async () => {
    const first = await seedSyntheticData(account);
    const second = await seedSyntheticData(account);
    expect(second.accounts.giro).not.toBe(first.accounts.giro);
    expect((await listAccounts()).items).toHaveLength(2);
    expect((await listDocuments({ limit: 50 } as never)).total).toBe(7);
  });

  it("leaves a tag the household already had, and removes only the one it created", async () => {
    await removeSyntheticData();
    await db.execute(sql`INSERT INTO finance_tag (name, source) VALUES ('Energie', 'user') ON CONFLICT DO NOTHING`);
    await seedSyntheticData(account);
    const created = await db.select().from(assistantBenchmarkSeed).where(eq(assistantBenchmarkSeed.table_name, "finance_tag"));
    expect(created.map((r) => r.row_id)).toHaveLength(1); // Versicherung; Energie existed
    await removeSyntheticData();
    const left = await db.execute<{ name: string }>(sql`SELECT name FROM finance_tag WHERE name IN ('Energie', 'Versicherung')`);
    expect(left.rows.map((r) => r.name)).toEqual(["Energie"]);
    await db.execute(sql`DELETE FROM finance_tag WHERE name = 'Energie'`);
  });
});

describe("the real tools on the synthetic data", () => {
  let ids: SeedIds;
  const tool = (name: string) => catalogFor(benchAuth(account)).find((t) => t.name === name)!;
  const ctx = () => ({ user: benchAuth(account), today: "2026-10-15" });

  beforeAll(async () => {
    wireRealServices();
    vi.mocked(getAuthData).mockReturnValue(benchAuth(account));
    ids = await seedSyntheticData(account);
  });

  it("sum the Baumarkt bookings of September through transaction_totals", async () => {
    const out = await tool("transaction_totals").run({ q: "Baumarkt", from: "2026-09-01", to: "2026-09-30" }, ctx());
    expect(out.text).toContain(BAUMARKT_SEPTEMBER_SUM.replace(",", "."));
    expect(out.rowCount).toBe(3);
  });

  it("return no rows for Musterstrom in July, with the hint to drop the period", async () => {
    const out = await tool("list_transactions").run({ q: "Musterstrom", from: "2026-07-01", to: "2026-07-31" }, ctx());
    expect(out.rowCount).toBe(0);
    expect(out.hint).toMatch(/without|ohne|period|2026-07/i);
    const loosened = await tool("list_transactions").run({ q: "Musterstrom" }, ctx());
    expect(loosened.rowCount).toBe(3);
  });

  it("report about 3,500 kWh for the electricity meter in 2025", async () => {
    const list = await tool("list_meters").run({}, ctx());
    expect(list.text).toContain("Strom Haus");
    const out = await tool("consumption_report").run({ meter_id: ids.meters.strom, from: "2025-01-01", to: "2025-12-31", granularity: "year" }, ctx());
    const total = Number(/total (\d+(?:\.\d+)?)/.exec(out.text)?.[1]);
    expect(total).toBeGreaterThan(3400);
    expect(total).toBeLessThan(3600);
  });

  it("find the heating invoice by its words, the insurer's documents by sender, the tax evidence of 2025, and the deadline in the text", async () => {
    const found = await tool("search_documents").run({ q: "Heizungswartung" }, ctx());
    expect(found.ref?.ids).toContain(ids.documents.heizung);

    const insurer = await tool("search_documents").run({ correspondent: "Muster Versicherung" }, ctx());
    expect(insurer.ref?.ids).toEqual([ids.documents.hausrat]);

    const tax = await tool("tax_documents").run({ year: 2025 }, ctx());
    expect([...(tax.ref?.ids ?? [])].sort()).toEqual([ids.documents.spende, ids.documents.lohnsteuer].sort());

    const text = await tool("get_document_text").run({ id: ids.documents.mahnung }, ctx());
    expect(text.text).toContain(MAHNUNG_DEADLINE);
  });

  it("run a case through the loop with the real tools and score it on the answer", async () => {
    const c = syntheticCases(ids).find((x) => x.id === "syn-baumarkt-sum")!;
    const model = scripted(
      [{ tool: "transaction_totals", args: { q: "Baumarkt", from: "2026-09-01", to: "2026-09-30" } }],
      `Im September 2026 hast du beim Baumarkt ${BAUMARKT_SEPTEMBER_SUM} € ausgegeben.`,
    );
    const run = await runBenchCase(c, { chat: model, tools: catalogFor(benchAuth(account)), realTools: true, user: benchAuth(account) });
    expect(run.error).toBeNull();
    expect(run.score.passed).toBe(true);
    // The real tool answered: the model saw the sum, not a fixture.
    const toolMessages = model.mock.calls.flatMap((x) => (x[0] as ChatRequest).messages.filter((m) => m.role === "tool"));
    expect(JSON.stringify(toolMessages)).toContain(BAUMARKT_SEPTEMBER_SUM.replace(",", "."));
  });

  it("every synthetic case is listable before a seeding and names only tools of the catalog", async () => {
    const names = new Set(catalogFor(benchAuth(account)).map((t) => t.name));
    for (const c of syntheticCases(UNSEEDED)) {
      expect(c.id.startsWith("syn-")).toBe(true);
      for (const e of c.expect) expect(names.has(e.tool), `${c.id} expects ${e.tool}`).toBe(true);
    }
    vi.mocked(getAuthData).mockReturnValue({ userID: String(account), permissions: ["data.manage"] });
    const listed = await listBenchmarkCases({ data: "synthetic" as never });
    expect(listed.cases.map((c) => c.id)).toEqual(syntheticCases(UNSEEDED).map((c) => c.id));
  });
});

describe("the sight check", () => {
  it("passes when the finance service lists exactly the seeded accounts, and fails on anyone else's", async () => {
    await seedSyntheticData(account);
    await expect(verifySight()).resolves.toBeUndefined();

    clients.finance.listAccounts.mockResolvedValue({ items: [{ label: "Girokonto von jemand anderem" }] });
    await expect(verifySight()).rejects.toThrow(/does not act as the benchmark account/);

    clients.finance.listAccounts.mockResolvedValue({ items: [] });
    await expect(verifySight()).rejects.toThrow(/missing/);
  });
});

describe("a synthetic run", () => {
  const ADMIN = 737;

  beforeEach(async () => {
    await db.execute(sql`INSERT INTO users (id, email, name, password_hash) VALUES (${ADMIN}, 'bench-admin@test.local', 'Bench Admin', 'x') ON CONFLICT (id) DO NOTHING`);
    await __settleBenchmarkForTests();
    await db.delete(assistantBenchmarkRun);
    vi.mocked(chat).mockReset();
    clients.user.getLlmStatus.mockReset();
    clients.user.getLlmStatus.mockResolvedValue({ live: { label: "Beispielmodell", model_filename: "beispiel.gguf", backend: "server", ctx_size: 16384 } });
    // The internal call: in the service Encore hands the given auth to the
    // launched run; here the launch runs with the auth the caller passed.
    clients.assistant.launchSyntheticRun.mockReset();
    clients.assistant.launchSyntheticRun.mockImplementation(async (req: unknown, opts: { authData: { userID: string; permissions: string[] } }) => {
      vi.mocked(getAuthData).mockReturnValue(opts.authData);
      return launchSyntheticRun(req as never);
    });
  });

  it("seeds as the benchmark account, runs the cases with the real tools, files the data source, and removes the data", async () => {
    vi.mocked(getAuthData).mockReturnValue({ userID: String(ADMIN), permissions: ["data.manage"] });
    vi.mocked(chat).mockImplementation(scripted(
      [{ tool: "list_accounts", args: {} }],
      "Du hast ein Girokonto und ein Tagesgeldkonto bei der Beispielbank.",
    ));
    const started = await startBenchmarkRun({ data: "synthetic", case_ids: ["syn-accounts"] });
    expect(started).toMatchObject({ status: "running", data_source: "synthetic", cases_total: 1 });
    expect(clients.assistant.launchSyntheticRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: started.id, case_ids: ["syn-accounts"], keep_data: false }),
      { authData: expect.objectContaining({ userID: String(account) }) },
    );
    await __settleBenchmarkForTests();

    vi.mocked(getAuthData).mockReturnValue({ userID: String(ADMIN), permissions: ["data.manage"] });
    const run = await getBenchmarkRun({ id: started.id });
    expect(run.status).toBe("done");
    expect(run.error).toBeNull();
    expect(run.data_source).toBe("synthetic");
    expect(run.results[0]).toMatchObject({ id: "syn-accounts", score: { passed: true } });
    expect(run.results[0].calls[0].tool).toBe("list_accounts");
    // The data is gone with the run.
    expect(await syntheticRowCount()).toBe(0);
  });

  it("keeps the data on request, and the admin removes it afterwards", async () => {
    vi.mocked(getAuthData).mockReturnValue({ userID: String(ADMIN), permissions: ["data.manage"] });
    vi.mocked(chat).mockImplementation(scripted([{ tool: "list_accounts", args: {} }], "Girokonto Beispielbank."));
    const started = await startBenchmarkRun({ data: "synthetic", case_ids: ["syn-accounts"], keep_data: true });
    await __settleBenchmarkForTests();

    vi.mocked(getAuthData).mockReturnValue({ userID: String(ADMIN), permissions: ["data.manage"] });
    expect((await getBenchmarkRun({ id: started.id })).status).toBe("done");
    expect(await syntheticRowCount()).toBeGreaterThan(0);
    const removed = await removeSyntheticBenchmarkData();
    expect(removed.removed).toBeGreaterThan(0);
    expect(await syntheticRowCount()).toBe(0);
  });

  it("fails the run before any case when the tools do not see the account's data", async () => {
    vi.mocked(getAuthData).mockReturnValue({ userID: String(ADMIN), permissions: ["data.manage"] });
    clients.finance.listAccounts.mockResolvedValue({ items: [{ label: "Fremdes Konto" }] });
    const started = await startBenchmarkRun({ data: "synthetic", case_ids: ["syn-accounts"] });
    await __settleBenchmarkForTests();

    vi.mocked(getAuthData).mockReturnValue({ userID: String(ADMIN), permissions: ["data.manage"] });
    const run = await getBenchmarkRun({ id: started.id });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/does not act as the benchmark account/);
    expect(run.results).toHaveLength(0);
    expect(vi.mocked(chat)).not.toHaveBeenCalled();
    expect(await syntheticRowCount()).toBe(0);
  });
});
