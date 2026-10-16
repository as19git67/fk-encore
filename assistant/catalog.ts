/**
 * The assistant's tool catalog (documentation/plans/ki-assistent.md, stage 2).
 *
 * Two sources, one list:
 *   - hand-written tools in `tools/`, where an endpoint is the wrong shape for
 *     the model (results to trim, a list route to attach, a composite);
 *   - entries generated from the OpenAPI spec Encore emits
 *     (`encore gen client --lang=openapi`, `openapi/spec.json`), filtered
 *     through `tool-allowlist.ts`, which decides what is offered at all and
 *     how each endpoint is called.
 *
 * A user sees only the entries whose permissions they hold, so the model
 * cannot even ask for the rest; running a tool checks the permissions again,
 * and the service behind it checks them a third time.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { digestOf, table, type Cell } from "./format";
import { TOOL_ALLOWLIST, type AllowlistEntry } from "./tool-allowlist";
import { BUSINESS_TOOLS } from "./tools/business";
import { DEPOT_TOOLS } from "./tools/depot";
import { DOCUMENT_TOOLS } from "./tools/documents";
import { FINANCE_TOOLS } from "./tools/finance";
import { METER_TOOLS } from "./tools/meters";
import { PHOTO_TOOLS } from "./tools/photos";
import { TRIP_TOOLS } from "./tools/trips";
import { WRITE_TOOLS } from "./tools/writes";
import type { AssistantUser, JsonSchema, ToolSpec } from "./types";

export const HAND_TOOLS: ToolSpec[] = [
  ...FINANCE_TOOLS,
  ...DEPOT_TOOLS,
  ...BUSINESS_TOOLS,
  ...DOCUMENT_TOOLS,
  ...PHOTO_TOOLS,
  ...METER_TOOLS,
  ...TRIP_TOOLS,
  ...WRITE_TOOLS,
];

/** `describe_tools` returns at most this many schemas per call. */
export const DESCRIBE_MAX = 5;

// ── generation from the OpenAPI spec ──────────────────────────────────────

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: { content?: { "application/json"?: { schema?: Record<string, unknown> } } };
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

/** A plain schema for the model: no `$ref`s, which the model cannot follow. */
function simpleSchema(schema: Record<string, unknown> | undefined, description?: string): Record<string, unknown> {
  const type = typeof schema?.type === "string" ? schema.type : "string";
  const out: Record<string, unknown> = { type: type === "array" ? "array" : type };
  if (type === "array") {
    const items = schema?.items as Record<string, unknown> | undefined;
    out.items = { type: typeof items?.type === "string" ? items.type : "string" };
  }
  if (Array.isArray(schema?.enum)) out.enum = schema.enum;
  if (description) out.description = description.trim();
  return out;
}

function operationParameters(op: OpenApiOperation): { schema: JsonSchema; names: string[] } {
  const properties: JsonSchema["properties"] = {};
  const required: string[] = [];
  for (const p of op.parameters ?? []) {
    if (p.in !== "path" && p.in !== "query") continue;
    properties[p.name] = simpleSchema(p.schema, p.description);
    if (p.required) required.push(p.name);
  }
  const body = op.requestBody?.content?.["application/json"]?.schema;
  const bodyProps = (body?.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(bodyProps)) {
    properties[name] = simpleSchema(schema, typeof schema.description === "string" ? schema.description : undefined);
  }
  for (const name of (body?.required as string[] | undefined) ?? []) required.push(name);
  const schema: JsonSchema = { type: "object", properties };
  if (required.length) schema.required = required;
  return { schema, names: Object.keys(properties) };
}

/** The first array in a response, which is what a list endpoint returns. */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object") {
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
    return [result as Record<string, unknown>];
  }
  return [];
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v).slice(0, 80);
}

function generatedTool(entry: AllowlistEntry, op: OpenApiOperation): ToolSpec {
  const { schema, names } = operationParameters(op);
  return {
    name: entry.name,
    kind: entry.kind,
    summary: (entry.summary ?? op.summary ?? op.description ?? entry.operationId).trim().split("\n")[0],
    permissions: entry.permissions,
    parameters: schema,
    source: "openapi",
    async run(args) {
      const params: Record<string, unknown> = {};
      for (const name of names) if (args[name] !== undefined) params[name] = args[name];
      const result = await entry.invoke(params);
      const rows = rowsOf(result);
      const columns = entry.columns
        ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).filter((k) => {
          const v = rows[0]?.[k];
          return v === null || ["string", "number", "boolean"].includes(typeof v);
        }).slice(0, 8);
      const ids = rows.map((r) => r.id).filter((v): v is string | number => typeof v === "string" || typeof v === "number");
      return {
        text: table(columns, rows.map((r) => columns.map((c) => toCell(r[c])))),
        digest: digestOf(entry.name, rows.length, ids),
        rowCount: rows.length,
        block: { kind: "table", tool: entry.name, rows: rows.slice(0, 60).map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))) },
      };
    },
  };
}

