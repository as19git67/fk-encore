# Exemption orders and expected capital income (Freistellungsaufträge)

Issue #1549. Every bank withholds tax on capital income unless an
exemption order (Freistellungsauftrag) covers it, and the household may
hand out at most the yearly saver's allowance (Sparerpauschbetrag) across
all its banks. The app knows the accounts, the depots, the dividend and
tax settlements and the bank statements in the document store; it does not
know how the allowance is distributed, nor whether that distribution
matches the income each bank will actually pay. This plan adds both, and
a comparison that says where the allowance is wasted and where tax is
withheld for nothing.

## Goal

One page under Finanzen › Freistellungsaufträge that answers, for a tax
year: which bank holds which order, whether the sum fits the allowance,
how much interest, dividends and Vorabpauschale each bank will pay this
year (received so far plus what is still expected), where the order falls
short or runs over, and how the allowance should be redistributed. Every
number names the statements, settlements and bookings it comes from.

## Decisions

| Question | Decision |
|---|---|
| Where it lives | In the finance service (`finance/exemption-orders.ts`), page `frontend/src/views/finance/ExemptionOrdersView.vue`. Orders are personal data: read and changed with `finance.view` by the user who owns them; `finance.admin` sees everyone's. No new permission. |
| Whose allowance | The tax household, not the user account: the user's subject persons (`user_subject_persons`) with `relation_kind` `self` and `spouse`, joint when `user_assessment_settings` says `zusammen` for the year (the same rule `documents/tax-form-values.ts` uses). An order carries `owner` `self` / `spouse` / `joint`; a joint order counts against the joint allowance, a single one against its person's half. A household without a spouse has only `self`. |
| The allowance | `finance_saver_allowance` (valid_from_tax_year, single_cents, joint_cents), seeded with 2009: 801 / 1 602 € and 2023: 1 000 / 2 000 €. The law changes it; the code never carries the number. Admins can add a row (`finance.admin`); the page shows the row in force for the chosen year. |
| What a bank is | `finance_exemption_order` names its bank with `bank_name` and an optional `bankcontact_id` (`finance_bankcontact` is global and has no owner; a manual account has no bank at all, so the name is the key the user sees). The accounts that belong to that bank are listed in `finance_exemption_order_account` (giro, Tagesgeld, Festgeld, depot) — the income forecast sums over those accounts. Accounts of a bank contact are preselected when the contact is chosen. |
| The order | `finance_exemption_order`: user_id, bank_name, bankcontact_id, owner, amount_cents, valid_from_tax_year, valid_to_tax_year (null = open), note, optional `document_id` for the bank's confirmation (the user picks it from the documents; no matcher — a confirmation is one letter, not a stream). History is the rows themselves: a change for a new year is a new row with the old one closed at the previous year. |
| Interest from statements | Stage 2. A bank statement that the depot reader rejects as `account_statement` today (`finance/depot-settlement-reader.ts`) is handed to a new reader instead of dropped: `finance/interest-statement-extract.ts` (pure: patterns for Zinsgutschrift, Habenzinsen, Zinssatz, Zinsperiode, Kapitalertragsteuer, "Freistellungsauftrag" used, year-end totals; the LLM reads the rest through `extractInterestStatement` in `finance/llm-client.ts`; every value passes the same plausibility checks whichever found it — the pattern of `forecast-statements-extract.ts`). Readings go to `finance_interest_reading` with the quote and page they were read from. |
| No double counting | A reading on an account that FinTS books (`finance_transaction` with BTC subfamily `INTR`, or a purpose matching Zinsen/Habenzinsen, same account, same amount, ±7 days of the period end) links to that booking (`transaction_id` on the reading) and the booking is the realised figure; the reading only contributes its rate and period. Without a booking the reading itself is realised interest. |
| Interest rate | From the newest reading of the account (`rate_bp`) first; a manual rate on the account as fallback (`finance_account.interest_rate_bp`, `interest_rate_note`), and nothing when both are missing — then the page says the projection is incomplete rather than guessing. |
| Dividends and Vorabpauschale | From `finance_depot_transaction`: `dividend` settlements of the year per depot account are realised; still expected is last year's payout of each ISIN still held in the months not yet passed (`finance/depot-derivation.ts` knows the holdings). A `tax` booking from an accumulation notice (Vorabpauschale, January) is realised income for the allowance; nothing is projected for next January. |
| Comparison | Per bank and year: order vs. expected income → unused allowance or expected overshoot (× 26.375 % plus church tax as the tax that will be withheld). The proposal distributes the allowance in proportion to expected income, in steps of 10 €, capped at the total; a bank without an order gets one proposed only when its expected income exceeds 10 €. The proposal is shown, never applied by itself. |
| Cross-check | The tax actually withheld per bank: from year-end statements (stage 2 readings), from `tax` settlements, and from the Jahressteuerbescheinigung the tax worksheet already reads (`document_tax_value` fields `kapitalertragsteuer` and `sparer_pauschbetrag` of kind `jahressteuerbescheinigung`, matched to the bank by sender). A bank whose certificate says more allowance was used than the order allows is flagged. |
| Assistant | Stage 5: `exemption_orders(year)` and `capital_income_forecast(year)` as read tools in `assistant/tools/exemption-orders.ts`, a bench case each in `assistant/bench/cases.ts`; the tax worksheet lists the household's orders under Anlage KAP as a note, not a value. |

