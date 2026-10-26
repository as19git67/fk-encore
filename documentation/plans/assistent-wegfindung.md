# Assistant: finding the way to an answer

Status: stage 6 (measuring) in progress; stages 1 to 5 open.
Follows `ki-assistent.md` (stages 1 to 7 implemented there).

## Problem

The assistant sometimes takes the wrong road: it picks the wrong tool of a
pair (`list_photos` instead of `search_photos`, `search_documents` instead
of `tax_documents`), gives up after a search found nothing, or answers
after an error instead of correcting the call. Why that happens follows
from how the loop works today (`assistant/agent.ts`, `runTurn`):

- There is no plan. Each of up to eight rounds is a fresh, greedy decision:
  the model sees the whole system prompt, every tool schema and the
  conversation, and chooses again. Which road is right stands only in the
  rules (about 9,100 characters) and twelve example chains.
- Every tool is offered on every round, about 47 of them. Several overlap,
  and the line between them is drawn in a description here, a rule there,
  an example elsewhere.
- Rules, examples and schemas take roughly 12,000 estimated tokens of a
  window around 18,500 on the 16 GB card, before the question arrives.
  Earlier results shrink to one-line digests quickly, and follow-up
  questions on older content lose it.
- A tool that found nothing says only "0 rows", and an error is the raw
  service message. The rules say "say so and suggest another search", so the
  model stops rather than loosening the search itself.
- The safety nets are regular expressions (`DATA_TERMS_RE`, `AMOUNT_RE`,
  consent and revision checks). They catch an answer without a tool; they
  do not notice a wrong tool.
- The benchmark (`assistant/bench/cases.ts`, 65 cases) runs through the
  real loop with canned results. It measures whether the expected tools were
  called, not how the model got there, and no real failure feeds it.

## What the large providers do

None of them lets a model choose freely from 47 tools. All shrink the
choice before the loop starts, write tool results for the model, and
measure every change against real failures.

- **Anthropic** — *Building Effective Agents*: prefer routing (a
  classification sends the input to a specialised prompt), orchestrator /
  workers and evaluator / optimiser over one autonomous loop. *Writing
  effective tools for agents*: few tools without overlap, namespaces,
  high-signal results with few tokens, error messages that say what to do
  instead, examples inside the tool description, tools built against evals
  from real tasks. *Effective context engineering*: small system prompt,
  just-in-time loading, compaction as a summary instead of truncation. The
  *Tool Search Tool* keeps deferred tools out of the prompt and loads them
  on demand; the motivation was 58 tools costing about 55,000 tokens before
  the conversation began.
- **OpenAI** — function calling: fewer than 20 functions at a time, strict
  schemas with enums, say in the prompt when each function is used and when
  not, `tool_choice` can force a call. *A practical guide to building
  agents*: start with one agent, split only when needed, then a manager
  (specialists as tools) or handoffs (a triage agent passes on with the
  context); layered guardrails; escalate to a person after repeated failure.
- **Microsoft (GitHub Copilot, VS Code)** — at most 128 tools per request;
  above that, *virtual tools* group similar ones and the model expands a
  group when it needs it. GitHub routes with embeddings of the question
  against tool descriptions and cut its default set from about 40 to 13
  core tools, because fewer tools chose better.
- **Google (Gemini, ADK)** — `function_calling_config.mode` with AUTO, ANY,
  NONE; ANY with `allowed_function_names` forces a call out of a small set.
  The Agent Development Kit builds a tree: a root `LlmAgent` reads each
  sub-agent's description and transfers to it; fixed flows run as
  `SequentialAgent`, `ParallelAgent`, `LoopAgent` without a model decision.

Sources: anthropic.com/engineering/writing-tools-for-agents,
anthropic.com/engineering/effective-context-engineering-for-ai-agents,
anthropic.com/engineering/advanced-tool-use,
code.visualstudio.com/docs/agents/run/tools,
github.blog/engineering/copilot/how-were-making-github-copilot-smarter-with-fewer-tools/,
adk.dev/agents/multi-agents. The OpenAI guide is a PDF
(cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf).

## What works locally

llama-server already has the levers; `llm-service/chat.py` passes them on
or can be made to.