/**
 * Tools for the allow-listed operations of a spec. An allow-listed operation
 * the spec does not contain is skipped and reported, so a renamed endpoint
 * shows up in the log instead of silently vanishing from the catalog.
 */
export function toolsFromOpenApi(
  spec: OpenApiSpec,
  allowlist: AllowlistEntry[] = TOOL_ALLOWLIST,
): { tools: ToolSpec[]; missing: string[] } {
  const byId = new Map<string, OpenApiOperation>();
  for (const ops of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(ops)) {
      if (op?.operationId) byId.set(op.operationId, op);
    }
  }
  const tools: ToolSpec[] = [];
  const missing: string[] = [];
  for (const entry of allowlist) {
    const op = byId.get(entry.operationId);
    if (op) tools.push(generatedTool(entry, op));
    else missing.push(entry.operationId);
  }
  return { tools, missing };
}

function loadSpec(): OpenApiSpec | null {
  const candidates = [
    process.env.ASSISTANT_OPENAPI_SPEC,
    join(process.cwd(), "openapi", "spec.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "openapi", "spec.json"),
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as OpenApiSpec;
    } catch {
      // try the next location
    }
  }
  return null;
}

let cached: ToolSpec[] | null = null;

/** Every tool the assistant knows, built once per process. */
export function allTools(): ToolSpec[] {
  if (cached) return cached;
  const spec = loadSpec();
  const generated = spec ? toolsFromOpenApi(spec) : { tools: [], missing: TOOL_ALLOWLIST.map((e) => e.operationId) };
  if (generated.missing.length) {
    console.warn(`[assistant] allow-listed operations not in the OpenAPI spec: ${generated.missing.join(", ")}`);
  }
  const names = new Set(HAND_TOOLS.map((t) => t.name));
  cached = [...HAND_TOOLS, ...generated.tools.filter((t) => !names.has(t.name))];
  return cached;
}

/** Reset for tests. */
export function __resetCatalogForTests(): void {
  cached = null;
}

// ── per user ──────────────────────────────────────────────────────────────

export function mayUse(tool: ToolSpec, user: AssistantUser): boolean {
  return tool.permissions.every((p) => user.permissions.includes(p));
}

/** The tools this user may see. */
export function catalogFor(user: AssistantUser, tools: ToolSpec[] = allTools()): ToolSpec[] {
  return tools.filter((t) => mayUse(t, user));
}

/** The catalog as the system prompt lists it: one line per tool. */
export function catalogLines(tools: ToolSpec[]): string {
  return tools.map((t) => `- ${t.name}${t.kind === "write" ? " (proposal)" : ""}: ${t.summary}`).join("\n");
}

/** A tool definition in the shape llm-service's /chat takes. */
export function toolDefinition(tool: Pick<ToolSpec, "name" | "summary" | "parameters">) {
  return {
    type: "function" as const,
    function: { name: tool.name, description: tool.summary, parameters: tool.parameters },
  };
}

export const DESCRIBE_TOOLS_NAME = "describe_tools";

/** The meta-tool that hands the model full schemas on demand. */
export const describeToolsDefinition = toolDefinition({
  name: DESCRIBE_TOOLS_NAME,
  summary: `Full argument schemas of up to ${DESCRIBE_MAX} tools from the catalog, so they can be called next.`,
  parameters: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" }, description: "tool names from the catalog" } },
    required: ["names"],
  },
});

/** What `describe_tools` answers, and which tools become callable. */
export function describeTools(
  names: unknown,
  tools: ToolSpec[],
): { text: string; described: ToolSpec[] } {
  const wanted = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
  const described = wanted
    .map((n) => tools.find((t) => t.name === n))
    .filter((t): t is ToolSpec => !!t)
    .slice(0, DESCRIBE_MAX);
  const unknown = wanted.filter((n) => !tools.some((t) => t.name === n));
  const parts = described.map((t) => `${t.name}: ${t.summary}\nparameters: ${JSON.stringify(t.parameters)}`);
  if (unknown.length) parts.push(`not in the catalog: ${unknown.join(", ")}`);
  if (wanted.length > DESCRIBE_MAX) parts.push(`only the first ${DESCRIBE_MAX} are described per call`);
  return { text: parts.join("\n\n") || "no tool names given", described };
}

/** Rough size of a tool definition in tokens (4 characters each). */
export function estimateTokens(value: unknown): number {
  return Math.ceil((typeof value === "string" ? value : JSON.stringify(value)).length / 4);
}
