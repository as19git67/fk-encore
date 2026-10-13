# Stage plan: asynchronous receipt recognition with automatic cash transaction

## Goal & UX

Today the receipt photo blocks the entry form for up to **130 s** while the
`receipt-ocr-service` synchronously extracts amount/date/line items
(`extractReceiptOcr` in `TransactionNewView.vue:200`). That has to go.

**Desired flow:**

1. Photograph the receipt → the receipt image is stored as a document, the user
   is free again immediately. **No transaction is created at this point.**
2. The receipt recognition (core OCR + line items) runs **in the background**.
3. **As soon as the metadata is available**, a cash transaction is created
   **fully automatically** — **without approval and without a separate review
   step** — already filled with amount/date/store/items and linked to the
   receipt.
4. The user is informed via a realtime notification. From then on the
   transaction is a **completely normal, editable cash booking**: he can correct
   it at any time via the existing edit function — but that is voluntary and
   not a forced step.

## Architecture decision

Variant **B** (background pipeline, no up-front confirmation step). The
transaction is created **only once metadata exists** — that is, by the
background worker after successful OCR, not when the photo is taken — and
**fully automatically, without approval and without a dedicated
review/confirmation flow**. A regular cash transaction is created; a later
correction goes through the normal transaction editing, not through a separate
review UI.

### Consequence of this decision (big advantage)

Because the transaction **always** already has a real amount, the two biggest
complexities of the original idea disappear:

- **No placeholder `amount`** → the lock `amount === "0.00"`
  (`transactions.ts:493`) is a non-issue; we can use the regular create path.
- **No balance exclusion** needed → there is never a pending transaction that
  could distort account balance/reports.

### Existing building blocks (to be reused)

| Building block | Location | Role |
| --- | --- | --- |
| Receipt upload + background scan | `documents/documents.ts` (`receipt-capture`), `scan-worker.ts`, `document-ops.ts` | Stores the document, triggers processing |
| Realtime events | `finance/document-match.service.ts:104` (`realtime.publishEvent`, `receipt.enriched`) | Notification to the user |
| Transaction↔document link | `finance_transaction.receipt_document_id` (`db/schema.ts:1500`) | The link already exists |
| Enrichment diff | `computeReceiptEnrichment` (`document-match.service.ts:57`) | Diff receipt ↔ transaction for review |
| receipt-ocr-service | `receipt-ocr-service/main.py`, client `documents/receipt-ocr-client.ts` | Core OCR + items |

### What remains open: the "no amount recognized" case

If the OCR does not deliver a reliable amount, **no** transaction should be
created automatically (otherwise a wrong booking would end up in the ledger).
Instead: mark the document as "recognized but incomplete" and notify the user
so that he books manually. See stage 4.

---

## Stages

Each stage is independently runnable & testable. **Tests are mandatory before
every push** (`npm run test`, all green). For new/renamed migrations, always
maintain `db/migrations/postgres/meta/_journal.json` as well.

### Stage 1 — Data model

**Goal:** Persistence of the structured extraction + idempotency anchor +
selected account.

- **Separate table `document_receipt_extraction`** (decided): keeps
  amount/date/store/items/confidence out of the lean `documents` row. 1:1 with
  the document.
- **Persist the selected cash account:** the account selected when taking the
  photo (stage 2) must be preserved until the later background booking —
  column `receipt_account_id` on the document (or on the extraction/capture
  row), mandatory for the auto-booking path.
- Idempotency: ensure that at most **one** auto-created transaction is created
  per receipt (the worker is at-least-once). Variant: partial unique index on
  `finance_transaction.receipt_document_id` for auto-created rows, or a marker
  `receipt_transaction_id` on the document.
- Status marker on the document for the OCR progress
  (`receipt_ocr_state: 'pending' | 'booked' | 'incomplete' | 'failed'`), so
  that notification & UI know the state.
- Drizzle migration under `db/migrations/postgres/`, extend `_journal.json`.

**Done:** Schema migrated, tests green, no behavior change.

### Stage 2 — Decouple capture (only store, do not recognize)

**Goal:** The photo no longer blocks; OCR moves to the background.

- The `receipt-capture` path stays: store the image as a document (fast, 201)
  and trigger background processing. The synchronous `extractReceiptOcr` call
  is removed from the capture flow.
- **Account selection when taking the photo (decided):** the photo dialog lets
  the user select the cash account before taking the receipt. The selected
  `account_id` goes to the capture endpoint as a mandatory parameter and is
  persisted on the document (stage 1), so that the later background booking
  knows where to book. Pre-filling with the most recently used cash account is
  allowed, but the user can change it.

