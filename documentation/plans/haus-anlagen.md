# Home systems: maintenance handbook and optional readings (Haus › Anlagen)

Issue #1926.

A household keeps a lot of knowledge about its house that lives nowhere
else: how the filters of the ventilation unit are changed and which ones
fit, which wrench opens which tap aerator, what has to happen to the
garden pump before the first frost, where the spare seals are stored, why
the water softener's display blinks. Today this sits in a text document
or in one person's head. This plan gives it a home in the app: a reference
handbook per technical system of the house, with instructions and photos,
the spare parts and where they are stored, notes over time, the documents
that belong to it — and, where something is measured, the readings.

## Goal

For every system of the house, one page that answers:

- What is it, where is it, what model?
- How is the recurring work done (step by step, with photos and warnings)?
- Which spare parts and consumables fit, where to buy them, where they
  are stored and how many are left?
- What happened to it so far (notes: replaced, repaired, adjusted)?
- And it must be easy to fill: standing in front of the device, the user
  tells an AI assistant of their choice what to record ("water hardness
  after the softener is 5 °dH, refilled salt") and it lands in the app,
  through an MCP endpoint (see below).
- Which documents belong to it (manual, invoice, service report)?
- Where something is measured (water hardness, system pressure, a meter):
  the readings over time, recorded voluntarily.

## Non-goals

- **No tasks, due dates or reminders.** Recurring chores are scheduled
  elsewhere (a dedicated chore app, the home automation). The handbook
  only explains *how* and *with what*; a chore can link to a system page.
  If scheduling is wanted later it is a separate plan.
- No inventory of everything in the house — only technical systems and
  the parts that keep them running.
- No reminders on readings. A target range shows a value as outside, it
  does not notify.

## Relation to the meters module

Meters already model "someone reads a value at a point in time":
`meters` (metering point), `meter_devices` (physical device over time),
`meter_readings` (value, time, source, note, photo), household sharing
(`groups.household`, `visibleMetersWhere`) and permissions
(`meters.view`, `meters.read_entry`, `meters.manage`).

Two things differ for maintenance readings:

| | Meter reading (today) | Maintenance reading (new) |
|---|---|---|
| Example | electricity, water, gas, operating hours | water hardness after the softener, heating system pressure, salt level |
| Value | only grows; consumption = difference | a level that moves around a target |
| Evaluation | consumption per period, costs, anomalies | time series, target range |

Instead of a second reading mechanism, the meters module learns the
second kind:

- `meters.kind`: `counter` (default, today's behaviour) or `level`.
- A `level` meter keeps one device row for its lifetime (the device model
  stays intact; nobody swaps a hardness test kit). Readings are not
  checked for monotony, are excluded from consumption series, cost
  reports, economics and anomaly detection, and are shown as a value
  series.
- Excluding is the risky part: `meters` is read in well over 200 files,
  and every consumption path (reports, economics, anomalies, trends,
  comparisons, season profiles, degree days, quick entry, ingest, energy
  summaries, the demo and assistant tools) would silently treat a water
  hardness as consumption if it forgot the filter. So the filter is not
  repeated per query: one shared condition (`consumptionMetersWhere` next
  to `visibleMetersWhere`) that every consumption query uses, and one test
  that puts a `level` meter with readings into a household and runs every
  report and evaluation over it, expecting it to appear in none.
- `meters.type` gains `other` with a free unit (°dH, bar, %, mm) for
  values that are none of the existing types.
- Optional target range `target_min` / `target_max` on the meter; the
  chart draws the band, the list marks a reading outside it. No alert.

The system page then shows the meters that belong to it (counters and
levels alike) through a nullable `meters.home_system_id`. The meters
pages stay as they are and gain the link back to the system.

## Decisions

| Question | Decision |
|---|---|
| Where it lives | New service `home/` (Encore service `home`), module "Haus". Navigation: Haus › Anlagen, Haus › Ersatzteile; the meters stay their own module and are linked, not moved. |
| Permissions | `module.home`, `home.view` (read everything visible), `home.manage` (create and edit systems, guides, parts, notes). New role "Haus User" with all three; a one-off backfill grants it to everybody who has the meters role. Readings keep `meters.read_entry`. |
| Visibility | Same household concept as meters: owner plus `group_id`; a new system without an explicit group goes to the creator's household (`resolveSettingsScope`-style helper shared with `meter/household.service.ts`, moved to a common place rather than copied). Owner and group owner may edit; with `home.manage`, every member of the household may edit guides, parts and notes (a handbook is shared knowledge). Outside the caller's scope = `not_found`. |
| System (`home_systems`) | name, category (`heating`, `water`, `ventilation`, `sanitary`, `electrical`, `garden`, `building`, `other`), location (free text), manufacturer, model, installed_on (date only), short description (Markdown), cover photo, owner, group, archived_at. |
| Guides (`home_system_guides`) | Several per system: title, body as Markdown, sort order, updated_by/updated_at. Markdown supports headings, numbered steps, tables and a callout syntax for warnings (`> [!WARNING]`). Images are referenced by media id (`![…](media:123)`), never by file path. A plain revision table (`home_system_guide_revisions`) keeps earlier bodies so an edit can be undone. |
| Items in place (`home_system_items`) | For systems that consist of several identical units at different places (e.g. aerators at five taps): label, location, and a small key/value list (`attributes jsonb`, e.g. thread, wrench size), optional link to the matching part. Rendered as a table on the system page. |
| Media (`home_media`) | Photos for systems, guides, items, parts and notes on a volume directory (`HOME_MEDIA_DIR`, default `uploads/home`), the same way meter photos are stored (`METERS_DIR` in `meter/readings-ocr.ts`) — the app uses no Encore `Bucket` anywhere and `infra-config.json` has no object storage, so a bucket would be new infrastructure for a self-hosted stack. Served through an authenticated endpoint like other media; resized on upload, EXIF location stripped. One row per photo with caption and owner; the target is one of system/guide/item/part/note. The target has no foreign key (it is polymorphic), so deleting a system, guide, item, part or note removes its media rows and files in the same service function; a nightly sweep removes rows whose target is gone and files without a row. |
| Spare parts (`home_parts`) | A household-wide catalog: name, manufacturer, part number, EAN, specification (free text), supplier URL, storage location (free text, e.g. "utility room, parts cabinet, drawer M24"), stock (nullable = not counted), photo, notes. n:m to systems through `home_system_parts` (a seal can belong to several systems). A part with stock 0 is marked; no reorder logic. |
| Notes (`home_system_notes`) | Dated entries per system: date (date only), text, author, optional photos. The history of a system: "control valve replaced", "clamp replaced by a stainless one". Newest first. |
| Documents | `home_system_documents` (system_id, document_id, role: `manual`, `invoice`, `service_report`, `other`) links documents of the documents module, the same pattern as `finance_business_document`. Only documents visible to the caller are listed; linking needs `home.manage` and document visibility. |
| Readings | Meters with `home_system_id` appear on the system page with last value, a small chart (level: value series with target band; counter: consumption) and "Record reading", which opens the existing reading dialog. Recording is always voluntary. |
| Search | The list page searches systems, guides (title and body), items and parts; `/` focuses search as in every list. |
| Collections | Systems and parts become collection member types later (stage 5), so a handbook can be exported as PDF for a printout in the utility room. |
| MCP endpoint | Stages 6 and 7. The app exposes the handbook as a remote MCP server so an external AI client (a chat app, a phone assistant, a coding agent) can read it and write to it on the user's behalf, by voice or text. Details in the section below. |
| Assistant | Read-only tools in a new area `home`: `list_home_systems`, `home_system_detail(id)` (guides, items, parts, recent notes, linked meters with last values), `find_home_part(q)`. Write actions (add a note, record a reading, change stock) only as proposals, like every other write. This is the first way to dictate: the in-app assistant (web and iOS app) already takes spoken or typed text, and a proposal card is one tap to confirm. The MCP endpoint (stage 6) adds external AI clients on top. |
| Frontend | `PageLayout`, `ListToolbar`, `EmptyState` etc. per the frontend rules; system page is a detail page with `sticky-header`, back button and "Ablegen" once collections support the type. Markdown is rendered with the existing `components/documents/MarkdownView.vue` (a tree from `marked` tokens, never `v-html`). It shows images only as a placeholder today; it learns `media:<id>` images (loaded through the authenticated media endpoint, any other image source stays a placeholder) and the `> [!WARNING]` / `> [!NOTE]` callouts, so documents and guides keep one renderer. |
| iOS | Not in this plan. The pages are mobile-first in the web app, which is where they are used (standing in front of the device). |
| No PII | Seeds, fixtures and examples use invented systems and parts only. |

## Dictating to an AI: MCP endpoint

Typing into forms while holding a test tube or a wrench is the main reason a
handbook stays empty. The app therefore offers a **remote MCP server**
(Model Context Protocol, Streamable HTTP transport) so the user can tell any
MCP-capable AI client what to record, and the client calls the app:

> "Note on the water softener: control valve replaced today by the
> installer." → `add_system_note`
>
> "Water hardness after the softener 5 °dH, I refilled salt." →
> `record_reading` (+ the note "salt refilled")
>
> "We have two M24 aerators left in the drawer." → `update_part_stock`
>
> "How do I change the ventilation filters?" → `get_home_system` /
> `search_home` (read)

### Shape

- **Endpoint**: `POST /mcp` (raw endpoint in a new small service `mcp/`),
  Streamable HTTP, stateless; `GET /.well-known/oauth-protected-resource`
  and the authorization server metadata next to it. Reachable through the
  same public hostname as the app.
- **Who acts**: every call runs as the user who authorised the client, with
  that user's permissions and household visibility — the same service
  functions as the web app (`~encore/clients`), never SQL in the MCP layer.
- **Authorisation, in two steps.** An OAuth server with dynamic client
  registration on the public hostname is the largest attack surface of
  this plan (anybody can register a client; the login and consent page are
  all that stands in between), so it comes last and only when a client the
  user actually uses needs it:
  - **Stage 6: personal access tokens** (Profil › Verbindungen) for clients that
    take a bearer header. Tokens are stored hashed (like
    `meter_api_keys`), carry scopes, an optional expiry, `last_used_at`,
    and can be revoked one by one. This is enough for the endpoint, the
    tools, the change log and undo.
  - **Stage 7: OAuth 2.1** authorization code with PKCE and dynamic client
    registration (what hosted AI clients expect for custom connectors),
    consent page in the app listing the requested scopes, issuing the same
    kind of token as stage 6. Registered clients that never complete a consent
    expire after a day; registration is rate-limited per IP.
- **Scopes**: `home:read`, `home:write`, `meters:read`,
  `meters:read_entry`. A client asks only for what it needs; the consent
  page shows them in plain words. Without the module permission the scope
  is useless (checked on every call, not only at consent time).

### Tools (first set)

| Tool | Scope | What it does |
|---|---|---|
| `list_home_systems(q?, category?)` | `home:read` | Systems with location and linked meters. |
| `get_home_system(system)` | `home:read` | Guides (Markdown), items, parts with storage location and stock, recent notes, last readings. |
| `search_home(q)` | `home:read` | Search over systems, guides, items and parts. |
| `add_system_note(system, text, date?)` | `home:write` | Dated note; date defaults to today in the household's time zone. |
| `record_reading(meter, value, taken_at?, note?)` | `meters:read_entry` | Reading on a counter or level meter, through the same validation as the reading dialog (monotony for counters, unit). |
| `update_part_stock(part, stock \| delta)` | `home:write` | Set or change the stock of a part. |
| `add_part(name, …, systems?)` | `home:write` | New part in the catalog, optionally linked. |
| `append_to_guide(system, guide, markdown)` | `home:write` | Appends a section to a guide as a new revision (undoable); replacing a whole guide is not offered. |
| `create_home_system(name, category, location?)` | `home:write` | New system with its first empty guide. |

### Rules

- **Names, not ids.** `system`, `meter`, `part` and `guide` accept an id or
  a name. A name resolves only when exactly one visible object matches
  (case-insensitive, also on aliases like the location); several matches
  return the candidates as an error and nothing is written. The client asks
  the user, the app never guesses.
- **Values are checked, not trusted.** Units must match the meter, dates
  may not lie in the future, a counter reading below the previous one is
  refused with the previous value in the error text.
- **Every write is visible and undoable.** Writes carry `source = 'mcp'`
  and the token/client name (`meter_readings.source` gains `mcp`; notes,
  parts and guide revisions get `created_via`). The system page shows
  "via <client name>" on such entries, and Profil › Verbindungen lists the
  last writes per client with "Rückgängig". Only guides have revisions, so
  undo needs its own log: every MCP write adds a row to `mcp_changes`
  (token, tool, target kind and id, and the previous state as JSON — `null`
  for something new). Undo deletes what was created or puts the previous
  state back, and refuses if the target changed since (its `updated_at`
  is newer than the change), naming who changed it.
- **Small, predictable output.** Results are short JSON plus one human
  sentence, so a voice client can read them back ("Recorded 5 °dH for
  water softener on 15 Nov.").
- **Rate limit** per token (writes per minute) and a size limit on Markdown.
- **Not in the first set**: photos (an image argument as base64 is possible
  later), deleting anything, changing permissions or sharing.
- **Reuse.** The tool definitions are written once in `home/` and `meter/`
  as typed functions with a JSON schema; the MCP layer and the in-app
  assistant (area `home`) both read them, so both stay in step. Other
  modules can join the MCP endpoint later with their own scopes; this plan
  only covers the house.

## Data model (sketch)

```sql
ALTER TABLE meters ADD COLUMN kind TEXT NOT NULL DEFAULT 'counter'
  CHECK (kind IN ('counter', 'level'));
ALTER TABLE meters ADD COLUMN target_min NUMERIC(14,3);
ALTER TABLE meters ADD COLUMN target_max NUMERIC(14,3);
ALTER TABLE meters ADD COLUMN home_system_id INTEGER
  REFERENCES home_systems(id) ON DELETE SET NULL;
-- meters.type gains 'other'

CREATE TABLE home_systems (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  location TEXT,
  manufacturer TEXT,
  model TEXT,
  installed_on DATE,
  description TEXT,
  cover_media_id INTEGER,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE home_system_guides (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE home_system_items (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  location TEXT,
  attributes JSONB NOT NULL DEFAULT '[]',   -- [{ "key": "Thread", "value": "M24" }]
  part_id INTEGER REFERENCES home_parts(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE home_parts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  manufacturer TEXT,
  part_number TEXT,
  ean TEXT,
  specification TEXT,
  supplier_url TEXT,
  storage_location TEXT,
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  notes TEXT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE home_system_parts (
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  part_id INTEGER NOT NULL REFERENCES home_parts(id) ON DELETE CASCADE,
  PRIMARY KEY (system_id, part_id)
);

CREATE TABLE home_system_notes (
  id SERIAL PRIMARY KEY,
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  noted_on DATE NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE home_media (
  id SERIAL PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  caption TEXT,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('system', 'guide', 'item', 'part', 'note')),
  target_id INTEGER NOT NULL,
  width INTEGER, height INTEGER,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mcp_changes (               -- stage 6
  id SERIAL PRIMARY KEY,
  token_id INTEGER NOT NULL,              -- personal access token / OAuth grant
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  target_kind TEXT NOT NULL,              -- note, part, guide_revision, reading, system
  target_id INTEGER NOT NULL,
  previous JSONB,                         -- null = created by this change
  undone_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE home_system_documents (
  system_id INTEGER NOT NULL REFERENCES home_systems(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'other'
    CHECK (role IN ('manual', 'invoice', 'service_report', 'other')),
  PRIMARY KEY (system_id, document_id)
);
```

The sketch lists the meter columns first for readability; the
migrations follow the stages, so `meters.home_system_id` is added in
stage 4, after `home_systems` exists. Every new migration gets its entry
in `db/migrations/postgres/meta/_journal.json`.

## Endpoints (sketch)

```
GET    /home/systems                      list (q, category, archived)
POST   /home/systems                      create
GET    /home/systems/:id                  detail incl. guides, items, parts, notes, meters, documents
PATCH  /home/systems/:id                  edit, archive
DELETE /home/systems/:id
POST   /home/systems/:id/guides           guide CRUD (+ /guides/:guideId, /revisions)
POST   /home/systems/:id/items            item CRUD
POST   /home/systems/:id/notes            note CRUD
PUT    /home/systems/:id/parts            set linked parts
PUT    /home/systems/:id/documents        set linked documents
GET    /home/parts                        catalog (q, low stock)
POST   /home/parts                        part CRUD, PATCH stock
POST   /home/media                        upload (raw endpoint), GET /home/media/:id
```

## Stages

The order puts the part that is useful on its own first: a handbook
without readings and without MCP already answers "how, with what, where".
Readings come with the system page that shows them, and the external MCP
clients come after the in-app assistant can already take dictation.

1. **Systems core.** Service `home/`, tables `home_systems`,
   `home_system_guides` (+ revisions), `home_system_items`,
   `home_system_notes`, permissions and role, household visibility (the
   scope helper moved out of `meter/household.service.ts`), list and
   detail pages, Markdown guides with warning callouts in `MarkdownView`.
   Tests: visibility matrix as in `meter/household.service.test.ts`, guide
   revision undo.
2. **Media.** Volume directory, upload with resize and EXIF stripping,
   `media:` images in `MarkdownView`, photos on systems, items and notes,
   media removed with their target plus the nightly sweep.
3. **Spare parts.** `home_parts`, `home_system_parts`, parts page with
   search, storage location and stock, low-stock filter, link from items.
4. **Readings and links.** Level meters in the meters module (`kind`,
   `target_min/max`, type `other`; validation skips monotony for `level`;
   the shared `consumptionMetersWhere` in every consumption query and the
   test that runs every report over a level meter; the meter page draws a
   value series with the target band; the create dialog asks for the
   kind), `meters.home_system_id` with the system's readings section and
   "Record reading", `home_system_documents` with the documents section.
   Tests: a level meter accepts falling values, appears in no report or
   evaluation, marks a reading outside the band.
5. **Assistant, collections, handbook.** Area `home` with the read tools
   and the write proposals (note, reading, stock) — dictation in the app;
   collection member types for systems and parts with a PDF exporter (the
   printable handbook), the user manual chapter
   `documentation/handbuch/haus.md`, synthetic demo data for the demo
   household.
6. **MCP endpoint with access tokens.** Service `mcp/` with the
   Streamable HTTP endpoint, personal access tokens with scopes, the first
   tool set above on the shared tool definitions, `source = 'mcp'` on
   writes, `mcp_changes`, Profil › Verbindungen with tokens, recent writes
   and undo. Tests: scope checks, ambiguous names write nothing, counter
   monotony through MCP, revoked token is refused, undo of an MCP write,
   undo refused after a later edit.
7. **OAuth for hosted clients.** Only when a client in use needs it:
   OAuth 2.1 (PKCE, dynamic client registration with rate limit and
   expiry of unconsented clients, consent page) issuing the tokens of
   stage 6. Tests: PKCE mismatch refused, consent shows the scopes, a
   client without consent cannot call the endpoint.

## Open questions

- Should the "Haus" module absorb the meters navigation (Haus › Zähler)
  instead of linking to it? Decided for now: link, do not move; revisit
  after stage 4.
- MCP: one endpoint for the whole app with per-module scopes from the
  start, or a house-only endpoint first? Planned: one endpoint `/mcp`,
  only the house tools registered in stage 6.
- Storage locations as free text or as their own small table (cabinet →
  drawer)? Free text first; a table only if search by location turns out
  to be needed.
