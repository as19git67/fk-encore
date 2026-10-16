import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~encore/clients", async () => (await import("./clients.test-helper")).clients);

import {
  allTools,
  catalogFor,
  catalogLines,
  describeTools,
  DESCRIBE_MAX,
  HAND_TOOLS,
  toolsFromOpenApi,
  __resetCatalogForTests,
  type OpenApiSpec,
} from "./catalog";
import type { AllowlistEntry } from "./tool-allowlist";

/** A small spec in the shape `encore gen client --lang=openapi` writes. */
const SPEC: OpenApiSpec = {
  paths: {
    "/persons": {
      get: { operationId: "GET:photo.listPersons", summary: "List all persons owned by the user.\n" },
    },
    "/persons/{id}": {
      get: {
        operationId: "GET:photo.getPersonDetails",
        summary: "Get person details with their faces.\n",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", format: "int64" } }],
      },
      delete: { operationId: "DELETE:photo.deletePerson", summary: "Delete a person.\n" },
    },
    "/widgets": {
      post: {
        operationId: "POST:widget.search",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { q: { type: "string", description: "text" }, kinds: { type: "array", items: { type: "string" } } },
                required: ["q"],
              },
            },
          },
        },
      },
    },
  },
};

const invokePersons = vi.fn();
const invokePerson = vi.fn();

const ALLOW: AllowlistEntry[] = [
  { operationId: "GET:photo.listPersons", name: "list_persons", kind: "read", permissions: ["photos.view"], columns: ["id", "name"], invoke: invokePersons },
  { operationId: "GET:photo.getPersonDetails", name: "get_person", kind: "read", permissions: ["photos.view"], invoke: invokePerson },
  { operationId: "POST:widget.search", name: "search_widgets", kind: "read", permissions: [], summary: "Widgets by text.", invoke: vi.fn() },
  { operationId: "GET:photo.gone", name: "gone", kind: "read", permissions: [], invoke: vi.fn() },
];

beforeEach(() => {
  invokePersons.mockReset();
  invokePerson.mockReset();
  __resetCatalogForTests();
});

describe("generation from the OpenAPI spec", () => {
  it("offers only allow-listed operations and reports the missing ones", () => {
    const { tools, missing } = toolsFromOpenApi(SPEC, ALLOW);
    expect(tools.map((t) => t.name)).toEqual(["list_persons", "get_person", "search_widgets"]);
    expect(missing).toEqual(["GET:photo.gone"]);
    // DELETE:photo.deletePerson is in the spec but not allowed, so never offered.
    expect(tools.some((t) => t.name.includes("delete"))).toBe(false);
  });

  it("derives the schema from path, query and body parameters", () => {
    const { tools } = toolsFromOpenApi(SPEC, ALLOW);
    const get = tools.find((t) => t.name === "get_person")!;
    expect(get.parameters).toEqual({ type: "object", properties: { id: { type: "integer" } }, required: ["id"] });
    expect(get.summary).toBe("Get person details with their faces.");
    const search = tools.find((t) => t.name === "search_widgets")!;
    expect(search.parameters.properties.kinds).toEqual({ type: "array", items: { type: "string" } });
    expect(search.parameters.required).toEqual(["q"]);
    expect(search.summary).toBe("Widgets by text.");
  });

  it("runs through the entry's service call and trims rows to the listed columns", async () => {
    invokePersons.mockResolvedValue({
      enableLocalFaces: true,
      persons: [{ id: 1, name: "Person A", user_id: 9, cover_bbox: { x: 1 } }, { id: 2, name: "Person B", user_id: 9 }],
    });
    const { tools } = toolsFromOpenApi(SPEC, ALLOW);
    const out = await tools[0].run({ ignored: 1 }, { user: { userID: "1", permissions: [] }, today: "2026-10-15" });
    expect(invokePersons).toHaveBeenCalledWith({});
    expect(out.rowCount).toBe(2);
    expect(out.text).toContain("id | name");
    expect(out.text).toContain("1 | Person A");
    expect(out.text).not.toContain("user_id");
    expect(out.block?.rows).toEqual([{ id: 1, name: "Person A" }, { id: 2, name: "Person B" }]);
  });

  it("passes only the operation's own parameters", async () => {
    invokePerson.mockResolvedValue({ id: 5, name: "Person C" });
    const { tools } = toolsFromOpenApi(SPEC, ALLOW);
    await tools.find((t) => t.name === "get_person")!.run({ id: 5, extra: "x" }, { user: { userID: "1", permissions: [] }, today: "2026-10-15" });
    expect(invokePerson).toHaveBeenCalledWith({ id: 5 });
  });

  it("the repository's spec yields the allow-listed tools beside the hand-written ones", async () => {
    const { clients } = await import("./clients.test-helper");
    clients.photo.listPersons.mockResolvedValue({ persons: [{ id: 1, name: "Person A", faceCount: 3 }] });
    const persons = allTools().find((t) => t.name === "list_persons")!;
    expect((await persons.run({}, { user: { userID: "1", permissions: [] }, today: "2026-10-15" })).text).toContain("Person A");
    const names = allTools().map((t) => t.name);
    expect(names).toContain("list_persons");
    for (const t of HAND_TOOLS) expect(names).toContain(t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("catalog per user", () => {
  const everything = ["module.assistant", "module.finance", "finance.view", "module.documents", "documents.view", "module.photos", "photos.view", "albums.manage", "module.meters", "meters.view"];

  it("a user without finance.view sees no finance tool", () => {
    const names = catalogFor({ userID: "1", permissions: everything.filter((p) => p !== "finance.view") }).map((t) => t.name);
    expect(names).not.toContain("list_transactions");
    expect(names).not.toContain("upcoming_direct_debits");
    expect(names).toContain("search_documents");
  });

  it("a user with every module sees every tool, one line each", () => {
    const tools = catalogFor({ userID: "1", permissions: everything });
    expect(tools.length).toBe(allTools().length);
    const lines = catalogLines(tools).split("\n");
    expect(lines).toHaveLength(tools.length);
    expect(lines[0]).toMatch(/^- \w+: /);
  });

  it("describe_tools returns at most five schemas and names unknown tools", () => {
    const tools = catalogFor({ userID: "1", permissions: everything });
    const names = tools.slice(0, 7).map((t) => t.name);
    const { text, described } = describeTools([...names, "drop_everything"], tools);
    expect(described).toHaveLength(DESCRIBE_MAX);
    expect(text).toContain("not in the catalog: drop_everything");
    expect(text).toContain('"type":"object"');
  });
});