**Done:** Capture returns immediately; no synchronous OCR in the request any
more; the selected account is stored.

### Stage 3 — Background OCR in the worker

**Goal:** Recognition runs asynchronously and persists the result.

- In the document scan pipeline (`scan-worker.ts` / `document-ops.ts`), call
  `receipt-ocr-client` for receipts (mime/priority): `extractReceipt` +
  `extractReceiptItems`.
- Write the result into the extraction persistence (stage 1), set the document
  status to the matching `receipt_ocr_state`.

**Done:** After capture, the structured OCR fields are available on the
document.

### Stage 4 — Automatic booking from metadata

**Goal:** The cash transaction is created from the OCR result.

- **Reliable amount = `> 0 and <= 999` (decided):** automatic booking happens
  only in this range. `amount <= 0` or `> 999` counts as not reliable → no
  auto-booking.
- If a reliable amount is available: create the cash transaction via the
  regular create path on the selected `receipt_account_id` — `amount`,
  `booking_date`, `counterparty` (=store), `purpose` (=items note),
  `receipt_document_id` set; status `booked`.
- **Booking date (decided):** recognized receipt date, fallback today, and
  **never newer than today**. "Today" is the user's *local* view, not server
  UTC — so use the date-only helpers from `frontend/src/utils/dateFormat.ts`
  (`toLocalIsoDate`/`parseLocalDate`) or implement the clamping on the server
  such that a receipt taken on the same day is not wrongly rejected as
  "tomorrow" because of a UTC shift (mind the timezone frontend↔server).
- If there is **no reliable** amount: create **no** transaction, document
  status `incomplete`, notification "Beleg erkannt — Betrag bitte ergänzen"
  (receipt recognized — please add the amount).
- If the OCR service is **down**: defer/retry the job (like the existing LLM
  backoff logic in the worker), no failure.
- Idempotent via the anchor from stage 1.

**Done:** A successful OCR automatically produces a correct cash transaction;
failure/incomplete paths tested.

### Stage 5 — Realtime notification

**Goal:** A single notification points out that a new booking exists — nothing
more. No inbox, no badge, no review setup.

- New event analogous to `receipt.enriched`:
  `receipt.booked` `{ transaction_id, document_id, amount, store }`.
- Frontend: **one** notification "Neue Buchung aus Beleg" (new booking from
  receipt) via the existing notification mechanism. Tapping it leads to the
  normal transaction view — as a convenient jump, not as a mandatory step.
- Special case "no amount recognized" (stage 4): likewise only one
  notification "Beleg erkannt — Betrag bitte ergänzen", which leads to manual
  entry.

**Done:** Exactly one notification per receipt result reaches the client.

### Stage 6 — Rebuild the frontend capture flow

**Goal:** No synchronous waiting any more.

- `TransactionNewView.vue`: replace the synchronous
  `extractReceiptOcr`/`extractReceiptItems` with the decoupled capture
  (stage 2). After the photo the user returns immediately; no 130 s blockage.
- Entry point for pure receipt photographing (without having to go into the
  form right away), since the transaction is created automatically anyway.

**Done:** The photo no longer blocks the UI; manual entry is still possible.

### Stage 7 — Make the receipt visible on the finished transaction

**Goal:** No separate review/confirmation flow — only transparency.

- In `TransactionDetailView`, show the linked receipt + recognized items
  (read-only link). Correction happens via the **existing** editing of a cash
  transaction — no separate "confirm/accept" mechanism.
- Optional: discreet marker "aus Beleg erkannt" (recognized from receipt) + low
  `ocr_confidence` as a hint, but without forcing an action.

**Done:** Receipt/items can be viewed on the transaction; correction only via
the normal edit path, no extra review.

### Stage 8 — Cleanup, docs, migration

- Deprecate/remove dead synchronous OCR endpoints (`/documents/receipt-ocr`,
  `/documents/receipt-ocr-items`) as soon as stage 6 replaces them.
- Update docs (`documentation/finance-frontend.md`,
  `finance-tagging-and-ai.md`).
- End-to-end test of the whole flow.

---

## Decisions made

1. **Persistence of the extraction:** separate table
   `document_receipt_extraction`.
2. **Account selection:** the user selects the cash account **when taking the
   photo**; the selected account is persisted on the document and controls the
   later background booking.
3. **Threshold "reliable amount":** book automatically only with
   `amount > 0 and <= 999`; otherwise `incomplete` + notification.
4. **Booking date:** recognized receipt date, fallback today, never newer than
   today — with correct timezone handling frontend↔server (local "today").
