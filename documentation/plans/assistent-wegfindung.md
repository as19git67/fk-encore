# Assistant: finding the way to an answer

Status: stage 1 (router and area packages) implemented, stage 6
(measuring) in progress; stages 2 to 5 open.
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
| Limit tools per round, load the rest on demand | yes, app logic | the router offers the tools of the areas in play; `switch_area` and `describe_tools` add the rest (stage 1) |
| Forced call (`tool_choice` = function) | yes | `chat.py` validates `forced_tool_name`; `agent.ts` uses only `auto` / `none` |
| Structured answer by grammar (`response_format` with a JSON schema) | yes | used for `/classify` and `/vision`, not passed through for `/chat` on the server backend |
| Strict schemas, enums | yes, llama-server builds a grammar from the schema | schemas are loose, few enums |
| Thinking before the call | Gemma 4 knows `enable_thinking`; `chat.py` turns it off per round | off on purpose: a thinking block costs context every round |
| Prompt cache (an unchanged prefix is not recomputed) | yes | works only while the start of the prompt is stable |
| Embedding routing (question against area descriptions) | yes, the E5 embedder runs in the service | not used yet; the router's model stage covers the questions without a keyword |
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

### Stage 1 (implemented)

- **Areas as data** in `assistant/areas/`: nine areas (`finance`, `depot`,
  `businesses`, `documents`, `tax`, `photos`, `meters`, `trips`, `writing`),
  each with its tools, the tools it borrows from others (tax lists bookings,
  writing reads documents), its rule block, its examples and its keywords.
  Every tool of the catalog has exactly one home (`areas.test.ts`).
- **Router** in `assistant/router.ts`, three stages, each used only when the
  one before found nothing: the areas' keywords in the question (a working
  set adds its areas, a follow-up — short, or "davon", "daraus", "ja" — adds
  the areas of the previous turn's tools); the previous turn's areas for any
  question without a keyword, since a conversation usually stays on its
  subject; a model call bound to one tool,
  `choose_areas`, with the area list and the question (about 400 prompt
  tokens, `tool_choice: required`, 64 output tokens). More than three areas
  by keywords, or no decision, means every area is in play — the state
  before the router. The model stage is on in the service and the benchmark
  (`routeModel: true`) and off in unit tests. The embedding stage between
  keywords and model is still open.
- **Prompt** (`buildSystemPrompt`): the general rules first, fixed across
  turns and users for llama-server's prompt cache; then the day, the user's
  access and working set; then the rule blocks of the areas in play, the
  catalog of their tools, their examples; last the other areas by name. The
  rules on photos, tax, businesses, letters, text documents and "the user
  answers an offer" moved into their areas; the general rules kept what holds
  everywhere.
