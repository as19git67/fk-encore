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
 *   - state="idle":          bankingInformation set, errorCode/Message null
 *   - state="tan-required":  tanChallenge + bankingInformation set
 *   - state="error":         errorCode + errorMessage set
 */
export interface DialogResult {
  state: FintsDialogState;
  /** Full lib-fints banking info snapshot, persisted in finance_tan_session.banking_information for the resume path. */
  bankingInformation?: Record<string, unknown>;
  /** Set when state="tan-required". Human-readable prompt from the bank. */
  tanChallenge?: string;
  /** Set when state="tan-required". Opaque lib-fints handle for the continuation call. */
  tanReference?: string;
  /** Name of the selected TAN medium (pushTAN device, etc.), set when state="tan-required" and the bank identified one. */
  tanMediaName?: string;
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
