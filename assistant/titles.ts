/**
 * A conversation's title from its first question (#1530). Until the model
 * has named it, the list shows the question itself, cut short; naming runs
 * after the answer, so it never delays it, and a failure keeps that fallback.
 */

import type { ChatFn } from "./llm-client";

const MAX_TITLE = 60;

/** What the list shows before the model has named the conversation. */
export function fallbackTitle(question: string): string {
  return question.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Strips what models like to wrap a title in: quotes, a label, a full stop. */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let t = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  t = t.replace(/^(titel|title)\s*:\s*/i, "");
  t = t.replace(/^["'„“‚‘»«*]+|["'“”‘’»«*.]+$/g, "").trim();
  if (!t) return null;
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1).trimEnd()}…` : t;
}

/** A short German title for a conversation that starts with `question`. */
export async function suggestTitle(chat: ChatFn, question: string): Promise<string | null> {
  const reply = await chat({
    messages: [
      {
        role: "system",
        content: "Name a chat by its first question. Reply with a German title of at most six words, nothing else — no quotes, no full stop.",
      },
      { role: "user", content: question.slice(0, 1000) },
    ],
    max_tokens: 24,
    temperature: 0.2,
  }, () => {});
  return cleanTitle(reply.content);
}
