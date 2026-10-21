-- How full the model's context window got in an assistant turn: the real
-- token count from llm-service, the window, and how many earlier questions
-- the model still saw (assistant/types.ts ContextUsage). Set on the answer
-- row only; NULL for every other row and for answers from before.
ALTER TABLE "assistant_message" ADD COLUMN IF NOT EXISTS "context_usage" jsonb;