## Stages

1. **Orders and allowance.** Migration 0263: `finance_saver_allowance`
   (seeded), `finance_exemption_order`, `finance_exemption_order_account`.
   `finance/exemption-orders.ts`: CRUD under `/finance/exemption-orders`,
   `GET /finance/exemption-orders/summary?year=` (the household's
   allowance for the year, orders by bank and owner, the sum, over- or
   under-allocation). The household rule shared with the documents module
   (`taxHouseholdFor(userId, year)` in `finance/tax-household.ts`, reading
   `user_subject_persons` and `user_assessment_settings` through
   `~encore/clients`). Page Finanzen › Freistellungsaufträge with
   `PageLayout`, year in `route.query`, tiles (allowance, sum of orders,
   remaining), the table per bank and an edit dialog (`dialog-md`) with
   bank, owner, amount, validity, accounts, confirmation document. Entry in
   `config/modules.ts` under Finanzen.
2. **Interest from bank statements.** `finance/interest-statement-extract.ts`
   with tests on synthetic texts, `extractInterestStatement` in
   `finance/llm-client.ts` (and the `/json-prompt` fields it asks for),
   migration 0264: `finance_interest_reading` (document_id, account_id or
   iban and bank_name when no account matches, period_from, period_to,
   interest_cents, rate_bp, tax_withheld_cents, allowance_used_cents,
   year_total_cents, method regex|llm|user, status proposed|accepted|
   rejected, transaction_id, quote, page). The reader runs where
   `readDepotPaper` runs after classify (`documents/document-ops.ts`) and
   on the existing rescan, keeps the rejection reason for anything that is
   not a statement, and matches the account by IBAN first, then by the
   accounts of the bank's order. Endpoints to accept, reject and correct a
   reading; the booking link per the no-double-counting rule.
3. **Expected income per bank.** `finance/capital-income.ts` as pure
   functions over the year's bookings, settlements and readings:
   realised interest (bookings first, readings without a booking second),
   projected interest (balance × rate × remaining fraction of the year,
   per account), realised and expected dividends, Vorabpauschale,
   tax withheld so far — each figure with its sources (booking ids,
   settlement ids, reading ids). `interest_rate_bp` on `finance_account`
   (migration 0265) with the field in the account dialog.
   `GET /finance/exemption-orders/forecast?year=` returns the figures per
   bank; the page shows them in the table next to the order, and a
   drawer per bank lists the sources with links to the documents and
   bookings.
4. **Comparison and proposal.** `finance/exemption-proposal.ts` (pure,
   tested): delta per bank, tax expected to be withheld, the proposed
   distribution; `GET /finance/exemption-orders/proposal?year=`. The
   cross-check against `document_tax_value` of the household's
   Jahressteuerbescheinigungen and against the year-end readings. The
   page gets the proposal column and a "Vorschlag übernehmen" action that
   fills the edit dialogs, one bank at a time, and the warnings (sum over
   the allowance, certificate over the order, projection incomplete).
5. **Assistant and worksheet.** The two read tools, their bench cases,
   the note under Anlage KAP in the tax worksheet, and the entry in
   `CLAUDE.md`'s list of plans marked done.

## Open questions

- Fixed-term deposits pay at maturity, not per year; a reading with a
  period that ends next year is expected income of next year. Stage 3
  attributes interest to the year the period ends in, which is what the
  bank's certificate will do; the plan notes it so nobody "fixes" it.
- A joint account at a bank where only one spouse holds an order: the
  income is counted against that bank's order whoever owns it, since the
  bank does the same. Whether the app should warn about the mismatch is
  decided once the first real household shows one.
- Church tax: the rate differs by state (8 or 9 %) and the app has no
  field for it; stage 4 uses 26.375 % without church tax and says so on
  the page. A field on the household settings can follow if the number
  matters.
