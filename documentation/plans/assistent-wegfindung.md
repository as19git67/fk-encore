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

### Stage 5 (implemented)

- **One check after the answer**, `assistant/verify.ts`. An answer about
  the user's data — a tool ran this turn, or the question names what the
  services keep — goes once more to the model, bound to the tool
  `check_answer` (`grounded`, `missing`, `wrong_area`), with its own short
  prompt: the question, the tool results of this turn with the call behind
  each (meta tools left out, a result cut at 6,000 characters), the answer,
  and the areas with their tools and which were used. No history, no
  system prompt of the loop: a few hundred tokens, and the same bound-call
  mechanism as `choose_areas`, `write_plan` and `summarize_turn`, so it
  runs on both llm-service backends. The check is not a round of the loop;
  its time is measured apart (`check_ms`).
- **The regex checks stay as the free pre-filter.** An answer reaches the
  checker only after it passed them (`nudge === null`), so the checker
  pays only for what no regex can see: a figure or a name the results do
  not hold, "nothing found" over a result with rows, a question answered
  from the wrong area's tools.
- **What the verdict does.** Not grounded: the draft and the checker's
  sentence go back to the model once (`ungroundedNudge`), like the other
  nudges — not kept in the transcript, withdrawn from the stream — and the
  next answer is checked again. `wrong_area` naming an area not in play: the
  area joins the turn (its package as the nudge, its tools offered), once
  per turn; a second detour is not taken. After `MAX_FAILED_CHECKS` (2)
  failed checks the answer goes out with a note in the user's words
  (`unverifiedNote`: „Hinweis: Diese Angabe konnte ich nicht in den
  gelesenen Daten belegen: …“) instead of a third attempt. A verdict the
  loop cannot read, a check that fails to run, the forced last round and an
  answer that names a missing permission leave the answer as it is.
- **Switch.** `ask` and the benchmark run with the checker unless
  `ASSISTANT_VERIFY=0`; `runTurn` itself has it off (`verify`), so a
  scripted test sees only the rounds it scripted. The test suite sets `0`
  and switches it on in the tests that cover the checker.
- **Measured.** `checks`, `check_failed`, `check_ms` and `unverified` per
  case, `checks`, `check_failed`, `unverified` and `median_check_ms` in
  the summary, the tile „Prüfer-Einwände“ on the benchmark page; the
  benchmark's pass rate says whether an objection made an answer right, the
  latency per answer is `median_check_ms` on top of the rounds. Both go
  into the table below after the next GPU run.

### Stage 6, part 2 (implemented)

- A second data source for the benchmark: `synthetic`, next to the canned
  results. The KI-Benchmark page offers both as a radio; `POST
  /assistant/benchmark/runs` takes `data: "synthetic"` and `keep_data`,
  `GET /assistant/benchmark/cases?data=synthetic` lists the cases of that
  source, `DELETE /assistant/benchmark/synthetic-data` removes what a run
  left behind. The run is stored with its `data_source`.
- Finding (2026-10-26): the tools call the services through
  `~encore/clients`, and Encore hands the caller's auth along, so a
  benchmark run's real tools act as whoever started the run — never as a
  stand-in user. The answer is a dedicated benchmark account
  (`assistant-benchmark@system.local`, `ensureBenchAccount` in
  `assistant/bench/synthetic.ts`) that owns every seeded row. The admin
  who presses start only prepares the run; the start handler then calls
  the internal endpoint `launchSyntheticRun` (not exposed) with the
  benchmark account as `authData` of the call, and that endpoint seeds,
  runs and cleans up as that account. Because the hand-over cannot be
  exercised without the Encore runtime, every synthetic run begins with a
  sight check (`verifySight`): `finance.listAccounts` as the running user
  must list exactly the seeded account labels, nothing else. If it does
  not, the run fails before the first case, with the reason in the error,
  and the seeded data is removed. The first real run on the GPU is what
  confirms the hand-over.
- The seed (`seedSyntheticData`): two accounts at a made-up bank, eleven
  bookings over August to October 2026 (three hardware-store purchases in
  September summing to 185,89 €, an electricity debit in every month but
  July, two salaries, an insurance premium, a donation marked tax
  relevant), two meters with readings since January 2025, and seven
  documents with extracted text, status `ready`, correspondent, category
  and tax sections — so search, text and tax tools find them without any
  queue. Photos are left out because of the file pipeline. Every top-level
  row is registered in `assistant_benchmark_seed`; children go with their
  parent, bookings are deleted explicitly, and shared tags are only
  removed when the seed created them.
