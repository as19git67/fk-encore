# Securities master, depot statements, model-first reading

Status: stages 1 (#1518), 2 (#1520) and 3 done. Follows the portfolio
work of #1336 (settlement documents, derivation from bookings, review page).

## Problem

The portfolio takes securities from wherever they turn up:

- A booking on the settlement account becomes a depot transaction when its
  ISIN or WKN stands in a holdings snapshot — that part is tight.
- A document may create a transaction for every security it names, as long
  as it carries the depot number or the depot already has transactions of
  the security. A quarterly reporting that lists insurance contracts and
  other positions next to the three funds, with the depot number on it,
  creates phantom positions. A model that takes the bank's name for the
  security's does the same.
- Depot statements and reportings, which say exactly what the depot held
  on a day, are not read at all — the only holdings come from FinTS, which
  reaches back a few months.
- The rules read a paper first and the model second; on a tie the rules
  win, and on fields no check reaches (name, WKN, depot number) that is
  nearly always. The model reads amounts and identifiers off OCR'd and
  column-split text better than the rules do.

## Decisions

- **A security exists only when confirmed.** Each depot keeps a master of
  its securities. What the bank's holdings deliver is confirmed by itself;
  anything else found in bookings or documents is a *proposal* on the
  review page, booked only after the user takes it in. Ignored proposals
  stay silent. This is the guard that lets the model read more freely.
- **Statements are holdings.** A depot statement or reporting is read into
  holdings snapshots (`finance_account_holding`, source `document`), for
  the confirmed securities only. The reconciliation then has anchors over
  the whole history, and the oldest statement is the opening position —
  no cut-off date setting is needed.
- **The model reads, the rules check.** The model's reading becomes the
  primary one; the checks (net equation, quantity × price, ISIN check
  digit, date, booking net) decide what stands; the rules fill in where
  the model's value fails or is missing. The rules keep the paper type and
  the pre-selection of papers worth sending to the model.

## Stages

1. **Securities master** (`finance/depot-securities.ts`).
   - Table `finance_depot_security`: `id`, `account_id`, `isin`, `wkn`,
     `name`, `status` (`confirmed` | `proposed` | `ignored`), `source`
     (`bank` | `booking` | `document` | `user`), `first_seen_at`,
     `decided_at`, `decided_by`. Unique per depot and identifier (ISIN,
     else WKN). Table `finance_depot_security_evidence`: where a proposal
     was seen (`security_id`, `transaction_id` | `document_id`,
     `seen_at`), so the review page can show "in 3 bookings, 2 papers".
   - Seeding: every security in `finance_account_holding` is `confirmed`
     (source `bank`); the holdings sync keeps it so. A migration seeds the
     existing data.
   - Derivation (`depot-derivation.ts`): a booking whose security is not
     confirmed for the depot it would go to creates or extends a proposal
     and derives nothing. Ignored: derives nothing, silently.
   - Enrichment (`depot-document-enrichment.ts`): `resolveDepot` also
     requires the security to be confirmed in the depot it found; a paper
     about an unconfirmed security becomes a proposal (outcome
     `unknown_security`) and books nothing. The booking-link path
     (#1474) is exempt: a paper the user linked to a booking of a
     confirmed security is the user's say-so.
   - Review page: group "Neue Wertpapiere" with name, ISIN/WKN, depot,
     evidence, first date; buttons "Aufnehmen" and "Ignorieren". Taking
     one in confirms it and reads its evidence again (derivation for the
     depot's bankcontact, enrichment of the documents), so the rows appear
     without a full "Belege einlesen".
   - "Belege neu einlesen" keeps the master and its decisions.
   - API: `GET /finance/portfolio/review` gains `new_securities`;
     `POST /finance/portfolio/securities/:id/decision` with
     `confirm | ignore`; the ignored ones are listed with `ignored=true`
     like ignored documents, so a decision can be undone.

2. **Depot statements and reportings as holdings** — done.
   - Own reader next to the settlement one (`depot-statement-parser.ts`,
     `depot-statement-enrichment.ts`): the rules recognise the paper by its
     heading words ("Depotauszug", "Depotbestand", "Vermögensübersicht",
     "Reporting", …) and the absence of settlement wording, read the
     statement's date ("per 31.12.2025"), the depot number and a position
     per identifier with the figures labelled on its row. The model is
     asked once per paper (`extractStatementPositions`, answer kept in
     `finance_document_statement_llm`) for the date and the positions; the
     merge takes the model's figures first and the rules' where the model
     has none — or where the rules' quantity × price gives the value and
     the model's does not (stage 3 applied here already).
   - Stored as holdings rows with `source = 'document'` and `document_id`
     (migration 0238, columns on `finance_account_holding`), keyed like the
     bank's rows (depot, day, ISIN else WKN); a day the bank's sync covers
     keeps the bank's figures, and the sync sets `source` back to `bank`.
   - The depot is the one whose number the paper prints, else the one depot
     in scope whose master confirms a security the paper lists. Only
     confirmed securities are stored; unknown ones become proposals with
     evidence `document` (a dry run proposes nothing), ignored ones stay
     silent, and a confirmed position without a readable quantity is never
     stored. "Aufnehmen" re-reads the statements among the evidence;
     "Ignorieren" and "Wieder vorschlagen" delete the rows statements wrote
     for that security.
   - Reconciliation, the holdings history and the position page treat
     document holdings like FinTS holdings; the oldest one is the opening
     position (quantity and, where printed, the bank's cost basis as
     `acquisition_price`). A row read from a statement never counts as the
     bank's word for the master (enrichment and derivation check `source`).
   - The review page lists statements that could not be placed under
     "Depotauszüge ohne Depot" (`unplaced_statements`, with date, depot
     number and the identifiers listed); "Für Depots ignorieren" applies to
     them as to any paper. The background run reads the statements after
     the settlements and reports `statements_stored`, `statements_unplaced`
     and `statement_positions_proposed`; "Belege neu einlesen" deletes the
     document holdings and the stored answers, so every statement is read
     again with today's rules.

3. **Model-first reading** — done (`depot-settlement-merge.ts`,
   `depot-settlement-reader.ts`, `depot-paper-type.ts`).
   - `mergeSettlement`: on a tie the model wins. The rules keep a field
     whose model value fails a check the rules' value passes (the checks
     still decide first), the kind of paper (the heading the rules
     recognise decides buy, sell or dividend), and a field whose model value
     is not grounded in the text. "Unverified" only when no combination
     passes the checks.
   - Grounding (`groundingOf` in the reader): the model's ISIN, WKN and
     depot number must appear in the text, its quantity on a line with a
     quantity label ("Stück", "Anteile", "Nominale", …), its date as
     printed. An ungrounded value loses a tie — the letterhead code read as
     the quantity of a dividend without a price per share stays out. The
     statement reader drops model positions whose identifier the text does
     not show.
   - The name follows the text both ways: the one printed nearer the
     identifier wins, whichever source read it.
   - A second question to the model (`classifySecuritiesPaper`, answer kept
     in `finance_document_paper_llm`, migration 0239): a paper with an
     identifier and securities wording but no heading the rules know (and
     not insurance paperwork) is asked "trade, dividend, tax, statement or
     other?". The answer makes it a candidate of the settlement reader or
     the statement reader; "other" leaves it alone. The background run asks
     first, then reads; new documents go through `readDepotPaper`. "Belege
     neu einlesen" clears the answers. The question asks only for the kind
     of paper — each reader lists the securities itself, so a second list
     would only duplicate them.
   - Identifiers the model reads count only against the master (stage 1):
     an ISIN or WKN not confirmed is a proposal, never a booking.
   - Holdings tables of a bank's periodic report ("Finanzreport"): rows of
     WKN / custody type, quantity, last price, currency, value, purchase
     value and gain, the name on the next line (after a custodian line for
     securities held abroad), running over pages. `holdingRows` reads them
     with the usual OCR slips repaired: "7" for "/", amounts split after a
     separator, and an I or O in a WKN (WKNs use neither). A holdings table
     makes a paper a statement whatever trades the report also lists; the
     model gets the report's head and the table, not the account pages
     before it. A WKN-only row for a security the master knows only by its
     ISIN is matched by name (exactly one confirmed entry, every significant
     word shared), which also places a report without a depot number.

## Operations

- Stage 1 changes what "Belege einlesen" books: a paper about a security
  outside the master is reported as a proposal, not booked. After the
  deploy, the review page may show proposals for securities sold before
  the first holdings snapshot — one "Aufnehmen" each.
- The master is per depot: the same ISIN in two depots is two entries.
- Stage 3 changes which reading stands where rules and model both add up:
  the model's. "Belege neu einlesen" applies it to papers read before.
  Papers the rules did not recognise cost one short model question each on
  the next run (only those with an ISIN or WKN and securities wording).
- Stage 2 reads statements on the next "Belege einlesen" (the run reads
  them after the settlements). A statement that lists only part of a depot
  (one page of a reporting, a sub-depot) counts as a snapshot day of the
  whole depot for the reconciliation, so a position it omits shows as a
  gap on that day — mark the paper "Für Depots ignorieren" if it is not a
  full statement. A statement whose depot could not be found waits under
  "Depotauszüge ohne Depot": take its security in, or give the depot its
  number.
