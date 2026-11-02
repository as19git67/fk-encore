# Demo data for a fresh installation

A freshly installed system is empty: the gallery shows nothing, the
document list shows nothing, the finance pages have no account. Whoever
wants to see what the app can do (a new household member, a test
installation, a screenshot for the website) has to feed it real data
first. This plan adds an admin action that fills an untouched system with
synthetic demo data, large enough to show the app at work: 500 photos,
500 PDFs and 500 bookings, with a depot whose purchases, dividends and
statements show up in bookings and documents alike.

The documents are classified by the llm-service exactly as uploads are, so
the demo shows the real quality of the local model, not a prefilled
result.

## Goal

- One button on Admin › Systemstatus, offered only on an untouched system,
  that loads the demo data as a background job with progress.
- One button that removes every demo row again, whatever happened to the
  system in between.
- A generator that the assistant's benchmark can reuse as its synthetic
  test database (stage 6, part 2 of `assistent-wegfindung.md`).
- No real data at all: no real names, addresses, account numbers, places
  from anyone's life, or real documents.

## What exists today

- `db/seed.ts` creates roles, permissions, the taxonomy, the admin from
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` and the AI system user. There is no setup
  flow beyond that.
- `db/seed-demo.ts` (Issue #401) laid down three colour-swatch photos, one
  PDF and a manual account with two bookings for the admin, only when
  `E2E_SEED_DEMO=1` was set, for the Playwright specs. It wrote rows
  directly and bypassed every pipeline. Replaced in stage 4 by
  `DEMO_DATA=small`.
- `finance/data-import.ts` (Finanzkraft JSON import) is not a path for demo
  bookings: it is no longer needed and is removed from the code in its own
  PR before stage 3.
- No CSV or CAMT import exists.

## Decisions

| Question | Decision |
|---|---|
| When is a system "new" | When it holds no user content and no users besides the admin and the AI system user. "User content" is counted, not guessed from boot time: photos, documents, finance transactions, depot transactions, meter readings, trip plans. All zero → untouched. The check lives in one function (`demo/state.ts`, `isUntouched()`) and the endpoint repeats it before it starts, so a second admin tab or a document that arrived meanwhile cannot slip through. |
| Who triggers it | An admin, explicitly, on Admin › Systemstatus ("Demodaten einspielen", with the volumes and the estimated duration). Nothing loads by itself on a production boot. For test installations `DEMO_DATA=1` starts the same job once at boot (`DEMO_DATA=small` the small household of the E2E tests), still only on an untouched system. |
| Who owns the data | The admin who starts it, so the demo appears in the account that is looking at it. A second demo user, the spouse "Erika Mustermann" (`erika@beispiel.test`), is created with it: no password (the admin can set one or send an invite from the user list, so the shared view can be tried), the roles of a household member, and a subject person with `relation_kind` spouse so the joint assessment works. Each of the two has an own giro account; the joint giro account belongs to the admin and is shared with the spouse with write access through the account access list, and the depot is the admin's. The demo users count as demo rows: `isUntouched()` ignores them, and removal deletes the spouse with everything else. |
| Removal | Every row the generator writes is recorded in `demo_item` (`run_id`, `table`, `row_id`), every file it writes in `demo_file`. "Demodaten entfernen" deletes in reverse dependency order and removes the files. Rows the pipelines derive (thumbnails, embeddings, faces, text, classification, depot transactions derived from documents) hang off a recorded row by foreign key and go with it; where a derived row has no cascade, the remover deletes it by its parent id. A run that is removed leaves the system untouched again. |
| Where it lives | A new service `demo/` (endpoints under `/admin/demo`, admin only (`user/admin-guard.ts`)), the job in the existing queue so it shows up under Admin › Jobs. The E2E seed becomes the size `small` of the same generator; `db/seed-demo.ts` goes away. |
| Determinism | A seeded PRNG (`demo/random.ts`) decides everything the code decides; the same seed gives the same skeleton. The LLM-written text varies between runs, the skeleton (dates, amounts, which document belongs to which booking) does not. |
| Two text sources | `text: "llm"` lets the local model write the texts; `text: "template"` fills the same skeleton from fixed templates in seconds and without the llm-service. The admin button uses `llm`; tests, CI and the assistant benchmark use `template`. |
| Ground truth | The generator knows what each document is (kind, sender, date, amount, tax role, matching booking). It keeps that in `demo_truth` and reports, after the pipeline has run, how often the classification hit: category, sender, date, amount, tax role, booking match. This is the measurement the demo is for; it is shown on the Systemstatus page after the run. The figure flatters the model a little, since the same model wrote and reads the text; the plan says so on the page. |
| Migrations | Next free number at the time of implementation (0280 or later today: 0278 is on main, 0279 is taken by the photo book PR), with an entry in `_journal.json` whose `when` is later than every existing one, or Drizzle skips it. |

## How the data is made

### Skeleton (code)

The code builds one synthetic household over three years before today:

- Two adults, "Max Mustermann" and "Erika Mustermann", one child "Kim",
  living at "Beispielstraße 1, 12345 Musterstadt". Every name comes from a
  fixed list in `demo/names.ts`; senders are invented companies with
  obviously synthetic names ("Musterwerke GmbH", "Stadtwerke Musterstadt",
  "Beispiel-Versicherung AG", "Demo-Bank eG"). IBANs are `DE00 …` with a
  valid checksum layout but a non-existent bank code, phone numbers as
  `0000 000000`, e-mail addresses at `beispiel.test`.
- A calendar of events that produce bookings and documents together:
  salary each month, rent, electricity and gas advance payments with the
  annual bill, insurance premiums, a craftsman's invoice (for § 35a),
  doctor's bills, a car repair, online purchases with their invoices,
  donations with receipts, child benefit, a tax assessment notice, the
  Lohnsteuerbescheinigung each year.
- A depot at the demo bank with four securities: purchases, a monthly
  savings plan, dividends and distributions, one sale with a gain, and a
  quarterly depot statement. Each purchase and dividend is a booking on
  the giro account and a settlement PDF; each statement is a PDF.

The 500 bookings and the 500 PDFs come from this calendar. Not every
booking has a document (card payments at the supermarket do not) and not
every document has a booking (contracts, notices, the depot statement),
so the overlap is about 180. That overlap is what document matching and
the depot derivation show.

### Text (llm-service)

For each document the code hands the model the skeleton (kind, sender,
recipient, date, amounts, positions to invent) and asks for the text of the
letter as grammar-bound JSON (`POST /chat` with a schema, background
priority in the `llm` queue, so a waiting user always goes first). The
model writes the wording, the positions of an invoice within the given
total, the reason of a notice, the purpose lines of the bookings. It is
never asked for names, addresses or account numbers: those come from the
skeleton, and the code rejects a text that contains a name or company not
in the lists (simple check against a list of common German surnames and
well-known company names).

The code then renders the PDF with `pdfkit` (letterhead, address window,
table, footer), with a text layer, from one of several layouts per kind so
the documents do not all look alike. A small share (about 10 %) is
rendered as an image-only scan with slight rotation and noise, so text
extraction and OCR show up too.

Bookings get their purpose and counterparty from the same call where they
belong to a document, from a batched call of 25 otherwise.

Estimate, not measured: about 10 s per document text on the production
model plus the normal classification pipeline afterwards, together two to
four hours for 500 documents. The job reports progress per stage and can
be cancelled; a cancelled run can be removed like a finished one.

### Documents into the pipeline

The PDFs are imported through `importDocumentFromPath` (the helper the
upload and the inbox watcher use) with nothing prefilled: no category, no
sender, no date, no tax role. Text extraction, classification, reference
numbers, tax values, duplicate detection and the depot enrichment run as
for any upload.

### Bookings

A manual account "Girokonto Demo-Bank" and "Tagesgeld Demo-Bank" for the
admin, created through `createAccount`, the bookings through the same
service function as `createTransaction` (manual booking), called as the
admin so access checks apply. Tags are left empty where the app can
suggest them, so the tag suggester has work to show. The depot is a depot
account at the demo bank; depot transactions are not written directly but
derived from the giro bookings and settlement PDFs by the existing
derivation (`deriveFromBookings`, the settlement and
statement enrichment).

### Securities and quotes

The four securities are real, widely held broad index funds (world
equities, emerging markets, Europe, a bond index), listed in
`demo/securities.ts`, so the demo gets real and current quotes from the
configured provider like any depot. That needs the provider to be
reachable when the demo is loaded; without it the run leaves the depot
out and says why.

The prices in the settlements come from the provider's real history: the
generator first loads the quote history of the three years, then sets each
purchase, savings plan instalment and sale at that day's closing price, so
settlements, bookings and the performance chart agree. Dividends and
distributions use plausible synthetic amounts per unit (the provider has no
dividend history); the demo says so in the settlement footer ("Demo"). Only
broad index funds are chosen, never single stocks, so the list says nothing
about anyone's holdings.

### Photos

500 photos with a free licence that allows redistribution without
attribution: CC0 or Public Domain Mark, searched through the Openverse API
(openverse.org) on topics that make a family archive plausible
(landscape, city, food, garden, animals, sports, celebration, beach,
mountains, snow). Unsplash, Pexels and Pixabay do not qualify: their
licences forbid redistributing the photos as a collection.

- Downloaded at run time into a demo library directory, never committed to
  the repo. The list of chosen photos (Openverse id, licence, source URL)
  is stored with the run, so a removed run can be loaded again with the
  same set and the licence of each photo stays traceable.
- Only photos without recognisable people (Openverse has no such filter:
  the generator runs the face detector on each candidate and drops those
  with a face larger than a small fraction of the frame).
- EXIF is rewritten before import: date from the household's calendar
  (holidays, birthdays, seasons), camera model from a fixed list, GPS from
  a list of public squares and landmarks in invented trips, never from the
  original photo.
- Imported by creating a photo library on that directory and running
  `scanLibrary`, so thumbnails, embeddings, aesthetics, duplicates and
  groups come from the real pipeline.
- Albums: five albums made by the generator from the trips and events
  ("Sommerurlaub", "Weihnachten", "Garten") plus whatever the app suggests
  itself.

The demo has no persons: CC0 photos of real people still show real people
with their right to their own image, and no source of synthetic faces with a
licence that allows redistribution is known. The page says so; face
recognition and persons are shown with one's own photos.

### Meters

Electricity, gas, water and a small PV system with monthly readings over
three years from a seasonal curve, through the meter service's own
functions. Small and fast; it makes the PV business and the energy report
show something (stage 5).

## Stages

1. **State and removal.** *Done.* Service `demo/` (endpoints in
   `demo/demo.ts`), `isUntouched()` and the counts in `demo/state.ts`,
   tables `demo_run`, `demo_item`, `demo_file`, `demo_truth` (migration
   0284), register in `demo/registry.ts`, removal in `demo/remove.ts`, the
   card `DemoDataCard.vue` on Admin › Systemstatus. The household skeleton
   (`demo/household.ts`, seeded) with `template` texts: the spouse as second
   user, subject persons and joint assessment, four accounts including the
   joint one, 500 bookings (40 for `small`), written by `demo/writer.ts`.
   The run is an in-process background job that writes its progress into
   `demo_run` (polled by the card), not a queue job; a run a restart
   interrupted is marked failed at boot. Moved to stage 4: replacing
   `db/seed-demo.ts` by `size: "small"` and `DEMO_DATA=1` in the
   Playwright workflow — the E2E specs need the photos and documents of
   the seed, which the generator does not make yet.
2. **Documents.** *Done.* The plan of 500 documents (30 for `small`) in
   `demo/documents.ts`: one per booking that has paper (payslip, phone
   bill, utility bill, insurance premium, craftsman's invoice, doctor's
   bill, car repair, donation receipt, tax assessment, online invoice,
   receipts), the yearly ones (wage tax certificate, the bank's tax
   certificate, advance plan, service charges, pension information, car
   insurance), monthly statements of the giro accounts and quarterly ones
   of the savings account, filled up with letters (school, club, health
   insurer, bank, utility, insurer). The household got the bookings these
   need (craftsman, doctor, garage, donation, tax refund). Layouts and
   rendering in `demo/pdf-render.ts`: three letter layouts, a statement
   table over several pages, a receipt slip; about one in ten is drawn as
   SVG, rasterised by sharp, turned and roughened, and stored as an
   image-only PDF. Wording by the model in `demo/doc-text-llm.ts`
   (`/json-prompt` with a schema through the `llm` queue at background
   priority); an answer that names a common surname, an unknown company,
   a title, a long number or an amount the document does not have is
   dropped and the template stays. The start offers the model or the
   templates; a model that does not answer at the start means templates
   for the whole run (`text_source` says which). Import and truth in
   `demo/doc-writer.ts`, nothing prefilled, file names that say nothing
   (`Dokument_<date>_<n>.pdf`, `Scan_…`), source folder `Demodaten`; the
   comparison in `demo/truth.ts` (`GET /admin/demo/truth`: category or a
   child of it, document type, sender, date, tax role where the generator
   has one; documents still in the queue count as pending), shown on the
   card. Removal deletes each document with its file through
   `documents/purge.ts`, the same code as `DELETE /documents/:id`.
   Booking purposes stay with the templates: the model words documents
   only.
3. **Depot.** *Done.* The Finanzkraft import was removed beforehand
   (#1784). Four broad index funds by ISIN in `demo/securities.ts`; their
   history comes from the configured provider through `refreshQuotes`
   (moved to `finance/quote-refresh.ts`, so the demo service loads quotes
   without importing the finance endpoints), and the plan in
   `demo/depot.ts` trades at each day's close: one-off buys of three
   funds, a monthly savings plan in the world fund, quarterly and
   half-yearly distributions of the two distributing funds at a synthetic
   yield, one sale two years in, a depot statement at each quarter's end.
   Every trade and payout is a booking on the admin's giro account
   ("Wertpapierkauf ISIN … Depot …") and a settlement PDF in label/value
   form; the statements list each position with its labelled quantity,
   price and value. `demo/depot-writer.ts` creates the depot account
   (depot number on every paper) with the traded funds confirmed in its
   securities master; the depot transactions and holdings are not
   written — the pipeline reads them from the papers (the tests check
   that `parseSettlement` and `inspectDepotStatement` read the rendered
   PDFs back to the planned figures). Without a provider or without a
   fund's history the run leaves the depot out and says why on the card
   (not a failure). The loaded quotes stay when the demo is removed: they
   are shared by every depot holding the fund.
4. **Photos.** *Done.* The plan in `demo/photos.ts`: 500 shots (12 for
   `small`) over the household's span — a winter holiday in the
   mountains, a city trip in spring, a summer holiday at the sea, the
   garden from April to September, two birthdays, Christmas, New Year's
   Eve and everyday pictures — each with a topic, a local time, a camera
   (phones at home, a system camera on holidays) and a position only on
   the trips, at public squares and viewpoints; five albums (the latest
   holiday of each kind, "Garten", "Weihnachten"). The sources in
   `demo/photo-sources.ts`: the full demo searches Openverse for CC0 and
   PDM photos per topic (anonymous, a pause between searches, waits out a
   429), passes over candidates whose title or tags name people, downloads
   the rest without their metadata (long edge 2048 px) and drops every
   photo in which the app's face detector finds a recognisable face (the
   photo book's 5 % × 5 % rule); other topics fill in where one runs out.
   The small demo, the tests, and a full demo that Openverse or the
   detector does not answer for draw their pictures from a few shapes; the
   card says why. `demo/photo-writer.ts` writes each shot's EXIF (date,
   camera, position) with exiftool, imports the folder through a
   temporary photo library in "move" mode (so the files land in the photo
   storage and thumbnails, embeddings, aesthetics and groups come from the
   real pipeline), deletes the library again and makes the albums. The
   chosen photos with Openverse id, title, creator, licence and source
   URL are kept in `demo_photo` (migration 0285) after the run is removed;
   the next run loads that set again before it searches. Removal deletes
   the photos with files and thumbnails and the albums.
   The boot switch in `demo/boot.ts`: `DEMO_DATA=1` (or `full`) loads the
   full demo worded by the model, `DEMO_DATA=small` the small household
   from the templates; the admin from `ADMIN_EMAIL` owns it, and a system
   that holds a demo or anything else is left alone, so a restart loads
   nothing twice. The Playwright workflows set `DEMO_DATA=small` and the
   E2E `globalSetup` waits until the run is done; `db/seed-demo.ts` and
   `E2E_SEED_DEMO` are gone.
5. **Meters and businesses.** *Done.* The plan in `demo/energy.ts`: five
   meters of the admin (grid import, feed-in, PV production, gas, water)
   read on the first of each month of the span and today, from seasonal
   curves (PV yield per kWp and month, household demand of which about a
   third is covered from the roof, gas for heating, more water in summer);
   the tariffs the energy report prices them with (grid price, base price,
   the feed-in tariff since commissioning); a 9.8 kWp system put up two and
   a half years before the span, so § 3 Nr. 72 EStG makes it exempt and its
   EÜR is for information; and the bookings of that business on the
   admin's giro account — each month's feed-in, paid in the middle of the
   next, as the exported kWh times the feed-in tariff, so the EÜR's income
   line and the energy report's feed-in revenue agree; the insurance, the
   metering fee and one service visit — tagged `Photovoltaik` plus the
   line's tag (`Einspeisung`, `Versicherung`, `Zähler`, `Wartung`).
   `demo/energy-writer.ts` creates the meters, readings and tariffs through
   the meter service's functions and the business with the system as an
   asset (5 % a year from commissioning); the writer links the bookings to
   their tags (a tag that did not exist is registered and removed with the
   run). Removal deletes the business, the meters and the tariffs, the
   devices, readings and assets go with them. Documents for the business
   (feed-in statements) are left out.
6. **Benchmark hand-off.** The generator as a function the assistant
   benchmark can call against the test database with `text: "template"`
   and a fixed seed. Agreed with the work on `assistent-wegfindung.md`
   before anything in `assistant/` changes.
   *Done (demo side):* `demo/bench.ts` — `layBenchHousehold(ownerId,
   { today, seed?, size?, depot?, photos? })` lays the household for any
   owner (the benchmark account) into a system that holds data, with the
   template texts, small by default, without depot and photos unless asked;
   `removeBenchHousehold(runId)` takes it back. The run carries
   `demo_run.purpose = 'benchmark'`, so `currentRun()` and Systemstatus never
   see it as the demo and a demo can be loaded beside it. It gets its own
   account numbers and IBANs (`accountSeries` of `planHousehold`) and its
   own spouse address; one household per owner (the tariffs are the
   owner's). A tag a run created is only removed with it while no other
   booking uses it. A case computes its expected answer from the same plan
   (`planHousehold`, `planEnergy`, `planDocuments` with the same seed and
   today). Switching `assistant/bench/synthetic.ts` over to it, and cases
   on it, is a separate change on the assistant side.

## Demo deployment

Decided 2026-10-31: the demo runs as a third deployment from the same
`docker-compose.yml`, next to prod and test, and is kept current by
Watchtower.

*Done:* `docker-compose.demo.yml` and `docker-compose.env.demo.example`,
a "Deploy to TrueNAS (demo)" step in every image workflow except the
llm-service's, and `scripts/host/demo-reset.sh` for the nightly reset.
How to set it up is in `DEPLOYMENT.md`, "Demo stack".

- **Own stack.** Its own `.env` with `DEPLOY_NAME_SUFFIX=-demo`,
  `DEPLOY_WATCHTOWER_SCOPE=fkdemo`, its own ports, data root and
  Watchtower token.
- **Tag `latest`.** The demo shows what is on main, not every PR. The
  image workflow gets a step "Deploy demo" after the prod deploy, with a
  new secret `WATCHTOWER_URL_DEMO`. Migrations run on update as usual.
  The step must never turn main red: it runs only when the secret is set
  (mapped into `env`, since `secrets` cannot be read in `if:`) and carries
  `continue-on-error: true`, so a demo stack that is not set up yet or is
  down only shows a warning. Watchtower itself answers 200 when none of
  its containers exist yet; it updates only what runs.
- **First fill.** `DEMO_DATA=1` in the demo's `.env` makes the server load
  the full demo at boot while the system is untouched (`demo/boot.ts`;
  the E2E workflows set `DEMO_DATA=small`).
- **Shared GPU.** A second Gemma 4 does not fit next to the first in
  16 GB; the demo app points `LLM_SERVICE_URL` at the prod llm-service
  instead of starting its own.
- **Nightly reset.** Visitors create rows the register does not know, so
  removing the run is not enough: a nightly job empties the demo's
  database and file directories and loads the demo again. It only runs
  where `DEMO_DATA=1` is set, never on prod or test.
  It runs at 18:00 `America/Los_Angeles`, computed in that time zone so daylight saving
  on either side does not move it; in Germany that is 03:00, for a few
  weeks in spring and autumn 02:00.

## Open questions

None at the moment. Decided (2026-10-26): no persons in the demo, real
broad index funds with live quotes, a second demo user with one joint
account.

## Risks and what is left out on purpose

- The model may write something that looks real (a real company, a real
  street). The name check catches the common cases; the generator never
  asks for names in the first place.
- Openverse may change its API or return fewer CC0 photos for a topic; the
  generator takes what it gets per topic and fills up from the others.
- Trips are left out: they need OSM regions, which a fresh system does not
  have.
- Demo data is never mixed into real data on purpose: once the system
  holds real content, the button is gone. Removing the demo does not touch
  anything that was not recorded by a run.
