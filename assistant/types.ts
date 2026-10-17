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
  | "positions"
  | "depot_transactions"
  | "quotes"
  | "news"
  | "comments"
  | "activity"
  | "businesses"
  | "business_assets"
  | "euer"
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
  /** A line under the title: the account and its balance of a booking list. */
  subtitle?: string;
}

/** The kinds of objects a later tool can take over from an earlier result. */
export type RefType = "photo" | "document" | "transaction";

/**
 * The ids an earlier result held — all of them, not just the rows shown — so
 * a follow-up ("mach daraus ein Album", "nur die aus München") works on that
 * set instead of searching again (#1530).
 */
export interface ResultRef {
  type: RefType;
  ids: number[];
}

/** What a tool hands back. */
export interface ToolOutcome {
  /** Compact text for the model: a capped table with ids and totals. */
  text: string;
  /** One line that replaces `text` once the context runs short. */
  digest: string;
  block?: ResultBlock;
  rowCount: number;
  /** The set a follow-up may refer to with `from_previous_result`. */
  ref?: ResultRef;
}

export interface ToolContext {
  user: AssistantUser;
  /** Today on the server's calendar, YYYY-MM-DD. */
  today: string;
  /** The conversation a proposal belongs to. */
  conversationId?: number;
  /** The latest result of this type in the conversation, this turn included. */
  previous?: (type: RefType) => number[] | undefined;
  /** The working set the user handed over for this conversation (#1534). */
  context?: Array<{ type: RefType; id: number }>;
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
  /**
   * A second call in the same turn is a correction of the first, not an
   * addition: its block replaces the earlier one beside the answer. True for
   * searches — a model that searches again did not like what it found — and
   * false for lists, where two calls (two accounts, two meters) are two
   * results.
   */
  refines?: boolean;
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
  /** The text streamed so far is withdrawn; a new answer follows. */
  | { type: "retract" }
  | { type: "tool_start"; tool: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; tool: string; rowCount: number; block?: ResultBlock; error?: string }
  | { type: "done"; answer: string; blocks: ResultBlock[] }
  | { type: "error"; message: string };