| Lever | Local | In the code today |
|---|---|---|
| Limit tools per round, load the rest on demand | yes, app logic | `offered` / `describe_tools` in `agent.ts`, used only above 9,000 tokens |
| Forced call (`tool_choice` = function) | yes | `chat.py` validates `forced_tool_name`; `agent.ts` uses only `auto` / `none` |
| Structured answer by grammar (`response_format` with a JSON schema) | yes | used for `/classify` and `/vision`, not passed through for `/chat` on the server backend |
| Strict schemas, enums | yes, llama-server builds a grammar from the schema | schemas are loose, few enums |
| Thinking before the call | Gemma 4 knows `enable_thinking`; `chat.py` turns it off per round | off on purpose: a thinking block costs context every round |
| Prompt cache (an unchanged prefix is not recomputed) | yes | works only while the start of the prompt is stable |
| Embedding routing (question against area descriptions) | yes, the E5 embedder runs in the service | not used |
| A second checking call (evaluator) | yes, costs a round on the same GPU | none |

Two limits remain. Every extra model round (router, plan, checker) costs
GPU time on the 16 GB card, so a router has to be cheap: a few hundred
prompt tokens, a grammar-bound reply, or no model at all through the
embedder. And a 4 B-active model follows a hint in a tool result more
reliably than a rule 8,000 tokens above, which argues for hanging knowledge
on the tools rather than in the system prompt.

## Target architecture

A router picks the area, the area brings its own package of prompt block
and tools, the loop stays as it is, and a cheap step at the end checks the
answer against the results. This is Anthropic's routing and OpenAI's
handoff without several agents: one loop in `runTurn`, fed different
material.

- **Router.** From question, history and working set it picks one or two
  of `finance`, `depot`, `documents`, `tax`, `photos`, `meters`,
  `businesses`, `trips`, `writing` (letters, text documents, collections).
  Three stages, cheap to expensive: keywords (`DATA_TERMS_RE` exists), the
  E5 embedding of the question against area descriptions, a short model
  call bound to `{"areas": [...], "needs_plan": bool}`. A follow-up
  ("davon", "mach daraus") inherits the area of the last turn.
- **Area package** (`assistant/areas/<area>.ts`): the 5 to 12 tools of the
  area, its rule block (today the paragraphs on tax, businesses, letters and
  photos in the global `RULES`), two or three examples, and the tools every
  area needs (`describe_tools`, `switch_area`). The general rules (never
  compute, never invent, output format) shrink to about a third. The fixed
  part of the prompt comes first, so llama-server's KV cache reuses it.
- **Loop** as today, with three changes: `switch_area(area)` adds another
  package to the round (the counterpart of Tool Search and of expanding a
  virtual tool group); tools return hints on 0 rows and on errors; with
  `needs_plan`, round 1 writes a short plan as JSON that the loop carries as
  a message and ticks off.
- **Checker.** Replaces the regex nudges step by step: a grammar-bound call
  to `{"grounded": bool, "missing": string, "wrong_area": bool}` that holds
  the answer against the round's tool results. Only when something is
  missing does the answer go back once. The regex checks stay as a free
  pre-filter.

## Stages

Each stage is one PR, runs behind the benchmark, and stays only if the
pass rate does not drop and at least one path metric improves. Stage 6
starts first and runs beside the others.

| Stage | What | Files | Metric |
|---|---|---|---|
| 1 Router and area packages | areas as data (tools, rule block, examples); router in three stages; `switch_area` as a tool; global `RULES` cut to what always holds; fixed prompt part first for the KV cache | `assistant/agent.ts`, `assistant/router.ts` (new), `assistant/areas/` (new), `assistant/catalog.ts` | prompt tokens per round (target under 6,000); share of right first tool |
| 2 Tools written for the model | 0 rows: a hint what to loosen (without category, without period, sender instead of keyword) and how many rows that would bring; errors: which argument, which values; enums instead of strings (`kind`, `channel`, `rank_by`, `hidden`); merge overlapping pairs or draw the line in the description ("use X instead when …"); namespaces `finance_*`, `photos_*`, `documents_*` | `assistant/tools/*.ts`, `assistant/format.ts` | share of 0-row rounds followed by another call; share of errors followed by a corrected call of the same tool |
| 3 Plan for multi-step questions | router sets `needs_plan` on two areas or chain words; round 1 produces a 2–4 step plan by grammar, carried and ticked off; pass `response_format` through for `/chat` on the server backend; try `enable_thinking` in round 1 only with a small budget | `assistant/agent.ts`, `llm-service/chat.py` | pass rate of the multi-area cases; median rounds |
| 4 Context | history as a two-sentence summary per turn instead of an id list (written by the model at the end of the turn, grammar-bound); column selection per question in tool results; test the `q8_0` KV cache and raise `LLM_CTX` if latency allows | `assistant/agent.ts`, `assistant/assistant.ts`, llm-service config | pass rate of follow-ups on older results; `keptTurns` in `ContextUsage` |
| 5 Checker instead of regex | grammar-bound call after the answer; on `wrong_area` back to the router once; regex stays as pre-filter; after two failed attempts tell the user in words | `assistant/agent.ts`, `assistant/verify.ts` (new) | answers with invented figures or names in the benchmark; latency per answer |
| 6 Measuring (from day one) | path metrics in the benchmark (first tool, rounds, prompt tokens of round 1, nudges); collect real failures (a thumbs-down stores question, tool trace without row content, answer, and offers a case draft); a second benchmark mode against a synthetic test database | `assistant/benchmark.ts`, `assistant/bench/`, `assistant/feedback.ts` (new), `components/assistant/` | number of real failures in the benchmark; before/after per stage |