- Ten cases of their own (`syn-*`, built by `syntheticCases(ids)`) whose
  expectations name content — the account labels, the sum, the month
  without a debit, the consumption of 2025, the deadline of the reminder
  letter — never ids the sequences assign. They run with `realTools` in
  `assistant/bench/runner.ts`: the tools run as they do for a user, the
  canned fixtures are not consulted.
- Tested without the model: `assistant/synthetic.test.ts` wires the
  mocked clients to the real service functions and plays a scripted model
  through router, plan and tools, so seeding, removal, the 0-row hint on
  the empty month, the text search and the sight check are checked
  end-to-end against the test database.
- Open from this part: the three-run rule before each later stage, and
  the first synthetic run itself (the measurement row below).
- Before each later stage the benchmark runs three times (temperature 0.2
  scatters); the means go into the table below.

## Measurements

| Date | Model | Stage | Cases | Pass rate | First tool | Median rounds | Median prompt tokens (round 1) | Nudges |
|---|---|---|---|---|---|---|---|---|
| 2026-10-26 | Gemma-4-26B-A4B QAT UD-Q4_K_XL (CUDA, server backend, 30k ctx) | 6 + 1 (stage 2 not yet deployed) | 68 | 85 % (58) | 97 % | 3 | 5,116 | 16 |
| 2026-10-26 (evening) | same | 1–5 | 75 | 88 % (66); on the 68 cases of the morning run 90 % (61) | 96 % | 3 | 5,250 | 21 |
| 2026-10-27 | same | 1–5 with the bound-call fix | 75 | 81 % (61); 88 % of the 69 cases llama-server's parser did not lose | 97 % | 3 | 4,231 | 18 |
| 2026-10-27 (afternoon) | same | 1–5 with one plain retry of an unreadable reply | 75 | 83 % (62); 90 % of the 69 cases the grammar did not lose | 96 % | 3 | 4,340 | 25 |
| 2026-10-27 (evening) | same, llama.cpp v0.7.0 | 1–5 with the grammar-free retry | 75 | 91 % (68) | 93 % | 3 | 4,225 | 23 |
| 2026-10-28 | same | 1–5 with the seven fixes below | 75 | 95 % (71) | 95 % | 3 | 4,355 | 21 |
| 2026-10-28 (noon) | same | 1–5 with the order, the guard and the proposal rule | 75 | 91 % (68); 95 % (71) on the expectations of the morning run | 93 % | 3 | 4,402 | 21 |
| 2026-10-28 (afternoon) | same | 1–5 with the schema rule, the yes nudge and the letter note | 75 | 100 % (75) | 96 % | 3 | 4,402 | 23 |
| 2026-10-29 (evening) | same, on the CPU twin (GPU lent, `gpu_layers` 0) | 1–5 unchanged, canned results | 75 | 95 % (71); two cases lost to the request limit, two to borderline decisions | 95 % | 3 | 4,402 | 25 |
| 2026-10-30 | same (CUDA) | stage 6 part 2: synthetic data, real tools | 10 | 100 % (10) | 90 % | 3 | 4,463 | 2 |

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

