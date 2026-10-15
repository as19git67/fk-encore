/**
 * Shapes shared by the assistant's catalog, tools and agent loop
 * (documentation/plans/ki-assistent.md, stage 2).
 */

/** The asking user, as the auth handler resolved them. */
export interface AssistantUser {
  userID: string;
  permissions: string[];
}

/** A JSON schema object for a tool's arguments, as the model receives it. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Kinds of typed result rows the client renders beside an answer. */
export type BlockKind =
  | "accounts"
  | "transactions"
  | "analysis"
  | "debits"
  | "categories"
  | "documents"
  | "document"
  | "photos"
  | "recaps"
  | "albums"
  | "meters"
  | "readings"
  | "consumption"
  | "trip_plans"
  | "proposal"
  | "table";

/**
 * Rows the model saw, for the client. `route` is a list page that shows the
 * same set with the same filters ("In der Liste öffnen").
 */
export interface ResultBlock {
  kind: BlockKind;
  tool: string;
  rows: Record<string, unknown>[];
  /** How many exist, when more than `rows` holds. */
  total?: number;
  route?: string;
}

/** What a tool hands back. */
export interface ToolOutcome {
  /** Compact text for the model: a capped table with ids and totals. */
  text: string;
  /** One line that replaces `text` once the context runs short. */
  digest: string;
  block?: ResultBlock;
  rowCount: number;
}

export interface ToolContext {
  user: AssistantUser;
  /** Today on the server's calendar, YYYY-MM-DD. */
  today: string;
  /** The conversation a proposal belongs to. */
  conversationId?: number;
}

export type ToolKind = "read" | "write";

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  /** One sentence for the catalog line, written for the model. */
  summary: string;
  /** Every one of these is needed to see or run the tool. */
  permissions: string[];
  parameters: JsonSchema;
  /** Where the entry came from: written by hand or generated from the spec. */
  source: "hand" | "openapi";
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** One message in the OpenAI shape llm-service's /chat takes. */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** What the agent reports while it works, in order. */
export type TurnEvent =
  | { type: "token"; text: string }
  | { type: "tool_start"; tool: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; tool: string; rowCount: number; block?: ResultBlock; error?: string }
  | { type: "done"; answer: string; blocks: ResultBlock[] }
  | { type: "error"; message: string };
