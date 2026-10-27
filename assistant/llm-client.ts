/**
 * The assistant's side of llm-service's `POST /chat` (stage 1 of the plan).
 *
 * Always streamed: text deltas reach the asking user as they come, and tool
 * calls arrive as deltas too (`index`, then name and argument fragments),
 * which this client assembles into whole calls. The bearer token for the
 * service is added by `lib/internal-service-auth`, imported by the service.
 */

import type { ChatMessage, ChatToolCall } from "./types";

import { llmBudgetMs } from "../lib/llm-lease";

const LLM_SERVICE_URL = (process.env.LLM_SERVICE_URL || "http://localhost:8002").replace(/\/$/, "");
/** One round may prefill a long prompt on a busy GPU; above the per-call default of the other clients. */
const TIMEOUT_MS = Number.parseInt(process.env.ASSISTANT_LLM_TIMEOUT_MS ?? "180000", 10);

/** The model is reloading, busy or gone — "try again later". */
export class LlmServiceUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmServiceUnavailableError";
  }
}

/**
 * llama-server could not read what the model wrote as the template's
 * tool-call syntax ("The model produced output that does not match the
 * expected … format", llama.cpp issue #25072, intermittent on Gemma 4). The
 * output is sampled, so the same request may well succeed once more; the
 * agent loop retries such a call once.
 */
export class MalformedReplyError extends LlmServiceUnavailableError {
  constructor(reason: string) {
    super(reason);
    this.name = "MalformedReplyError";
  }
}

const MALFORMED_REPLY = /does not match the expected .* format/i;

/** The conversation does not fit the context window (llm-service 413). */
export class ContextTooLargeError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ContextTooLargeError";
  }
}

/** A call bound to one tool: the grammar allows nothing else. */
export interface ForcedTool {
  type: "function";
  function: { name: string };
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: "auto" | "none" | "required" | ForcedTool;
  max_tokens?: number;
  temperature?: number;
  /** A grammar for a plain reply (no tools): llama-server turns the schema into GBNF. */
  response_format?: { type: "json_object"; schema: Record<string, unknown> };
  /** Let the model think first; off by default, since a reasoning block costs context every round. */
  thinking?: boolean;
}

/** The model's window and what one request took of it, as llm-service counted. */
export interface ChatUsage {
  n_ctx: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

export interface ChatReply {
  content: string | null;
  tool_calls: ChatToolCall[];
  finish_reason: string | null;
  /** Absent from a service that predates the `context` chunk. */
  usage?: ChatUsage;
}

/**
 * `signal` is the user's cancel: it closes the request, and the llm-service
 * stops llama-server once it notices the caller is gone.
 */
export type ChatFn = (req: ChatRequest, onToken?: (text: string) => void, signal?: AbortSignal) => Promise<ChatReply>;

interface ChunkDelta {
  content?: string | null;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

/**
 * Folds OpenAI chunk objects into one reply. Separate from the transport so
 * the test can feed it the chunks llama-server writes.
 */
export class ReplyAssembler {
  private content = "";
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private finish: string | null = null;
  private usage: ChatUsage | undefined;

  constructor(private readonly onToken?: (text: string) => void) {}

  push(chunk: unknown): void {
    if (!chunk || typeof chunk !== "object") return;
    const error = (chunk as { error?: { status?: number; message?: string } }).error;
    if (error) {
      const message = error.message ?? "llm-service error";
      if (error.status === 413) throw new ContextTooLargeError(message);
      if (MALFORMED_REPLY.test(message)) throw new MalformedReplyError(message);
      throw new LlmServiceUnavailableError(message);
    }
    const context = (chunk as { context?: Partial<ChatUsage> }).context;
    if (context && typeof context === "object") {
      const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      this.usage = {
        n_ctx: count(context.n_ctx),
        prompt_tokens: count(context.prompt_tokens),
        completion_tokens: count(context.completion_tokens),
      };
      return;
    }
    const choice = (chunk as { choices?: Array<{ delta?: ChunkDelta; finish_reason?: string | null }> }).choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      this.content += delta.content;
      this.onToken?.(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      const index = part.index ?? this.calls.size;
      const call = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
      this.calls.set(index, call);
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
  }

  reply(): ChatReply {
    const tool_calls: ChatToolCall[] = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({
        id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`,
        type: "function",
        function: { name: c.name, arguments: c.arguments || "{}" },
      }));
    const content = this.content.trim() ? this.content.trim() : null;
    const reply: ChatReply = { content, tool_calls, finish_reason: tool_calls.length ? "tool_calls" : this.finish };
    if (this.usage) reply.usage = this.usage;
    return reply;
  }
}

/** Splits an SSE byte stream into the JSON of its `data:` lines. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith("data:") && rest.slice(5).trim() !== "[DONE]") yield rest.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** The model's window as the last reply named it; null until one has. */
let lastWindow: number | null = null;

export function knownContextWindow(): number | null {
  return lastWindow;
}

/** One streamed /chat call. */
export const chat: ChatFn = async (req, onToken, signal) => {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const budgetMs = await llmBudgetMs(TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const stop = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", stop, { once: true });
  let resp: Response;
  try {
    resp = await fetch(`${LLM_SERVICE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ temperature: 0.2, max_tokens: 1024, ...req, stream: true }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    signal?.throwIfAborted();
    throw new LlmServiceUnavailableError(`llm-service unreachable: ${(err as Error).message}`);
  }

  try {
    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => "");
      if (resp.status === 413) throw new ContextTooLargeError(detail || "context too large");
      if (resp.status === 422) throw new Error(`llm-service rejected the conversation: ${detail.slice(0, 300)}`);
      throw new LlmServiceUnavailableError(`llm-service /chat -> HTTP ${resp.status}: ${detail.slice(0, 200)}`);
    }
    const assembler = new ReplyAssembler(onToken);
    for await (const data of sseData(resp.body)) {
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      assembler.push(chunk);
    }
    const reply = assembler.reply();
    if (reply.usage?.n_ctx) lastWindow = reply.usage.n_ctx;
    return reply;
  } catch (err) {
    signal?.throwIfAborted();
    if ((err as Error).name === "AbortError") {
      throw new LlmServiceUnavailableError(`llm-service /chat timed out after ${budgetMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
};
