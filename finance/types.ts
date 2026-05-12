/**
 * Shared types for the finance module.
 *
 * Kept deliberately free of database specifics — Drizzle row types live
 * in db/schema.ts. This module's job is to name the concepts that flow
 * between the FinTS wrapper, endpoint handlers, and tests.
 */

console.log("[boot] finance/types.ts: all imports resolved");

/**
 * State of an in-flight FinTS dialog, derived from the lib-fints
 * ClientResponse flags (success / requiresTan).
 */
export type FintsDialogState =
  | "idle"           // dialog finished cleanly, results available
  | "tan-required"   // waiting for user TAN / decoupled approval
  | "error";         // dialog failed, errorCode/errorMessage populated

/**
 * Uniform return shape of the fints-client wrapper. Fields are
 * discriminated by `state`:
 *   - state="idle":          bankingInformation + client set, errorCode null
 *   - state="tan-required":  tanChallenge + bankingInformation set
 *   - state="error":         errorCode + errorMessage set
 */
export interface DialogResult {
  state: FintsDialogState;
  /** Full lib-fints banking info snapshot, persisted in finance_tan_session.banking_information for the resume path. */
  bankingInformation?: Record<string, unknown>;
  /**
   * Only set when state="idle". The still-open FinTS client the
   * caller can use to run `getAccountStatements` / `getAccountBalance`
   * without re-authenticating. Not serialisable — consumed in-process
   * only. Typed as `unknown` to avoid circular imports; casts live in
   * `fints-client.ts`.
   */
  client?: unknown;
  /** Set when state="tan-required". Human-readable prompt from the bank. */
  tanChallenge?: string;
  /** Set when state="tan-required". Opaque lib-fints handle for the continuation call. */
  tanReference?: string;
  /** Name of the selected TAN medium (pushTAN device, etc.), set when state="tan-required" and the bank identified one. */
  tanMediaName?: string;
  /**
   * Set when state="tan-required" and the bank's challenge was a
   * photoTAN / Flicker-TAN matrix. Image is base64-encoded for JSON
   * transport; the UI builds `data:${tanPhotoMime};base64,${tanPhotoBase64}`
   * and feeds it to an <img>.
   */
  tanPhotoMime?: string;
  tanPhotoBase64?: string;
  /** Set when state="error". First non-zero bankAnswers code, e.g. "9910" for wrong PIN. */
  errorCode?: string;
  /** Set when state="error". Human-readable reason (bankAnswers[0].text or network/parse failure). */
  errorMessage?: string;
}

/**
 * Options passed into the wrapper's entry point. Either start fresh
 * (both fields undefined) or resume an open TAN challenge.
 */
export interface SyncOptions {
  /** The tanReference returned by a previous "tan-required" call. */
  tanReference?: string;
  /** User-entered TAN. Undefined is legitimate for decoupled TAN methods. */
  tanAnswer?: string;
  /** Banking info snapshot persisted on the previous "tan-required" turn. */
  bankingInformation?: Record<string, unknown>;
}

/**
 * Normalised FinTS transaction row, ready for INSERT into
 * finance_transaction. `amount` stays a string to avoid float drift.
 */
export interface FintsTransactionData {
  bookingDate: string;        // YYYY-MM-DD
  valueDate: string | null;
  amount: string;             // signed decimal, always 2 decimal places
  currency: string;
  purpose: string | null;
  counterparty: string | null;
  counterpartyIban: string | null;
  /** BIC of the counterparty. */
  counterparty_bic: string | null;
  /** Bank ID (BLZ) of the counterparty. */
  counterparty_bank_id: string | null;
  /** SEPA End-to-End reference (EREF). */
  end_to_end_ref: string | null;
  /** SEPA Mandate reference (MREF) for direct debits. */
  mandate_ref: string | null;
  /** SEPA Creditor identifier (CRED / CI). */
  creditor_id: string | null;
  /** Abweichender Auftraggeber (ABWA). */
  originator_name: string | null;
  /** Abweichender Zahlungsempfänger (ABWE). */
  recipient_name: string | null;
  /** ISO Bank Transaction Code — Domain (MT940 funds-code char;
   *  CAMT: BkTxCd/Domn/Cd or credit/debit indicator). */
  funds_code: string | null;
  /** ISO Bank Transaction Code — Family (MT940 GVC e.g. "NTRF", "RCDT";
   *  CAMT: BkTxCd/Domn/Fmly/Cd). Formerly gv_code. */
  transaction_type: string | null;
  /** ISO Bank Transaction Code — SubFamily (MT940 sub-field 61 code;
   *  CAMT: BkTxCd/Domn/Fmly/SubFmlyCd). */
  transaction_code: string | null;
  /** MT940 entry text ("Lastschrift", "Gutschrift", "Überweisung", …). */
  entry_text: string | null;
  /** Primanota number — bank-internal posting batch id. */
  prima_nota_no: string | null;
  /** lib-fints `bankReference` — the bank's internal booking-batch
   *  reference. Often missing; not used for idempotency (that's
   *  `dedupe_hash` over the canonical fields). Maps to the `bank_ref`
   *  column. */
  bankRef: string | null;
  /** Original currency/amount/exchange rate for credit card transactions
   *  booked in a foreign currency. All three are null for same-currency
   *  transactions and non-credit-card accounts. */
  originalAmount: string | null;
  originalCurrency: string | null;
  exchangeRate: string | null;
  /** Full lib-fints Transaction object, verbatim, for the raw JSONB column. */
  raw: Record<string, unknown>;
}

/**
 * Normalised holding from a depot portfolio response (MT535 / HKWPD).
 * Fields stay strings/nulls to avoid float drift — same convention as
 * FintsTransactionData.
 */
export interface FintsHoldingData {
  isin: string | null;
  wkn: string | null;
  name: string | null;
  amount: string | null;
  price: string | null;
  value: string | null;
  currency: string | null;
  acquisitionDate: string | null;
  acquisitionPrice: string | null;
}

/**
 * Result of fetching one bank account via the FinTS dialog. One
 * snapshot represents everything we learned about the account in the
 * current sync pass.
 */
export interface FintsAccountSnapshot {
  accountNumber: string;
  iban: string | null;
  /** Pre-mapped to the finance_account_kind enum; "sonstige" as fallback. */
  accountKind: string;
  currency: string;
  label: string;
  balance: { asOf: string; amount: string; currency: string } | null;
  transactions: FintsTransactionData[];
  /** Depot holdings from MT535 portfolio response. Only populated for
   *  accounts with accountKind === "depot". */
  holdings: FintsHoldingData[];
  /** Per-account soft errors — statements or balance needed an extra TAN, etc. */
  errors: string[];
}

export interface FetchResult {
  accounts: FintsAccountSnapshot[];
  /** True when any account was skipped due to a mid-flight TAN requirement. */
  partial: boolean;
  /**
   * Set when the per-account fetch hit a coupled-TAN (photoTAN,
   * chipTAN, …) that needs UI input. The caller's job: persist a
   * tan_session row with this info + the loop state, return
   * state="tan-required" to the API caller, and resume the loop in
   * tan-sessions.complete after the user submits.
   */
  pendingTan?: {
    /** lib-fints reference for getAccountStatementsWithTan(ref, tan). */
    tanReference: string;
    tanChallenge?: string;
    tanMediaName?: string;
    tanPhotoMime?: string;
    tanPhotoBase64?: string;
    /** The bank-side accountNumber that triggered the TAN. */
    accountNumber: string;
    /** Account numbers still queued behind the current one. */
    remainingAccountNumbers: string[];
  };
}