The evening run of 2026-10-26 (stages 1 to 5 on `main`, seven new cases)
against the morning run: on the 68 shared cases 58 → 61 passed. Fixed:
`insurer-documents-by-subject` and `beach-photos` (the 0-row stops stage 2
aimed at), `best-photo-per-year-into-album`, `letter-paid-invoices`.
Broken: `letter-from-bookings` (the plan was written and followed, then
the model declined to write the letter without the landlord's address).
Of the seven new cases five pass; `empty-then-loosen-period` loosened the
text instead of the period, `multi-invoices-paid` made no data call at
all. Follow-ups on summarised turns: 100 % (stage 4). Checker (stage 5):
72 checks, 4 objections, one answer out with the note, median 1,280 ms per
check on top of the rounds; `best-photos-in-country` ("312 photos, found
one") was a right objection, the two on `trips-last-year` ("nothing found"
over an empty result) were not. Two defects the run exposed, fixed after
it: the plan call came back as a plan in 2 of 19 cases — llama-server
reads `tool_choice` as a string and ran a bound function as "auto", so the
model called a real tool and the loop threw that reply away (now
llm-service sends a bound call as that one tool with `required`, and the
loop runs a tool call from the plan reply as round 1; the benchmark
records `plan_reply`); and an empty first reply went back as an assistant
message without content, which llm-service refuses
(`rule-folder-by-month` failed on it; now `EMPTY_REPLY_NUDGE` without the
draft). The checker, the summary and the router's model stage were bound
calls too and worked by prompt and a one-tool list alone; the fix binds
them by grammar as intended.

The run of 2026-10-27 (the bound-call fix deployed) answers the question
the evening run left open: the plan call came back as a plan in 13 of 13
cases (2 of 19 before), every plan was carried out (`plan_done` =
steps), and the three cases the evening run had lost on the plan or the
empty reply pass (`rule-folder-by-month`, `letter-from-bookings`,
`multi-invoices-paid`); multi-area pass rate 86 % (82 % before). The
headline pass rate still fell, 66 → 61, because six cases ended in round 1
with llama-server's "The model produced output that does not match the
expected peg-gemma4 format" — its Gemma 4 parser could not read what the
model wrote, before any tool ran (`expenses-by-tag`, `pv-tax-exempt`,
`shared-albums-participants`, `followup-photos-album`,
`redact-price-bundle`, `keep-answer-as-text-document`, all green the
evening before, four of them on tools whose arguments carry long text).
That looked like llama.cpp issue #25072, intermittent and independent of
this plan, so the loop sent such a request once more before giving up
(`MalformedReplyError` in `llm-client.ts`, `malformed_replies` per case
and in the summary). The afternoon run of the same day showed otherwise
(see below). Of the 69 cases that ran, 61 passed (88 %). Newly failed: `insurer-documents-by-subject`
(answered "nothing found" without a call) and `letter-paid-invoices` (the
body without the figures the case expects). Checker: 67 checks, 2
objections (`photos-with-description`, "84 photos, found one", was right;
`trips-last-year`, "nothing found" over an empty result, was not), no
answer out with the note, median 1,566 ms. Follow-ups 67 %, all three
misses the parser errors above.

The afternoon run of 2026-10-27 (the plain retry deployed) settles what
the parser errors are. Six cases failed on the same message again, each
after the retry (`nudges` 1, `rounds` 0), five of them the same cases as
in the morning; and the six are exactly the six plan calls that did not
come back: 19 cases ask for a plan, 13 planned, 6 died in the plan call.
Every other round of the run read. The plan call is the one request a
round makes with a grammar (`tool_choice: "required"`, the bound-call fix
of the morning); the evening run before that fix, with the same prompts
and no grammar, lost none of them. That is llama.cpp issue #29089 (fix
#29115, in builds from 2026-09-19) together with #30256: the grammar
llama-server builds from Gemma 4's template leaves the tail of a required
call unconstrained, the model wanders into a thought channel or past the
call, and the PEG parser rejects what it wrote — deterministically for a
given prompt at temperature 0.2, so a plain retry cannot help. The loop
now sends a bound call that failed this way once more as the one tool
without the grammar (`tool_choice: "auto"`, `unbound` in `agent.ts`): the
model then calls it by prompt, the way the checker, the summary and the
router worked before the grammar. The plan call is the only bound call
on the loop's own path; the checker and the router catch their errors and
go without. The count of repeated replies now survives a second failure
(`repeated` on the error, read by the benchmark). The deployed
build was `b10438` (2026-08-14), before the fix; `Dockerfile.gpu` now pins
llama.cpp v0.7.0 (2026-10-15), which carries #29115 and should make the
retry idle — `malformed_replies` says whether it is. Apart from the plan calls: 62 of 69 passed (90 %), the morning's
`insurer-documents-by-subject` passes again, `securities-in-depot` lost
`list_accounts` again, `letter-reply-reads-text` wrote the letter without
the figures. Checker: 66 checks, 3 objections (`trips-last-year`,
`best-photos-in-country`, `photos-with-description` — the last two right),
median 1,265 ms.

The evening run of 2026-10-27 (llama-server built from llama.cpp v0.7.0,
the grammar-free retry deployed) closes the matter: no parser error, 19
of 19 plan calls came back as a plan, `malformed_replies` 0 — the
grammar of a required call holds on this build, so the retry never ran.
68 of 75 (91 %), the best run so far; the six plan cases of the morning
pass, and `letter-paid-invoices` with them; multi-area pass rate 94 %,
follow-ups on summarised turns 100 % (9 of 9). Lost against the
afternoon: `insurer-documents-by-subject` ("nothing found" without a
call, the same miss as in the morning run — the one case that comes and
goes between runs). The other six failures are the known ones:
`fewest-comments-per-year` (no `direction: "asc"`), `empty-then-loosen-period`
(the text loosened instead of the period), `quote-of-security`
(`position_news` with the name instead of the key), `securities-in-depot`
(no `list_accounts`), `property-purchase` (no `list_transactions`),
`letter-reply-reads-text` (the body without the figures). Checker: 72
checks, 2 objections (`best-photos-in-country` and `photos-with-description`,
both right), no answer out with the note, median 1,158 ms.

### The last seven cases

The seven failures of the evening run fell the same way in the three
runs before it (`insurer-documents-by-subject` in two of them), so each
got a fix where its cause lies — in the tool, the loop or the area's
data, never in `GENERAL_RULES`:

- `empty-then-loosen-period`: the hint listed the counts and left the
  choice to the model, which dropped the text (212 rows) instead of the
  month (1 row). `loosenHint` now names the filter to drop — the one
  whose absence brings the fewest rows, the narrowest guess — and says
  that dropping the others brings rows the user did not ask for. A probe
  that is a widening the model must not take on its own (hidden photos
  counted in) carries `recommend: false` and is listed but never named.
- `insurer-documents-by-subject`: the loop had asked once more after an
  empty first round, and the words that came back ("ich konnte keine
  Dokumente finden") went out without a call, because the data-question
  nudge waits while another nudge is pending. After the empty-reply nudge
  the next draft is a first draft like any other, so the checks apply.
- `quote-of-security`: `position_news` and `position_detail` resolve a
  name to the key of the one position it matches (open or sold out), and
  name the candidates when several match; the rule of the depot area says
  the key comes from the rows of `quotes` or `portfolio_overview`, with an
  example. The case passes with the name as well.
- `securities-in-depot`: `portfolio_overview(q = "Beispielbank")` named
  no security, so it narrows to the depot whose label matches, and says
  so in the note; the depot rule names `list_accounts` plus `account_ids`
  as the other road, with an example. The case takes either
  (`anyOf` in `ExpectedCall`).
- `fewest-comments-per-year`: an example of "die wenigsten" with
  `direction = "asc"` in the call, and why — `rank_by` alone orders from
  the most, so the first row of each group is the one with the most.
- `property-purchase`: an example in the documents area of "alles zum
  Kauf …" as documents plus bookings, with `switch_area("finance")` when
  the finance area is not in play.
- `letter-reply-reads-text`: an example in the writing area of a reply
  that names the invoice number and the deadline from the text, with the
  rule that every fact the user asks to have named stands in the body,
  even one the model would leave out.

Whether that is 100 % is the next run's to say; the prompt grew by the
examples and one rule in two areas, which `prompt_tokens_first` shows.

The run of 2026-10-28 answered: 71 of 75 (95 %), the median prompt 130
tokens larger. The three fixes in a tool or the loop held every time —
`quote-of-security` (the model even sent the key), `securities-in-depot`
(by the depot's name in `q`), `property-purchase` (`list_transactions`
after the search) and `insurer-documents-by-subject` all pass. The three
fixes that were an example or a rule alone did not move the model at all:
`fewest-comments-per-year` still without `direction`, `empty-then-loosen-period`
still dropping the sender although the hint now named the month in so
many words, `letter-reply-reads-text` still without the deadline — and
this time the answer claimed the letter named it. `rule-folder-by-month`
fell for the first time: the model listed the bookings first, the
benchmark had no rows for that tool, and "no data" became "no bookings".
The lesson is the plan's own: a rule the model reads is a hope, a check
the loop runs is a guarantee.

Two of the four are therefore held by the loop now, and the run exposed
a bug on the way:

- `list_transactions` had `direction` twice since the ranking stage
  (#1728): the money filter (`out`/`in`) and the order (`desc`/`asc`)
  spread into the same schema key, the order won, and the argument check
  of stage 2 refused every `direction: "out"` — the run shows it as
  `tool_errors` on `largest-booking-per-month` and `expenses-by-tag`, each
  "corrected" by dropping the expense filter. The order of
  `list_transactions` is `order` now; `direction` stays money in or out
  there and the order everywhere else.
- `rank_by` without its order is refused by the tool, with both values
  in the error: the model never set `asc` on its own in six runs, and a
  default of `desc` answers "die wenigsten" with the most.
- An empty result's advice is structured (`loosen` on the outcome:
  which arguments to drop, which to keep) and the loop holds the tool's
  next call to it (`loosenGuard`): a call that drops a filter the advice
  said to keep while the one to drop stays is refused with the advice
  repeated. A widening the model must not take on its own (hidden
  photos) is never the advice; a change of mode is listed, not guarded.
- The checker reads a write tool's call as the proposal it is: when the
  answer says the letter names something, it has to stand in the call's
  arguments, or the answer goes back once. That is still the model
  checking the model, but with the one rule it lacked.
- `rule-folder-by-month` carries rows for `list_transactions`, so the
  detour is not a dead end, and the finance area says a Mappe is
  `create_transaction_folder`, never `transaction_report`.

### What the run at noon showed

The run of 2026-10-28 at noon answered 68 of 75 (91 %) — three fewer,
and the three are the measurement's own doing. The `direction` fix held:
`largest-booking-per-month` and `expenses-by-tag` sent `direction: "out"`
with `order: "desc"` and were not refused; `loosenGuard` held
`empty-then-loosen-period` to the month (`tool_errors` 1, then the right
call); `rule-folder-by-month` and `fewest-comments-per-year` pass. But
four cases sent `rank_by` without its order, as every run before, and
were not refused: `parseRanking` sits inside the tool, and the benchmark
never runs a tool — its `run` is canned (`cannedTools` in
`bench/runner.ts`). So the refusal holds in production and not in the
measurement, while the expectations the same PR tightened to demand the
order hold in the measurement only. `best-photos-in-country`,
`best-photo-per-year-into-album`, `largest-document-per-sender` and
`older-turn-largest-booking` passed in the morning with the same calls
and fell at noon on the stricter expectation. The rule now sits where
both see it: the schemas carry `dependentRequired: { rank_by: [order] }`
and `checkArguments` enforces it in the loop before any tool runs, with
the order's values and their meaning in the error; `parseRanking` stays
as the tool's own guard. The model never sees the keyword
(`modelSchema` strips it from the definition): llama-server's grammar
builder knows the draft-7 keywords only, and the property's description
already says "required with rank_by".

The other three:

- `tag-bookings-after-yes` — "Ja." to the previous answer's "Soll ich
  … hinzufügen? Bitte bestätige die Änderung." got "Da ich nicht weiß,
  worauf sich dein Ja bezieht …" in one round, without a tool. The
  general rules say what to do with a yes, and the morning run did it; a
  rule is a hope. The loop now knows a bare go-ahead (`isBareYes`: "Ja.",
  "ok", "ja, bitte", "mach das") and the question the previous answer
  left open (`openQuestion`: a question mark at the end, or a request
  for consent in words); a words-only reply to that goes back once with
  the question quoted and the instruction to take the step it asked
  about (`yesNudge`). A message that is more than a yes ("Ja, aber nur
  die erste") is not touched.
- `letter-reply-reads-text` — the same failure as in every run: the
  letter names the invoice number, not the deadline; the answer claims
  both; the checker, which now has the rule for it, still said grounded.
  Two model judgements in a row missed the same fact, so the tool now
  states it: `render_letter` reads the texts the turn read
  (`get_document_text`, `find_text_in_document`, through
  `ToolContext.turnResults`) and lists in the proposal's note the dates,
  amounts and reference numbers they name and the letter does not
  (`factsLeftOut`), with the instruction to call again with the one the
  user asked for before answering. It is a hint with the fact in it, not
  a guard — a guard would have to know which fact the user wanted — and
  whether a named fact moves the model where a rule did not is this
  run's question; the fixture's hint is the real function over the
  canned text, so the benchmark measures the same note production gets.
- `property-purchase` — the model went by the property's category from
  `list_categories` instead of a search word, which is a right road the
  expectation did not know: `anyOf` with the category present.

Two things the run confirms once more: `plan_asked` 19 of 19 planned,
`malformed_replies` 0, so the llama.cpp v0.7.0 build holds; and
`check_failed` 1 on `largest-document-per-sender`, where the checker sent
back an answer that lacked nothing the results did not hold — a false
alarm that cost a round and did no harm.

### What the run in the afternoon showed

The run of 2026-10-28 in the afternoon answered 75 of 75 (100 %), the
first full pass, and each of the four changes did what it was built for:

- The schema rule refused `rank_by` without its order before any tool
  ran, and the model took the correction in one extra round:
  `best-photos-in-country`, `best-photo-per-year-into-album` and
  `largest-document-per-sender` show `tool_errors` 1 and then the right
  call, `older-turn-largest-booking` resent with `order: "desc"`. The
  refusal costs a round; the model does not yet send the order on its
  own, and the description "required with rank_by" alone does not move
  it. That is the one place left where a deterministic check pays for a
  rule the prompt does not deliver.
- `tag-bookings-after-yes` passed with two nudges: the words-only reply
  to "Ja." went back with the question quoted, and the second attempt
  called `tag_transactions` with `from_previous_result`.
- `letter-reply-reads-text` passed for the first time: the body names the
  reference number, the invoice date and the deadline. The note from
  `factsLeftOut` brought the model back once (one nudge), and the second
  letter carried the fact — a named fact moved the model where the rule
  in the prompt and the checker's rule did not.
- `property-purchase` passed over the category road the expectation now
  accepts.

`largest-booking-per-month` took seven rounds and still passed; it is the
longest path in the set and the one to watch when the loop changes. The
checker sent back `best-photos-in-country` and `photos-with-description`
once each (`check_failed` 2), both false alarms that cost a round and
changed nothing in the answer; `unverified` stays 0. Plan 19 of 19 and
`malformed_replies` 0 confirm the v0.7.0 build again; `first_tool` 96 %,
median 3 rounds, 4,402 prompt tokens in round 1, 23 nudges in all.

What the pass rate does not say: 75 cases with canned results measure the
way to the tool and the words of the answer, not the data. That is what
the synthetic data source (stage 6, part 2) measures; its first run is
below. The open stage is the router's embedding step. A new failure from
daily use becomes a case only after every real value is replaced.

### What the CPU twin showed (2026-10-29)

The same 75 cases with the canned results on the CPU twin (GPU lent, the
model's own CPU configuration, 30k context) answered 71 of 75 (95 %) in
2 h 24 min; the GPU run of the day before took 26 min. The weights are the
same, so the four misses are not the model getting worse:

- Two cases went to the clock. `thanks-no-tool` ended with `terminated`:
  the llm-service closed the stream before a reply came. On the CPU,
  reading an uncached prompt (4,000–7,000 tokens after an area switch)
  takes 70–150 s, the 19,000-token follow-up 210 s; the case came right
  behind a 90-second round and ran into the request limit of the
  configuration. The next case, `balance-without-finance`, got a 503
  `inference busy` at once, because llama-server was still finishing the
  aborted request (the slot is waited for 10 s). On the GPU the same
  rounds take 1–4 s. A benchmark on the CPU twin needs a higher
  `request_timeout_s` on the CPU configuration, otherwise one or two of 75
  cases are lost to the limit every time.
- Two cases are borderline decisions that fell the other way:
  `groceries-last-month` took `list_transactions` instead of
  `transaction_totals` (and, with no canned rows for that tool, answered
  "no bookings"); `letter-paid-invoices` put the `[[…]]` gap into the
  recipient instead of the body and wrote "the payments should arrive
  shortly" where the body wanted a gap. At temperature 0.2 these are close
  calls; CPU and GPU kernels round differently, the probabilities shift a
  little, and a close call flips.

Everything else is level with the GPU run: 25 nudges against 23, the
checker wrong three times against two, plan 19 of 19 in both. What differs
is the speed: median 8 s per round against 1.3 s, p90 91 s against 3.9 s,
the checker 17 s against 1.1 s. Of the 75 first rounds, 30 took longer than
a minute — all of them after an area switch, where llama-server's prompt
cache does not help; the cases that reuse the previous case's system prompt
start in 2–4 s.

### What the first synthetic run showed (2026-10-30)

The ten `syn-*` cases against the seeded database with the real tools
answered 10 of 10 on the GPU in 70 s. The sight check passed, so the
hand-over to the benchmark account works: `finance.listAccounts` as the
running user listed exactly the two seeded accounts. The tools returned the
seeded facts — 185,89 € for the hardware store in September over three
rows, 3,500 kWh for 2025 from the meter readings, the 30.10.2026 deadline
from the reminder's text, the 0-row hint on the empty July naming the
search term as the filter to drop (the model offered to drop it instead of
answering "no bookings"). Two things to watch: `syn-mahnung-deadline` took
eight rounds, because the model tried `find_text_in_document` three times
with other words ("Fälligkeit", "bis", "Zahlungsfrist") before reading the
whole text with `get_document_text` — a candidate for a rule in the
documents area once it shows up in daily use; and the checker flagged
`syn-tax-2025` once wrongly (the case passed). The remaining open stage is
the router's embedding step.

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