- **Loop**: round 1 offers the tools of the areas in play plus `switch_area`
  (adds an area's rules, tools and examples as a tool result) and
  `describe_tools` (now also the way to a schema of an area not in play; it
  brings the area's rules along). A tool of another area called by name runs
  and its area joins the turn. The system prompt is not rebuilt during a
  turn, so the cached prefix stays valid. `TurnResult` names the areas and
  the router stage; the benchmark records them per case (`areas`, `routing`,
  `router_ms`) and counts the stages in the summary (`routed`).
- **Static measurement** (estimated tokens, characters / 4, a user with every
  module, 48 tools): the system prompt with every area is 7,107 tokens plus
  9,705 for the schemas, 16,812 together. Over the 67 benchmark questions the
  keywords route 61; the mean of prompt plus schemas over all 67 is 5,787
  tokens, a third of before. One area alone lies between 1,970 (trips) and
  5,550 (photos). The target of the stage table, under 6,000 per round, is
  met on average; the model's own count follows in the Measurements table
  once the benchmark has run on the GPU.

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

### Stage 2 (implemented)

- **Arguments checked before the call** (`assistant/arguments.ts`): the
  loop holds every call against the tool's own schema before it runs —
  unknown arguments (with the name most likely meant: `acount_id` →
  `account_id`), missing required ones, wrong types, values outside an
  enum, dates that are a year, a month or a German date instead of a day
  (with the day to use: `from: "2025"` → `2025-01-01`). Such a call does
  not run; its result is `error: <tool> was not run: …. Call <tool> again
  with the corrected arguments.` Before, a tool swallowed what it did not
  understand (`kind: "purchase"` became "every kind") and the model read a
  true-looking answer to a question it never asked. A refused call is not
  counted as made, so the corrected one runs.
- **Empty results say what to loosen** (`assistant/tools/hints.ts`,
  `ToolOutcome.hint`): `list_transactions`, `search_documents` and
  `list_photos` run, on no rows, the same query once per filter the call
  set with that filter dropped (side by side, at most six, one service call
  each) and report the counts: `No bookings match. The same call with one
  filter dropped: without q "Flug": 412; without the period
  2026-09-01..2026-09-30: 3. Call again with the one filter dropped that
  keeps what the user asked for …`. With one filter set, dropping it is
  everything, and the hint says to tell the user instead; with none set,
  the user has none of these at all. `search_documents` also counts the
  word search (`mode: fts`) as hybrid, `list_photos` the hidden photos
  included; a narrowing of an earlier result points to the search over all
  photos. Every other tool with no rows and a filtered call gets the loop's
  general hint (`EMPTY_RESULT_HINT`). The general rules tell the model to
  act on a hint once and on an error at once, and never to repeat a call.
- **Errors tell what to do**: a failing tool's error ends with "Fix what it
  names and call again, or use another tool; do not repeat the same call."
- **Lines between overlapping tools**, in their summaries: `list_photos` ↔
  `search_photos` (metadata vs. what the image shows), `latest_readings` ↔
  `consumption_report`, `position_detail` ↔ `depot_transactions` ↔
  `portfolio_overview`/`quotes`. The enums the stage table asks for
  (`kind`, `channel`, `rank_by`, `hidden`, `mode`, `direction`) were
  already enums; the checker now enforces them.
- **Measured**: each case records `empty_results`/`empty_followed` (empty
  results the model followed with another call) and
  `tool_errors`/`errors_corrected` (errors followed by a corrected call of
  the same tool); the summary has `empty_follow_rate` and `error_fix_rate`,
  the page two tiles. Canned results may be a `$sequence` (first call,
  second call …), carry `rows: []` and a `hint`, or fail with `$error`;
  two new cases (`empty-then-loosen-period`, `empty-nothing-to-loosen`)
  check the two roads. The real probes run only against real data — the
  synthetic-database mode of stage 6 part 2 is where they get measured.
- **Left out on purpose**: namespaces (`finance_*`, `photos_*`). The areas
  of stage 1 give the model the grouping the prefixes were for, and
  renaming 48 tools would break every history digest, feedback trace and
  benchmark case for no second gain. Merging tool pairs: none overlaps
  enough; the lines in the summaries do the work.

### Stage 3 (implemented)

- **The router flags the question** (`Routing.needsPlan` in
  `assistant/router.ts`): two areas in play (not "every area", which is no
  decision), chain words in the question (`hasChainWords`: "und dann",
  "danach", "anschließend", "erst … dann", "und mach/leg/füge …", "and
  then"), or the model's own `needs_plan` on `choose_areas`.
- **One plan call before the first tool** (`assistant/agent.ts`): bound to
  the tool `write_plan` (`tool_choice` names it, so the grammar allows
  nothing else), with the tools of round 1 alongside so the steps name
  roads that exist — the step's `tool` is an enum of those names, 1 to 4
  steps, each with a goal in a few words (one step when one call answers
  a question that two areas or chain words flagged). The same mechanism as the
  router's `choose_areas`, so it runs on both llm-service backends; the
  plain `response_format` the stage table asked for now passes through
  `/chat` as well (server and inproc, only without tools) for the checker
  of stage 5. `ASSISTANT_PLAN_THINKING=1` lets the model think before the
  plan, with the plan's small budget (320 tokens) — off until the benchmark
  shows it pays.
- **The plan is a tool round of the transcript**: the model's `write_plan`
  call and a tool result with the checklist (`[ ] 1. search_documents — die
  Rechnungen …`) and the next step. The plan tool stays in every round's
  tool list, so the list — and the cached prompt prefix — is the same from
  the plan call on. After each round the loop ticks off the steps whose
  tool ran without error and appends the status to that round's last tool
  result ("Plan: 1 of 2 steps done. Next: step 2, list_transactions — …"),
  appended rather than rewritten so earlier messages stay cached. An
  answer with steps still open goes back once (`planNudge`), then stands:
  the model may skip a step whose results it already has. No usable plan
  (no step naming an offered tool) means the loop runs as before.
- **Measured**: `CaseRun.plan_asked`, `plan` (tools), `plan_done`; the
  summary has `plan_asked`, `planned`, `multi_area_pass_rate` (cases with
  two or more areas by the router) and `median_rounds_multi_area` (the
  plan call counts as a round), the page two tiles and the plan in the
  road column. Three cases: `multi-invoices-paid` (documents + finance),
  `multi-consumption-and-bill` (meters + documents),
  `chain-photos-into-album` (one area, chain words). The scripted model of
  the benchmark tests answers a plan call with the calls still to come.
- Also in this PR: the schema budget rises from 10000 to 11000 tokens —
  the photo-book tool took the full catalog (49 tools, about 10,400
  estimated tokens) past it, so a turn with every area in play went to
  `describe_tools` first; only such turns send the full catalog.

### Stage 4 (implemented)

- **A summary per turn** (`assistant/summary.ts`): after the answer has
  gone out, one model call bound to the tool `summarize_turn` writes two or
  three sentences in the user's language — what was asked (a "davon"
  resolved into words), what the tools found with the names, dates and
  figures the answer rested on and how many rows, and what the answer said
  or proposed; never ids, never tool names. It runs in the background at
  `AI_PRIORITY.background` (before batch work, after anyone waiting), so it
  never delays the answer, and lands in `assistant_message.summary` on the
  answer row (migration 0281). A turn without a tool call gets none: its
  answer is its own summary. A failed or unusable summary leaves the turn
  as it was.
- **The history replays older turns as question and summary**
  (`history()` in `assistant/assistant.ts`): the newest `WHOLE_TURNS` (3)
  turns go along as they happened — question, tool calls, results, answer —
  so a follow-up can still read the rows; every older turn with a summary
  goes as its question and the summary, with a bracketed note of the tools
  behind it and their row counts ("[summary of an earlier turn; tools then:
  list_transactions (3 rows). Follow-ups on those rows use
  from_previous_result.]"). The rows themselves stay reachable through
  `from_previous_result`, which reads the stored result sets, not the
  transcript. `fitContext` still shrinks the whole turns' results to digests
  and drops the oldest turns when the window runs short; a summarized turn
  has nothing left to shrink. The note is in the shape the loop already
  treats as a tool note: copied into an answer it is stripped
  (`cleanAnswer`) and sent back (`looksLikeFakeToolCall`).
- **Measured as** `summarizedTurns` in `ContextUsage` (the meter under the
  chat says "n ältere als Zusammenfassung") and `follow_up_pass_rate` in
  the benchmark summary: the pass rate of the cases that come with earlier
  turns. Two new cases replay a two-turns-old bookings question as a
  summary (`older-turn-tag-bookings`, `older-turn-largest-booking`): the
  first tags those rows through `from_previous_result`, the second must read
  them again with the words of the summary ("Baumarkt", September) instead
  of answering from it.
- **Left out on purpose: column selection per question.** A column list the
  model chooses costs schema tokens in every round and risks dropping the
  column the answer needs; pruning columns that are empty in every shown
  row saves a few tokens per result and would have changed the table shape
  the tools' tests pin. Neither pays for itself next to the summaries, which
  take a thousand-token result down to three sentences.
- **To test on the GPU** (not something the code can decide): `LLM_KV_TYPE=q8_0`
  (with `LLM_FLASH_ATTN=1`) halves the KV cache of Gemma 4 26B-A4B, which
  would let `LLM_CTX` rise from 30000. Run the benchmark once at each setting
  and compare `median_ms_per_round` and `p90_ms_per_round` with the pass
  rate; the Measurements table takes both rows.

### Stage 6, part 2 (open)

- A benchmark mode against a synthetic test database, so that search,
  0-row hints and follow-ups are measured with real tools.
- Before each later stage the benchmark runs three times (temperature 0.2
  scatters); the means go into the table below.

## Measurements

| Date | Model | Stage | Cases | Pass rate | First tool | Median rounds | Median prompt tokens (round 1) | Nudges |
|---|---|---|---|---|---|---|---|---|
| 2026-10-26 | Gemma-4-26B-A4B QAT UD-Q4_K_XL (CUDA, server backend, 30k ctx) | 6 + 1 (stage 2 not yet deployed) | 68 | 85 % (58) | 97 % | 3 | 5,116 | 16 |

The run of 2026-10-26 is the first with the path metrics; there is no
measured run from before the router. Router stages of that run: 62 cases by
keywords, 3 by the model, 1 inherited, 2 all areas. Of the ten failures,
four are argument misses (`position_news` with the name instead of the
key, `add_photos_to_album` with ids typed by hand instead of
`from_previous_result`, `list_photos` without `direction: "asc"` for
"fewest", `render_letter` without the figures the case expects in the body),
three are a stop after 0 rows
(`insurer-documents-by-subject`, `beach-photos`, `rule-folder-by-month`) —
the case of stage 2 —, two skip a tool (`securities-in-depot` without
`list_accounts`, `property-purchase` without `list_transactions`), one
chooses `list_photos` over `search_photos`.

## Risks and what is left out on purpose

- The router errs: a question needing two areas gets one. `switch_area`
  is in every package, the checker reports `wrong_area`, and an unsure
  router names two areas. Today's state (everything visible) stays as the
  fallback when the router recognises nothing.
- More rounds, more latency: cheap stages first, model calls only with a
  grammar and a small prompt, latency measured per stage.
- Rule knowledge spreads over nine packages; in return each rule stands
  next to the tool it concerns, and `areas.test.ts` checks every tool
  belongs to exactly one area.
- The keywords decide most questions and are German and English word
  stems; a question in other words costs the model stage, and a question
  that names an area in passing ("steuerfrei" for a PV system) gets that
  area too. Both only add tokens, never take a tool away: every area stays
  one `switch_area` away, and a tool called by name runs.
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