Order: 6 first, then 1 and 2 (the largest lever, independent of each
other), then 3, then 4 and 5 by measured value. After stage 2 a pause is
worth it: if the failures collected in stage 6 have mostly gone, 3 to 5 can
be smaller.

### Stage 6, part 1 (implemented)

- `CaseRun` carries `rounds`, `first_tool`, `nudges` (retracted drafts)
  and `prompt_tokens_first` (the model's count of round 1, else the
  estimate). `CaseScore.first_tool_hit` compares `first_tool` with the
  case's `firstTools` (default: any expected tool; `list_categories` before
  a search is listed where it is fine). `BenchSummary` adds
  `first_tool_hit_rate`, `nudges` and `median_prompt_tokens_first`.
- A thumbs-down (or -up) under an answer stores the question, the tool
  trace of that turn (tool, arguments, row count, error — never row
  content), the answer and an optional comment in `assistant_feedback`
  (`POST /assistant/messages/:id/feedback`). The benchmark page lists the
  feedback for `data.manage` users (`GET /assistant/feedback`) with a case
  draft in the shape of `BenchCase` to paste into `cases.ts` after
  replacing every real value with a made-up one; `DELETE
  /assistant/feedback/:id` removes an entry.

### Stage 2, first step (implemented in PR #1728)

`rank_by`, `direction`, `group_by` and `per_group` on `list_photos`,
`search_documents` and `list_transactions` ("die besten Fotos je Jahr mit
Person X"), so a ranking the user asks for is one call with enums instead
of a road the model has to find. The shared helper is
`assistant/tools/ranking.ts`; `order` on `list_photos` and `sort` on
`search_documents` are gone, both are `rank_by` plus `direction` now. PR
#1728 also adds prompt example 13 and four benchmark cases, and raises the
schema budget in `assistant/agent.ts` from 9000 to 10000 tokens (the
schemas grew by about 570 tokens). Every later stage builds on that state:
the list tools are not changed in parallel, and the rest of stage 2 takes
these parameters as given.

### Stage 6, part 2 (open)

- A benchmark mode against a synthetic test database, so that search,
  0-row hints and follow-ups are measured with real tools.
- Before each later stage the benchmark runs three times (temperature 0.2
  scatters); the means go into the table below.

## Measurements

| Date | Model | Stage | Cases | Pass rate | First tool | Median rounds | Median prompt tokens (round 1) | Nudges |
|---|---|---|---|---|---|---|---|---|
| | | baseline | | | | | | |

## Risks and what is left out on purpose

- The router errs: a question needing two areas gets one. `switch_area`
  is in every package, the checker reports `wrong_area`, and an unsure
  router names two areas. Today's state (everything visible) stays as the
  fallback when the router recognises nothing.
- More rounds, more latency: cheap stages first, model calls only with a
  grammar and a small prompt, latency measured per stage.
- Rule knowledge spreads over nine packages; in return each rule stands
  next to the tool it concerns, and a test checks every tool belongs to
  exactly one area.
- The prompt cache breaks if the area block precedes the fixed part; the
  order in the prompt is part of stage 1 and checked with the
  `prompt_tokens` timings.

Not done: several agents with their own conversations (orchestrator with
workers, an ADK tree) — on one GPU every worker multiplies latency, and
OpenAI itself advises to split only when one agent no longer suffices.
Not done: programmatic tool calling (the model writes code that calls
tools) — too risky for a small model with write rights, and the benefit
lies in fan-out questions that are rare here. Not done: an embedding per
tool as in GitHub Copilot — nine areas are hit with keywords and one
embedding per area; per-tool embeddings would move the overlap, not
resolve it.
