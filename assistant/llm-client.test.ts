import { describe, it, expect } from "vitest";
import { ContextTooLargeError, LlmServiceUnavailableError, MalformedReplyError, ReplyAssembler, sseData } from "./llm-client";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Split mid-line to exercise the buffering.
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17));
      controller.close();
    },
  });
}

describe("sseData", () => {
  it("yields the data lines until [DONE]", async () => {
    const out: string[] = [];
    for await (const d of sseData(streamOf('data: {"a":1}\n\n: comment\ndata: {"b":2}\n\ndata: [DONE]\n\ndata: {"c":3}\n'))) out.push(d);
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("ReplyAssembler", () => {
  it("joins text deltas and reports each token", () => {
    const tokens: string[] = [];
    const a = new ReplyAssembler((t) => tokens.push(t));
    a.push({ choices: [{ delta: { role: "assistant", content: "Hal" } }] });
    a.push({ choices: [{ delta: { content: "lo." } }] });
    a.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
    expect(a.reply()).toEqual({ content: "Hallo.", tool_calls: [], finish_reason: "stop" });
    expect(tokens).toEqual(["Hal", "lo."]);
  });

  it("assembles tool calls from llama-server's deltas", () => {
    const a = new ReplyAssembler();
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "list_photos", arguments: "" } }] } }] });
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"favorite":' } }] } }] });
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "true}" } }] } }] });
    a.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "list_albums", arguments: "{}" } }] } }] });
    a.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    const reply = a.reply();
    expect(reply.finish_reason).toBe("tool_calls");
    expect(reply.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "list_photos", arguments: '{"favorite":true}' } },
      { id: "c2", type: "function", function: { name: "list_albums", arguments: "{}" } },
    ]);
  });

  it("turns the inproc single chunk into the same reply", () => {
    const a = new ReplyAssembler();
    a.push({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "x", type: "function", function: { name: "list_meters", arguments: "{}" } }] }, finish_reason: null }] });
    a.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    expect(a.reply().tool_calls[0].function.name).toBe("list_meters");
  });

  it("takes the window and token counts from the closing context chunk", () => {
    const a = new ReplyAssembler();
    a.push({ choices: [{ delta: { content: "Ja." }, finish_reason: "stop" }] });
    a.push({ context: { n_ctx: 30000, prompt_tokens: 1200, completion_tokens: 8 } });
    expect(a.reply().usage).toEqual({ n_ctx: 30000, prompt_tokens: 1200, completion_tokens: 8 });
  });

  it("maps error events", () => {
    expect(() => new ReplyAssembler().push({ error: { status: 413, message: "too long" } })).toThrow(ContextTooLargeError);
    expect(() => new ReplyAssembler().push({ error: { status: 502, message: "boom" } })).toThrow(LlmServiceUnavailableError);
  });

  it("tells a reply llama-server could not parse apart from the other failures (llama.cpp issue #25072)", () => {
    const unread = "The model produced output that does not match the expected peg-gemma4 format";
    expect(() => new ReplyAssembler().push({ error: { status: 502, message: unread } })).toThrow(MalformedReplyError);
    // Still an LlmServiceUnavailableError for everyone who does not retry.
    expect(() => new ReplyAssembler().push({ error: { status: 502, message: unread } })).toThrow(LlmServiceUnavailableError);
  });
});
