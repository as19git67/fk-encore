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

- **The dev system replaces the test stack.** It takes the test stack's
  ports (18080/15432/9001), and PR images keep landing there after every
  push — so a PR is tried on real data. Instead of whatever the test stack
  holds today, it gets the copy of production.
- **It is called dev everywhere.** Name suffix `-dev`, compose project
  `fk-encore-dev`, watchtower scope `fkdev`, image tag `:dev` for PR builds
  (instead of `:test`), repository secret `WATCHTOWER_URL_DEV` (instead of
  `WATCHTOWER_URL_TEST`), env file `.env.dev`, a data root containing
  "dev". Keeping "test" would leave two names for one system, in the
  workflow, on the host and in every conversation about it. The rename
  costs nothing extra: the stack gets new data at its first refresh
  anyway, so the old test containers are simply stopped and removed once
  dev is up. `docker-compose.env.test.example` goes with them. A fifth stack would cost CPU and RAM for embedding and face
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
  `.env.dev`, so one path can be tested without opening the others (see the
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

`docker-compose.dev.yml`, layered by `COMPOSE_FILE` in `.env.dev`
(template `docker-compose.env.dev.example`, next to the demo's):

```
COMPOSE_FILE=docker-compose.yml:docker-compose.volumes.yml:docker-compose.dev.yml
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

`.env.dev` sets the dev identity (suffix `-dev`, project `fk-encore-dev`,
scope `fkdev`, tag `dev`, the old test ports), `DEPLOY_DATA_ROOT` to the mount point of the dev dataset, and the
database names of prod (`encore`, `embeddings`), because the cloned
cluster carries prod's names. Its own `RP_ID`/`RP_ORIGIN`: passkeys from
prod do not work in dev, login is by password. Extra photo libraries
outside the prod dataset are mounted read-only in dev's
`docker-compose.volumes.yml`.

### Refresh: `scripts/host/dev-refresh.sh`

Shipped in the image and copied to `backup/host-scripts/` like the backup
hook, so the host needs no checkout. Called with the path to `.env.dev`
from a weekly TrueNAS cron job (Sunday night, after the backup) or by
hand. It reads `PROD_DATASET` and `DEV_DATASET` from the env file and
refuses to run when `DEV_DATASET` equals `PROD_DATASET`, is not a sibling
of it, does not contain "dev", or when the env file lacks
`APP_ENVIRONMENT=dev`. `--dry-run` prints every step.

1. `docker compose --env-file .env.dev down`.
2. Find the newest `daily-*` snapshot of `PROD_DATASET`.
3. `zfs destroy -r DEV_DATASET` (only if its `origin` is a snapshot of
   `PROD_DATASET` — a dataset that is not a clone is never destroyed).
4. `zfs clone` the snapshot to `DEV_DATASET`, and each child dataset to
   the matching child (a clone is not recursive).
5. In the clone's backup directory: remove `restore-*.dump`, the prod
   dumps and `host-scripts/backup-token`.
6. Start only `postgres`, set its password to the one in `.env.dev`
   (`ALTER USER` over the local socket, which needs none), and run the
   scrub (`scripts/host/dev-scrub.sql`).
7. Write the snapshot label into a `dev_copy` row, which the banner shows.
8. `docker compose --env-file .env.dev up -d`. The app migrates the copy
   to its own image on boot.

### Scrub: `scripts/host/dev-scrub.sql`

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
`outbound(kind)`, called at the lowest layer of each path. It returns the
mode of that kind: `off` throws a clear error instead of sending,
`redirect` sends to the dev target named in the table, `on` sends as in
prod (with dev's own key). In prod every kind is `on` and the module does
nothing. The mode is read from `DEV_OUTBOUND_<KIND>` in `.env.dev`; the
defaults:

| Kind | Where | Default in dev | `redirect` means |
|---|---|---|---|
| `mail` | `user/mail.ts` (password reset, exports, price alerts, guest digest) | `redirect` | every mail goes to a local mail catcher (e.g. Mailpit in the dev stack), whatever the recipient |
| `push` | `push/push.ts`, `push/apns-client.ts` | `off` | — (`on` with dev's own VAPID pair and the APNs sandbox reaches only devices that signed in to dev; the copied tokens are deleted) |
| `fints` | the FinTS client in `finance/` (sync, TAN probe) | `off` | — (`on` after entering a login in dev) |
| `serpapi` | the hotel and flight clients in `travel/` | `off` | — (`on` with dev's own key; the daily jobs stay off, a check runs by hand) |
| `eodhd` | EODHD client in `finance/` | `off` | — (quotes from Onvista and news from Yahoo need no token and stay on) |
| `print` | the CUPS client | `off` | a PDF written into the dev data directory instead of paper |

Jobs: `schedule()` in `lib/local-cron.ts` takes `outbound: true`. In dev
such a job is registered disabled when its kind is `off`; the admin page
shows it as "aus (Dev)" and it can be switched on by hand for a test. The list is the
exported `OUTBOUND_JOBS` that the scrub reads too; a test fails when a job
whose module calls one of the guarded paths is not marked. Today that is
`finance-sync-statements`, `finance-news-refresh`,
`travel-hotel-watches`, `travel-flight-watches`, `collections-schedules`,
`documents-follow-ups-process-due`, `guest-digest`,
`trip-planner-live-activities`, `photo-aesthetic-nightly` and
`meter-petrol-prices`. The OSM jobs stay on: the geo database comes along
in the clone, and keeping its regions current only downloads public data.

The `llm` queue does not start its background workers in dev; a user's
own request still runs.

Every page shows a thin bar "Dev · Kopie vom <Datum>" above the
navigation (from `dev_copy`), and `document.title` starts with "Dev ·",
so a dev tab is never mistaken for prod.

## The upgrade check

### What it does

The app image gets a second entry point, `node … upgrade-check`, which
runs without the HTTP server:

1. Restore the newest `encore-daily-*.dump` from prod's backup directory
   (mounted read-only into the check container) into a scratch database
   `encore_upgrade_check` on the dev postgres, dropped and recreated each
   time.
2. Run the image's migrations and seed on it, exactly as the boot does.
3. Run the same migrations on an empty database `encore_upgrade_fresh`.
4. Compare: every journal entry applied in both, and
   `pg_dump --schema-only` of both equal after normalising. A skipped
   migration, as in #1919, shows here as a missing column, as does any
   migration that only half applied.
5. Drop both databases.
6. Report the result for the image's commit to GitHub as the commit status
   `prod-data/upgrade-check`: `success`, or `failure` with the first
   difference as a description — only object names (table, column, index),
   never a row, a value or a count of rows of a user.

Data-dependent failures (a `NOT NULL` on a column with nulls, a unique
index that real rows violate, a long-running backfill) fail in step 2 and
show the migration's file name and the Postgres error code.

### Container and trigger

`upgrade_check` in `docker-compose.dev.yml`: the app image tagged
`candidate`, command `upgrade-check`, the backup directory of prod
read-only, the dev postgres, and a GitHub token in `.env.dev` (fine-grained,
this repository only, permission "Commit statuses: read and write",
nothing else). The image knows its commit from `BUILD_NUMBER`. Watchtower
of the dev stack replaces and starts it when a new `candidate` appears;
it runs once and stops.

### Gate in CI

`docker-image.yml` on `main`:

1. Build and push the app image as `candidate` and `sha-<commit>` (no
   longer straight to `latest`).
2. Call the dev Watchtower.
3. Wait for the commit status `prod-data/upgrade-check` on this commit,
   polling every 30 s, at most 45 minutes.
4. On `success`: tag `sha-<commit>` as `latest`
   (`docker buildx imagetools create`, no rebuild) and call the prod and
   demo Watchtower as today.
5. On `failure` or timeout: the run is red, prod keeps its image. Fixing
   forward is a new merge; nothing has to be rolled back.

Without the secret `WATCHTOWER_URL_DEV` the gate is skipped with a warning
and the old path runs, so the change can be merged before the host is set
up. A tag push (`v*`) still builds `latest` directly as an escape hatch.

## Stages

1. **Dev stack and refresh.** `docker-compose.dev.yml`,
   `docker-compose.env.dev.example`, `scripts/host/dev-refresh.sh`,
   `scripts/host/dev-scrub.sql`, prune skips cloned snapshots, remove
   `docker-compose-dev.yml` and `docker-compose.env.test.example`, PR builds
   tagged `:dev` and deployed through `WATCHTOWER_URL_DEV`, DEPLOYMENT.md
   section "Dev stack" in place of the test stack. Host: create the dev env
   file, run the refresh once, set up the weekly cron job, stop and remove
   the old test containers, set the secret `WATCHTOWER_URL_DEV` and drop
   `WATCHTOWER_URL_TEST`.
   Until stage 2 is deployed, dev starts with no outbound keys and the
   scrub — enough for a first look, which is why stage 2 follows directly.
2. **`APP_ENVIRONMENT=dev` in the app.** `outbound(kind)` with the three
   modes and the `DEV_OUTBOUND_*` variables, the mail catcher in the
   overlay, `outbound` jobs with the test, the `llm` background workers,
   banner and title, `dev_copy`.
3. **Upgrade check.** Entry point, schema comparison, GitHub status,
   container in the overlay. Run by hand first (`docker compose run
   upgrade_check`) against today's `latest` and against the commit before
   #1919, which must fail on `watch_from`.
4. **Gate in CI.** `candidate` tag, wait for the status, promote to
   `latest`. The GitLab mirror (`.gitlab-ci.yml`) does not deploy and stays
   as it is.

## Without ZFS

On a host without ZFS the same plan works with copies instead of a
clone: the refresh restores the nightly `pg_dump` (and a `pg_dump` of the
embeddings DB, which the backup would then have to write too) into the dev
postgres, and mounts photos and documents of prod read-only into dev.
Read-only means a delete, an edit or an import in dev fails, which is the
price of not copying hundreds of gigabytes. This is described, not built.
