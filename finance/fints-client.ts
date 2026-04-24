/**
 * Thin facade over `lib-fints` for the finance module.
 *
 * Responsibilities:
 *   - load a finance_bankcontact row (with encrypted credentials) and
 *     decrypt the PIN on the way into the FinTS dialog;
 *   - expose a single `runSynchronize()` that works both ways: start a
 *     fresh sync dialog, or resume one that was suspended by a TAN
 *     challenge on the previous call;
 *   - map the boolean-flag-heavy lib-fints `ClientResponse` into our
 *     state-discriminated `DialogResult` so callers (statements
 *     endpoint, sync cron) can switch on a single field;
 *   - retry network-level failures with a small exponential backoff;
 *     PIN and dialog errors (e.g. FinTS code 9910 = wrong PIN) do NOT
 *     retry — the user has to fix credentials first.
 *
 * Statement / balance fetching and the specialised `…WithTan` paths
 * for those come in Etappe 3 — this module only handles the
 * synchronize dialog for now.
 *
 * Architecture: docs/finance-fints-integration.md §2.
 */

import { eq } from "drizzle-orm";
import {
  FinTSClient,
  FinTSConfig,
  type BankingInformation,
  type BankAnswer,
} from "lib-fints";
import { secret } from "encore.dev/config";

import db from "../db/database";
import { financeBankcontact } from "../db/schema";
import { decryptCredentials } from "./encryption";
import type { DialogResult, SyncOptions } from "./types";

console.log("[boot] finance/fints-client.ts: all imports resolved");

// Product registration with ZKA (Deutsche Kreditwirtschaft) is mandatory
// per PSD2. Dev / CI defaults let tests run without registering; prod
// deployments MUST set both secrets to real ZKA-issued values.
const productId = secret("FinanceFintsProductId");
const productVersion = secret("FinanceFintsProductVersion");

const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = [2_000, 4_000];

/** Subset of lib-fints surface the wrapper uses — lets tests swap the constructor without module-level mocking. */
export interface FintsClientSurface {
  synchronize(): Promise<import("lib-fints").SynchronizeResponse>;
  synchronizeWithTan(
    tanReference: string,
    tan?: string,
  ): Promise<import("lib-fints").SynchronizeResponse>;
  selectTanMethod(id: number): unknown;
  config: { bankingInformation: BankingInformation };
}

/** Constructor shape the wrapper needs; the default uses `lib-fints`. */
export type FintsClientFactory = (config: FinTSConfig) => FintsClientSurface;

const defaultFactory: FintsClientFactory = (config) =>
  new FinTSClient(config) as unknown as FintsClientSurface;

interface RunOptions extends SyncOptions {
  /** Test seam: override the FinTSClient constructor. */
  clientFactory?: FintsClientFactory;
  /** Test seam: sleep function (for deterministic backoff testing). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs a FinTS synchronize dialog for the given bankcontact.
 *
 * Fresh path:  `opts = {}` (or only the test seams)
 * Resume path: pass `tanReference`, `bankingInformation`, and
 *              `tanAnswer` (undefined is legit for decoupled TAN).
 */
export async function runSynchronize(
  bankcontactId: number,
  opts: RunOptions = {},
): Promise<DialogResult> {
  const bankcontact = await loadBankcontact(bankcontactId);
  const pin = bankcontact.credentials_encrypted
    ? decryptCredentials(bankcontact.credentials_encrypted)
    : "";

  const factory = opts.clientFactory ?? defaultFactory;
  const sleep = opts.sleep ?? defaultSleep;

  const isResume = typeof opts.tanReference === "string"
    && !!opts.bankingInformation;

  return runWithRetry(async () => {
    const config = isResume
      ? FinTSConfig.fromBankingInformation(
          productId(),
          productVersion(),
          opts.bankingInformation as unknown as BankingInformation,
          bankcontact.login,
          pin,
          bankcontact.tan_method ? parseInt(bankcontact.tan_method, 10) : undefined,
        )
      : FinTSConfig.forFirstTimeUse(
          productId(),
          productVersion(),
          bankcontact.server_url,
          bankcontact.blz,
          bankcontact.login,
          pin,
        );

    const client = factory(config);

    if (!isResume && bankcontact.tan_method) {
      client.selectTanMethod(parseInt(bankcontact.tan_method, 10));
    }

    const response = isResume
      ? await client.synchronizeWithTan(opts.tanReference!, opts.tanAnswer)
      : await client.synchronize();

    return mapResponse(response, client.config.bankingInformation);
  }, sleep);
}

// -----------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------

async function loadBankcontact(
  id: number,
): Promise<typeof financeBankcontact.$inferSelect> {
  const rows = await db
    .select()
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`finance_bankcontact ${id} not found`);
  }
  return row;
}

/**
 * Maps a lib-fints ClientResponse to our DialogResult. See
 * docs/finance-fints-integration.md §2.3 for the code table —
 * non-zero first bankAnswer.code becomes errorCode when
 * success=false.
 */
function mapResponse(
  response: {
    success: boolean;
    requiresTan: boolean;
    tanChallenge?: string;
    tanReference?: string;
    tanMediaName?: string;
    bankAnswers: BankAnswer[];
  },
  bankingInformation: BankingInformation,
): DialogResult {
  if (response.requiresTan) {
    return {
      state: "tan-required",
      bankingInformation: bankingInformation as unknown as Record<string, unknown>,
      tanChallenge: response.tanChallenge,
      tanReference: response.tanReference,
      tanMediaName: response.tanMediaName,
    };
  }
  if (response.success) {
    return {
      state: "idle",
      bankingInformation: bankingInformation as unknown as Record<string, unknown>,
    };
  }
  // success=false: pick the first non-zero bank answer as the error
  const first = response.bankAnswers.find((a) => a.code !== 0)
    ?? response.bankAnswers[0];
  return {
    state: "error",
    errorCode: first ? String(first.code) : "unknown",
    errorMessage: first?.text ?? "FinTS dialog failed",
  };
}

/**
 * Retries the inner function on transport-level exceptions (network
 * errors, timeouts). Dialog-level failures — signalled via
 * DialogResult with state="error" — are NOT retried; the caller sees
 * them on the first try.
 */
async function runWithRetry(
  fn: () => Promise<DialogResult>,
  sleep: (ms: number) => Promise<void>,
): Promise<DialogResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }
  }
  // Budget exhausted — surface as an "error" DialogResult rather than
  // a thrown exception, so callers can treat transport failures
  // uniformly with dialog failures.
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return {
    state: "error",
    errorCode: "transport",
    errorMessage: `FinTS transport error after ${MAX_RETRIES + 1} attempts: ${msg}`,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
