# Dev system with a copy of the production data

## Goal

Next to production, run a dev system that holds a recent copy of the
production data, so a change is seen on real data before it reaches
production. And never deploy an app image to production whose migrations
have not first run on such a copy.

The trigger was PR #1919: migrations 0313 and 0314 carried journal
timestamps older than 0312, so every database that had already applied
0312 skipped both silently, while the fresh test databases of CI ran
them. CI cannot see that kind of fault, because it never starts from a
database that has history. A copy of production does.

## Where we start

- **Four compose stacks are possible on one host**, all from the same
  `docker-compose.yml` with `DEPLOY_*` variables (DEPLOYMENT.md,
  "Multiple deployments on one host"): prod (`:latest`, scope `fkprod`),
  test (`:test`, built from every PR push, scope `fktest`, ports
  18080/15432/9001), and the demo (`:latest`, synthetic data,
  `docker-compose.demo.yml`, shares prod's llm-service).
  `docker-compose-dev.yml` is an older hand-written mirror of the test
  stack.
- **Deploy is a Watchtower call.** `docker-image.yml` builds on every push
  to `main`, tags `latest` and calls `WATCHTOWER_URL_PROD`; a PR build tags
  `test` and calls `WATCHTOWER_URL_TEST`. The eight service image
  workflows deploy prod the same way. Prod is updated a few minutes after
  every merge.
- **Migrations run at app boot** (`db/database.ts`, Drizzle `migrate()`),
  then the seed, then the backup housekeeping.
- **The nightly backup** (`scripts/host/fk-encore-backup.sh`) puts the
  cluster into backup mode, writes a `pg_dump` of the main DB into the
  backup volume and takes a recursive ZFS snapshot `daily-<label>` of the
  prod dataset. Photos, documents, pgdata and that dump are in one
  consistent snapshot. Old snapshots are pruned (14 days daily by default).
- **A restore at boot** (`restore-*.dump` in the backup dir) runs *after*
  the migrations, so it is not usable for testing migrations.

## Decisions

- **The dev system replaces the test stack.** Same slot (name suffix
  `-test`, ports, watchtower scope `fktest`), PR images `:test` keep
  landing there after every push — so a PR is tried on real data. Only its
  data changes: instead of whatever it holds today, it gets the copy of
  production.
- **The technical names stay "test".** Suffix `-test`, project
  `fk-encore-test`, scope `fktest`, image tag `:test`, secret
  `WATCHTOWER_URL_TEST`, env file `.env.test`, overlay
  `docker-compose.test.yml`, host scripts `test-refresh.sh` and
  `test-scrub.sql`: the host, the workflows and the secrets stay as they
  are, and only the data and the overlay are new. "Dev system" in this plan
  means this stack. Only the app's own mode is called `APP_ENVIRONMENT=dev`
  (with `DEV_OUTBOUND_<KIND>`), because `NODE_ENV=test` already means the
  test runner and the app checks for it.
  A fifth stack would cost CPU and RAM for embedding and face
  detection again, and there is nothing a separate empty test stack shows
  that the dev stack does not. The demo stays as it is.
  `docker-compose-dev.yml` is removed (with its two validation jobs in
  `compose-validate.yml` and `.gitlab-ci.yml`); the dev stack is built
  like the demo, as an overlay.
- **The copy is a ZFS clone of the newest nightly snapshot**, not a
  `pg_dump` plus a copy of the files. A clone takes seconds, costs no space
  until either side changes, holds DB and files from the same moment, and
  is writable: dev can delete photos, move inbox files or rewrite
  thumbnails without touching prod. Postgres starts on the cloned pgdata
  like after a power cut (the snapshot is atomic) and replays its WAL.
  This includes the embeddings DB, which the nightly dump does not.
- **Refreshed weekly and on demand**, by a host script, never by the app.
  Weekly keeps the clone's origin snapshot younger than the 14 days the
  backup keeps a daily snapshot, so pruning never meets a snapshot that a
  clone still pins. The prune also skips a snapshot that has clones and
  says so in the log, in case the refresh did not run.
- **The data never leaves the host.** Not into git, not into CI, not into
  an artifact or a log. CI only ever learns "passed" or "failed" plus
  counts (see the upgrade check). The dev stack is reachable only on the
  LAN or VPN, never through the public reverse proxy. Fixtures and
  benchmark cases are still written by hand with invented values
  (CLAUDE.md, "Keine personenbezogenen Daten").
- **Dev is defused twice: in the data and in the code.** The data step
  (scrub SQL after each refresh) removes what points outward from the
  copy. The code step (`APP_ENVIRONMENT=dev`) puts every outbound path
  under a switch whose default in dev is not to reach a real person or a
  real account, so a job or a table added next month is covered without
  anyone remembering the scrub. Either one alone would be enough on the
  day it was written; only both stay enough.
- **Defused does not mean dead.** The point of dev is to try a change on
  real data, and most of the app never leaves the host: photos, documents
  and their classification, finance views and reports, the assistant, trip
  planning, collections and exports as files all work as in prod. Each
  outbound path has its own mode `off | redirect | on`, set per kind in
  `.env.test`, so one path can be tested without opening the others (see the
  table below). Mail is redirected by default, so every mail dev would
  send can be read without reaching anyone.
- **FinTS stays off for now.** With a copy that is at most a week old, the
  bookings in dev are recent enough to test everything that reads them.
  A bank sync from dev can be switched on later (`on`): it then needs the
  login entered again in dev, because the scrub removes the copied ones.
  That works — the old test stack has run with the same logins for a few
  banks without trouble — but every booking it fetches lands only in the
  copy and is gone at the next refresh.
- **No keys of prod.** Dev gets none of prod's SMTP login, VAPID or APNs
  key, SerpApi key, EODHD token, CUPS server or Anthropic key, and its own
  `FINANCE_CREDENTIALS_KEY`, so the copied FinTS credentials cannot be
  decrypted even if the scrub missed one. A path switched to `on` gets a
  key of its own (its own VAPID pair, the APNs sandbox, a SerpApi key with
  a small quota), never prod's.
- **Dev shares prod's llm-service**, like the demo: a second Gemma 4 does
  not fit on the 16 GB card. Interactive calls are fine; the background
  `llm` queue and the nightly aesthetic run (which lends prod's GPU) stay
  off in dev, so the copied backlog of pending classifications does not
  load the GPU that prod needs.
- **The upgrade check is separate from the dev stack.** The dev stack runs
  whatever PR was pushed last and has applied its migrations to its own
  copy; it is no clean baseline for the image that goes to prod. The check
  restores the newest nightly dump into a scratch database, runs the
  candidate image's migrations on it, compares the result and reports.
  One container, started by Watchtower, nothing to log into.
- **Prod takes only app images that passed the check.** Not tagged
  releases: a merge is expected on prod shortly after, and
  a manual release step would only add a click. The merge stays the
  release; the check sits between build and deploy and blocks on failure.
  The eight service images have no schema and keep deploying directly.

## The dev stack

### Compose

`docker-compose.test.yml`, layered by `COMPOSE_FILE` in `.env.test`
(template: the existing `docker-compose.env.test.example`, extended):

```
COMPOSE_FILE=docker-compose.yml:docker-compose.volumes.yml:docker-compose.test.yml
```

What the overlay changes:

- `app`: `APP_ENVIRONMENT: dev`, `LLM_SERVICE_URL` to prod's llm-service
  over prod's network (as in `docker-compose.demo.yml`), no dependency on
  its own llm-service, and no `documents_inbox` from prod (the clone's
  inbox is its own).
- `llm_service` and `aesthetic_service` under a profile nobody activates.
- `mail_catcher`: a local SMTP catcher with a web page (Mailpit), the
  target of `mail` in `redirect` mode, reachable like the app only on the
  LAN or VPN.
- `upgrade_check`: the check container (see below), `restart: "no"`.
- `watchtower`: `WATCHTOWER_INCLUDE_STOPPED` and `WATCHTOWER_REVIVE_STOPPED`
  so it also replaces and starts the stopped check container, which is
  added to its container list.

`.env.test` sets the identity of the old test stack (suffix `-test`, ports,
scope), `DEPLOY_DATA_ROOT` to the data directory inside the clone, and the
database names of prod (`encore`, `embeddings`), because the cloned
cluster carries prod's names. `INTERNAL_SERVICE_SECRET` is prod's, since
the app calls prod's llm-service; it is the one value test shares with
prod. Its own `RP_ID`/`RP_ORIGIN`: passkeys from
prod do not work in dev, login is by password. Extra photo libraries
outside the prod dataset are mounted read-only in dev's
`docker-compose.volumes.yml`.

### Refresh: `scripts/host/test-refresh.sh`

Shipped in the image and copied to `backup/host-scripts/` like the backup
hook, so the host needs no checkout. Called from prod's copy of that
folder (the refresh destroys test's own) with the path to the test env
file, from a weekly TrueNAS cron job (a few hours after the nightly backup) or by
hand. It reads `PROD_DATASET` and `TEST_DATASET` from the env file and
refuses to run when `TEST_DATASET` equals `PROD_DATASET`, lies inside it,
does not contain "test", when `DEPLOY_DATA_ROOT` is not inside the clone,
or when the env file lacks `APP_ENVIRONMENT=dev`. `--dry-run` prints every
step, `--snapshot <label>` picks another snapshot.

`TEST_DATASET` is a child dataset of its own under the test stack's
directory (e.g. `…/f4mil_test/prod-copy`). Prod keeps its compose files
and `.env` at the top of its dataset, so a clone in place of the test
stack's directory would replace test's env file with prod's; one level
down, the clone holds only data and test's compose files stay where they
are.

1. `docker compose --env-file .env.test down`.
2. Find the newest `daily-*` snapshot of `PROD_DATASET`.
3. `zfs destroy -r TEST_DATASET` (only if every dataset in it has a
   snapshot of `PROD_DATASET` as `origin` — a dataset that is not a clone
   is never destroyed).
4. `zfs clone` the snapshot to `TEST_DATASET`, and each child dataset to
   the matching child (a clone is not recursive).
5. Remove prod's `.env*` files at the top of the clone, and in the
   clone's backup directory every `*.dump` (including a `restore-*.dump`)
   and `host-scripts/backup-token`.
6. Start only `postgres` and `geo-db`, set their passwords to the ones in
   the test env file (`ALTER USER` over the local socket, which needs
   none), check that the database `DEPLOY_PG_DATABASE` exists, and run the
   scrub (`scripts/host/test-scrub.sql`).
7. Write the snapshot label into `$DEPLOY_DATA_ROOT/.test-copy` and a copy
   into the backup volume (`$DEPLOY_DATA_ROOT/backup/.test-copy`), the one
   directory of the data root the app mounts; `GET /environment` reads it
   for the banner. A file rather than a `dev_copy` row: the scrub runs on
   the copy's schema before the app migrates it, and a row would need a
   table prod does not use.
8. `docker compose --env-file .env.test up -d`. The app migrates the copy
   to its own image on boot.

### Scrub: `scripts/host/test-scrub.sql`

Runs in one transaction; a table that does not exist yet is skipped, a
missing column fails loudly so the file is fixed rather than half applied.

- Push: delete `push_subscriptions`, `guest_push_subscriptions`,
  `apns_device_tokens`.
- Sessions: delete `sessions`, `refresh_tokens`, `guest_sessions`,
  `auth_handover_tokens`, `password_reset_tokens`.
- Banks: in `finance_bankcontact` set `credentials_encrypted`,
  `banking_information` to `NULL` and `sync_times` to `[]` — the
  `banking_information` holds the bank-assigned system id, which must not
  appear from a second client.
- Travel: `paused = true` on `travel_hotel_watch` and
  `travel_flight_watch`.
- Exports and links: `enabled = false` on `collection_schedules`; delete
  `album_public_links` and `collection_public_links`.
- Photos: `enabled = false` in `photo_aesthetic_settings`.
- Jobs: `enabled = false` in `scheduled_job_state` for every job named in
  `OUTBOUND_JOBS` (see below).

### What the app does with `APP_ENVIRONMENT=dev`

One module `lib/environment.ts` with `isDev()` and
`outbound(kind)` (and `assertOutbound(kind)`, which throws when the kind is
off), called at the lowest layer of each path; the "is it configured?"
check of each path answers false while it is off, so callers that skip an
unconfigured path skip it too. It returns the
mode of that kind: `off` throws a clear error instead of sending,
`redirect` sends to the dev target named in the table, `on` sends as in
prod (with dev's own key). In prod every kind is `on` and the module does
nothing. The mode is read from `DEV_OUTBOUND_<KIND>` in `.env.test`; the
defaults:

| Kind | Where | Default in dev | `redirect` means |
|---|---|---|---|
| `mail` | `user/mail.ts` (password reset, exports, price alerts, guest digest) | `redirect` | every mail goes to a local mail catcher (e.g. Mailpit in the dev stack), whatever the recipient |
| `push` | `push/push.ts`, `push/apns-client.ts` | `off` | — (`on` with dev's own VAPID pair and the APNs sandbox reaches only devices that signed in to dev; the copied tokens are deleted) |
| `fints` | the FinTS client in `finance/` (sync, TAN probe) | `off` | — (`on` after entering a login in dev) |
| `serpapi` | the hotel and flight clients in `travel/` | `off` | — (`on` with dev's own key; the daily jobs stay off, a check runs by hand) |
| `eodhd` | EODHD client in `finance/` | `off` | — (quotes from Onvista and news from Yahoo need no token and stay on) |
| `print` | the CUPS client | `off` | the label written as a PNG into the backup volume of the copy (`dev-print/`) instead of paper; the printer list shows one printer "dev-datei" |
| `llm` | background work on prod's llm-service: the document workers that need the model (classify, tax values, the vision reads of text extraction), tag suggestions, and the jobs below marked `llm` | `off` | — (a user's own request, such as the assistant or a critique, always runs) |

Jobs: `OUTBOUND_JOBS` in `lib/environment.ts` names each job that acts
outward with its kinds. In dev `lib/local-cron.ts` holds such a job paused
on every boot while one of its kinds is `off`, whatever the copied state
says; the admin page shows it as "aus (Dev)" and it can be switched on by
hand until the next restart (the guard at the path still holds). The
scrub switches off the same names, and a test keeps the two lists equal.
Today that is `finance-sync-statements` (fints), `travel-hotel-watches`
and `travel-flight-watches` (serpapi), `collections-schedules` and
`guest-digest` (mail), `documents-follow-ups-process-due` and
`trip-planner-live-activities` (push), and `photo-aesthetic-nightly`,
`trip-planner-curation`, `trip-planner-spot-descriptions`,
`trip-planner-spot-summaries`, `documents-collection-summaries` and
`finance-depot-model-retry` (llm). The OSM jobs, the petrol prices (the
EU's weekly bulletin) and the news refresh (Yahoo without a key; EODHD is
guarded at its client) stay on: they only download public data.

The background workers that need the model (`classify` and `tax_values`
of the document pipeline, the finance tag worker) leave their jobs queued
while `llm` is off, and text extraction gets no vision read; a user's own
request still runs.

Every page shows a thin bar "Dev · Kopie vom <Datum>" above the
navigation (from `dev_copy`), and `document.title` starts with "Dev ·",
so a dev tab is never mistaken for prod.

## The upgrade check

### What it does

The app image gets a second entry point,
`node /opt/fk-encore/upgrade-check/upgrade-check.mjs`
(`scripts/upgrade-check/`), which runs without the HTTP server. It is plain
JavaScript so it needs no build, and it loads the image's own `pg`,
Drizzle migrator and `db/migrations/postgres` from the image's working
directory, the ones the boot uses:

1. Restore the newest `encore-daily-*.dump` from prod's backup directory
   (mounted read-only into the check container) into a scratch database
   `encore_upgrade_check` on the dev postgres, dropped and recreated each
   time.
2. Run the image's migrations on it with Drizzle's `migrate()`, exactly as
   the boot does. The seed (`db/seed.ts`) is TypeScript inside the app
   bundle and is not run: it only inserts roles and permissions with
   `ON CONFLICT`, and a fault there shows at the dev stack's next boot.
3. Run the same migrations on an empty database `encore_upgrade_fresh`.
4. Compare: every journal entry applied on the copy (a row in
   `drizzle.__drizzle_migrations` with its `when` or its file hash), and
   both schemas equal object by object — schemas, extensions (by name;
   prod keeps an old extension version until someone updates it), tables,
   columns with type, null and default, constraints, indexes, enums, views,
   functions and triggers, read from the catalog rather than from a text
   dump, so column order and dump formatting cannot raise a false alarm. A
   skipped migration, as in #1919, shows twice: as an unapplied entry and
   as a missing column. Only entries after the last one the copy had
   recorded count as unapplied: an older entry prod never recorded is
   history (0314, skipped and then repaired by 0316, stays unrecorded for
   good), and only its effect on the schema is checked. `UPGRADE_CHECK_IGNORE` leaves out key prefixes,
   for a difference prod carried from before the check.
5. Drop both databases.
6. Report the result for the image's commit to GitHub as the commit status
   `prod-data/upgrade-check`: `success`, or `failure` with the first
   difference as a description — only object names (table, column, index),
   never a row, a value or a count of rows of a user.

Data-dependent failures (a `NOT NULL` on a column with nulls, a unique
index that real rows violate, a long-running backfill) fail in step 2.
Drizzle runs all pending migrations in one transaction and its error does
not say which one failed, so the check then applies them one by one on
the scratch copy and reports the first that fails, with the Postgres error
code and the names of table, column and constraint. Never the message or
its detail: those can quote a value from a row. The full log stays in the
container on the host.

### Container and trigger

`upgrade_check` in `docker-compose.test.yml`: the app image tagged
`candidate`, the entry point above with `--stay`, the backup directory of
prod read-only (`UPGRADE_CHECK_DUMP_DIR`, never created by compose), the
dev postgres, and a GitHub token in `.env.test`
(`UPGRADE_CHECK_GITHUB_TOKEN`, fine-grained, this repository only,
permission "Commit statuses: read and write", nothing else). The image
knows its commit from `APP_BUILD_NUMBER`. It starts only with
`COMPOSE_PROFILES=upgrade-check`, because compose would otherwise try to
pull a `candidate` that does not exist before the first gated merge.

Watchtower only updates running containers, so the container does not run
once and stop: it checks, reports, and then waits. When a new `candidate`
appears, the dev stack's Watchtower (whose list in the overlay adds
`fk-encore-upgrade-check-test` to prod's) replaces it, and the new one
checks its own commit. A restart of the same container does not check the
same commit twice (a marker in its `/tmp`). By hand:
`docker compose --profile upgrade-check run --rm upgrade_check --no-report`
checks without writing a status and exits 0 (passed), 1 (failed) or 2
(could not run).

### Gate in CI

`docker-image.yml` on `main`, with the repository variable
`UPGRADE_CHECK=on` (step 1 runs without it too):

1. Build and push the app image as `candidate` and `sha-<commit>` (no
   longer straight to `latest`).
2. Call the dev Watchtower.
3. Wait for the commit status `prod-data/upgrade-check` on this commit,
   polling every 30 s, at most 45 minutes (`UPGRADE_CHECK_MINUTES`).
4. On `success`: tag `sha-<commit>` as `latest`
   (`docker buildx imagetools create`, no rebuild) and call the prod and
   demo Watchtower as today.
5. On `failure` or timeout: the run is red, prod keeps its image. Fixing
   forward is a new merge; nothing has to be rolled back.

The switch is the repository variable, not the secret
`WATCHTOWER_URL_TEST`: that secret exists already for the PR deploys, so
the gate would have waited in vain from the first merge on. Without the
variable the old path runs, so the change can be merged before the host is
set up. Every main build pushes `candidate` and `sha-<commit>` either way,
so the first merge after this change gives the check an image to start
from; only `latest`, the call to the test Watchtower and the wait depend on
the variable. Set it up in this order: env file, first
candidate, one check by hand, profile, variable (DEPLOYMENT.md › "Upgrade
check"). Main builds run one at a time (`concurrency`), so a later
candidate never overtakes an earlier one between its check and its
promotion, and the promotion retags the `sha-<commit>` tag, never
`candidate`. A tag push (`v*`) still builds `latest` directly and deploys
prod as an escape hatch.

## Stages

1. **Dev stack and refresh.** `docker-compose.test.yml`,
   `docker-compose.env.test.example`, `scripts/host/test-refresh.sh`,
   `scripts/host/test-scrub.sql`, prune skips cloned snapshots, remove
   `docker-compose-dev.yml`, DEPLOYMENT.md section on the test stack rewritten. Host: create
   the dev env file, run the refresh once, set up the weekly cron job.
   Until stage 2 is deployed, dev starts with no outbound keys and the
   scrub — enough for a first look, which is why stage 2 follows directly.
   Built: until stage 2 the overlay fixes mail to the catcher (Mailpit is
   in the overlay already) and empty keys for push, APNs, printing,
   SerpApi and EODHD, so an env file copied from prod cannot open them;
   the copy's snapshot label is in `$DEPLOY_DATA_ROOT/.test-copy`.
2. **`APP_ENVIRONMENT=dev` in the app.** `outbound(kind)` with the three
   modes and the `DEV_OUTBOUND_*` variables, the mail catcher in the
   overlay, `outbound` jobs with the test, the `llm` background workers,
   banner and title, `dev_copy`.
   Built: `lib/environment.ts` (kinds, defaults, `OUTBOUND_JOBS`), guards in
   `user/mail.ts`, `push/push.service.ts`, `push/apns-client.ts`,
   `finance/fints-client.ts`, `travel/serpapi-client.ts`,
   `travel/flight-search-client.ts`, `finance/quote-provider-eodhd*.ts`,
   `label/label.service.ts`, the llm workers and `documents/vlm-client.ts`;
   jobs held in `lib/local-cron.ts` (`dev_off`); `GET /environment`
   (`user/environment.ts`) with the copy from the backup volume's
   `.test-copy` instead of a `dev_copy` row; the bar in `App.vue` and the
   title prefix in `pageLayout.ts`. The overlay passes the modes through
   instead of blanking keys.
3. **Upgrade check.** Entry point, schema comparison, GitHub status,
   container in the overlay. Run by hand first (`docker compose run
   upgrade_check`) against today's `latest` and against the commit before
   #1919, which must fail on `watch_from`.
   Built: `scripts/upgrade-check/upgrade-check.mjs` (restore, migrate,
   find the failing migration, report) and `schema.mjs` (catalog, diff,
   journal, status text), copied into the image under
   `/opt/fk-encore/upgrade-check/`; service `upgrade_check` with profile
   `upgrade-check` in the overlay. No image of the commit before #1919 is
   kept, so the fault of #1919 is reproduced in
   `scripts/upgrade-check/upgrade-check.test.ts` instead: a journal entry
   older than the newest applied one is reported as skipped and its column
   as missing, and a `NOT NULL` that prod's rows break names the migration
   and code 23502.
4. **Gate in CI.** `candidate` tag, wait for the status, promote to
   `latest`. The GitLab mirror (`.gitlab-ci.yml`) does not deploy and stays
   as it is.
   Built: `GATE` in `docker-image.yml` from `vars.UPGRADE_CHECK`, the
   tags `candidate` and `sha-<commit>` on every main build, the steps "Hand the candidate to
   the upgrade check", "Wait for the upgrade check" and "Promote the
   candidate to latest" before the prod and demo deploys, one main build
   at a time. Off until the variable is set.

## Without ZFS

On a host without ZFS the same plan works with copies instead of a
clone: the refresh restores the nightly `pg_dump` (and a `pg_dump` of the
embeddings DB, which the backup would then have to write too) into the dev
postgres, and mounts photos and documents of prod read-only into dev.
Read-only means a delete, an edit or an import in dev fails, which is the
price of not copying hundreds of gigabytes. This is described, not built.
