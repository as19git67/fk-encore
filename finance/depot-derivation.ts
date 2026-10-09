/**
 * Derive depot transactions from giro/clearing-account bookings
 * (Track AC Phase 2b — #439 / #428).
 *
 * The cheapest path to per-position transactions: many German banks
 * book Wertpapierabrechnungen ("WERTPAPIERABRECHNUNG", "DIVIDENDE",
 * "FONDSANTEILE") on the giro / Verrechnungskonto with ISO BTC
 * `funds_code='SECU'` and an ISIN in the purpose text. We use that to
 * synthesize `finance_depot_transaction` rows with `source='giro-derived'`.
 *
 * Match rules (strict — false positives are worse than misses here):
 *   - Candidate selection (`isSecuritiesCandidate`): when the bank gave us
 *     a real ISO BTC domain in `funds_code` we trust it and require
 *     `SECU`. Only camt.05x statements carry that; MT940 (HKKAZ) puts a
 *     single letter like "R" there and manual imports leave it null, so
 *     for those we fall back to requiring a hard identifier (ISIN or
 *     prefixed WKN) in the purpose / booking text instead.
 *   - Kind (`classifySecuTransaction`):
 *       transaction_code === 'DVCA'   → 'dividend'  (positive net_amount)
 *       transaction_code === 'CHRG'   → skip (custody fee, not a holding tx)
 *       the wording decides the direction where it has one: "Kauf" is a
 *       buy, "Verkauf" a sale, and a sign that contradicts it (money in,
 *       "Kauf") marks a transfer for a trade, not the trade → skip.
 *       Transfer wording (Überweisung, Übertrag, Dauerauftrag, …) without
 *       a trade's wording → skip. Without any wording the sign decides,
 *       but only money out becomes a buy (a savings plan's execution
 *       often says nothing); money in is a sale only when the bank or the
 *       text says so — the settlement account of a depot receives
 *       transfers far more often than it books unlabelled sales.
 *   - ISIN extracted via the ISO 6166 regex from the purpose field.
 *   - WKN extracted via a prefix-anchored "WKN …" pattern. Many German
 *     banks (e.g. MLP) book only WKNs and leave the ISIN field on the
 *     holdings side blank, so we need both identifiers.
 *   - The derived row is attached to a *depot* account on the same
 *     bankcontact whose holdings currently contain the matching ISIN or
 *     WKN. When multiple depots qualify, the one with the most recent
 *     matching holding wins.
 *   - When the purpose text has neither an ISIN nor a WKN-prefixed code
 *     (e.g. "SONNENOBST INC." with no identifier at all), fall back to matching
 *     the holding's own display name against the purpose text. Every
 *     significant word of the name (legal-form suffixes like "INC"/"AG"
 *     stripped) must appear in the purpose, and the match must be
 *     unambiguous — exactly one qualifying security across the
 *     bankcontact's depots — or we skip.
 *   - A position closed before the first holdings snapshot has no holding
 *     to match. Then the one depot on the bankcontact that already has
 *     transactions of the security (e.g. read from its settlement
 *     documents) takes the booking.
 *   - Unmatched SECU bookings are skipped silently (counted, not errored —
 *     re-running after the next sync may match).
 *
 * Idempotency: `dedupe_hash = "giro:<linked_transaction_id>"` and the
 * partial unique index `(account_id, dedupe_hash) WHERE dedupe_hash IS
 * NOT NULL` makes re-runs no-ops.
 */

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import db from "../db/database";
import {
  financeAccount,
  financeAccountHolding,
  financeDepotTransaction,
  financeTransaction,
} from "../db/schema";

console.log("[boot] finance/depot-derivation.ts: all imports resolved");

/** ISO 6166 ISIN: two letters + nine alphanumerics + one check digit. */
const ISIN_RE = /\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/;

/**
 * An ISIN after its label with spaces inside, as some booking texts print
 * it ("ISIN: AB1234 5678901"). Only taken when the check digit holds — the
 * spaces would otherwise let the pattern swallow neighbouring words.
 */
const SPACED_ISIN_RE = /\bISIN[.:\s]*((?:[A-Z0-9] ?){11}[0-9])(?![A-Z0-9])/;

/** ISO 6166 check digit: letters to numbers (A=10 … Z=35), then Luhn over the digits. */
export function isinChecksumValid(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return false;
  const digits = isin
    .split("")
    .map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55)))
    .join("");
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Extract the first ISIN appearing in a free-text field, or null. */
export function extractIsin(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(ISIN_RE);
  if (m) return m[0];
  const spaced = text.match(SPACED_ISIN_RE);
  if (!spaced) return null;
  const isin = spaced[1]!.replace(/ /g, "");
  return isinChecksumValid(isin) ? isin : null;
}

/**
 * German Wertpapierkennnummer: always 6 alphanumeric characters. The
 * shape alone is too generic (matches dates, amounts, fragments of
 * IBANs), so we require an explicit prefix to avoid false positives.
 * Banks spell that prefix several ways — "WKN 987654", "WKN: 987654",
 * "WKN/ISIN 987654/LU…", and (e.g. comdirect/Sparkasse Wertpapier-
 * abrechnungen) "WPKNR: SNN001" or "WP-KENNNR SNN001".
 */
const WKN_RE = /\b(?:WKN|WPKNR|WPK|WP-?KENN(?:NR|NUMMER)?)[.:\s/]+([A-Z0-9]{6})\b/i;

/** Extract the first prefixed WKN appearing in a free-text field, or null. */
export function extractWkn(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(WKN_RE);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Legal-form / share-class suffixes stripped before comparing a holding's
 * display name against free text — they carry no identifying signal and
 * would otherwise dilute the word match below (e.g. "AG" or "INC" showing
 * up in unrelated purposes).
 */
const NAME_SUFFIX_WORDS = new Set([
  "INC", "INCORPORATED", "CORP", "CORPORATION", "AG", "SE", "LTD", "LIMITED",
  "PLC", "CO", "COMPANY", "KGAA", "NV", "SA", "SPA", "GMBH", "HOLDING",
  "HOLDINGS", "GROUP", "CLASS", "ORD", "REG", "SHS", "COM",
]);

function nameWords(text: string): string[] {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0);
}

function coreNameWords(name: string): string[] {
  return nameWords(name).filter((w) => !NAME_SUFFIX_WORDS.has(w));
}

interface HoldingMatch {
  account_id: number;
  isin: string | null;
  wkn: string | null;
  name: string | null;
  currency: string | null;
}

/**
 * Fallback for bookings whose purpose text carries neither ISIN nor a
 * WKN-prefixed code (e.g. "SONNENOBST INC." with nothing else) — match by the
 * holding's own display name instead. Deliberately conservative: every
 * significant word of the holding's name must appear in the purpose text,
 * and the match must be unambiguous (exactly one qualifying security) or
 * we skip, per the "false positives are worse than misses" rule above.
 */
async function matchHoldingByName(
  bankcontactId: number,
  purpose: string | null | undefined,
): Promise<HoldingMatch | undefined> {
  if (!purpose) return undefined;
  const purposeWords = new Set(nameWords(purpose));
  if (purposeWords.size === 0) return undefined;

  const holdings = await db
    .select({
      account_id: financeAccountHolding.account_id,
      isin: financeAccountHolding.isin,
      wkn: financeAccountHolding.wkn,
      name: financeAccountHolding.name,
      currency: financeAccountHolding.currency,
    })
    .from(financeAccountHolding)
    .innerJoin(
      financeAccount,
      eq(financeAccount.id, financeAccountHolding.account_id),
    )
    .where(eq(financeAccount.bankcontact_id, bankcontactId))
    .orderBy(desc(financeAccountHolding.as_of));

  // Most-recent snapshot per distinct security (account + isin/wkn/name),
  // mirroring the "most recent as_of wins" rule used for identifier matches.
  const latestBySecurity = new Map<string, HoldingMatch>();
  for (const h of holdings) {
    const key = `${h.account_id}:${h.isin ?? h.wkn ?? h.name}`;
    if (!latestBySecurity.has(key)) latestBySecurity.set(key, h);
  }

  const matches = [...latestBySecurity.values()].filter((h) => {
    const core = coreNameWords(h.name ?? "");
    return core.length > 0 && core.every((w) => purposeWords.has(w));
  });

  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The one depot on this bankcontact that already has transactions of the
 * security (read from settlement documents, or derived earlier). Covers a
 * position closed before the first holdings snapshot. Ambiguous → none.
 */
async function matchDepotByTransactions(
  bankcontactId: number,
  isin: string | null,
  wkn: string | null,
): Promise<HoldingMatch | undefined> {
  const idMatches = [];
  if (isin) idMatches.push(eq(financeDepotTransaction.isin, isin));
  if (wkn) idMatches.push(eq(financeDepotTransaction.wkn, wkn));
  if (idMatches.length === 0) return undefined;
  const rows = await db
    .select({
      account_id: financeDepotTransaction.account_id,
      isin: financeDepotTransaction.isin,
      wkn: financeDepotTransaction.wkn,
      name: financeDepotTransaction.name,
      currency: financeDepotTransaction.currency,
    })
    .from(financeDepotTransaction)
    .innerJoin(financeAccount, eq(financeAccount.id, financeDepotTransaction.account_id))
    .where(and(eq(financeAccount.bankcontact_id, bankcontactId), or(...idMatches)))
    .orderBy(desc(financeDepotTransaction.executed_at));
  if (rows.length === 0 || new Set(rows.map((r) => r.account_id)).size > 1) return undefined;
  // The newest row with a name speaks for the security.
  const named = rows.find((r) => r.name) ?? rows[0]!;
  return {
    account_id: named.account_id,
    isin: rows.find((r) => r.isin)?.isin ?? null,
    wkn: rows.find((r) => r.wkn)?.wkn ?? null,
    name: named.name,
    currency: named.currency,
  };
}

/**
 * ISO 20022 BTC domain codes. Used to decide whether `funds_code` actually
 * carries usable Bank-Transaction-Code information — see
 * `hasUsableBtcDomain` below.
 */
const BTC_DOMAIN_CODES: ReadonlySet<string> = new Set([
  "ACMT", "CAMT", "CMDT", "DERV", "FORX", "LDAS",
  "PMET", "PMNT", "SECU", "TRAD", "XTND",
]);

/**
 * True when `funds_code` holds a real ISO BTC domain and we can therefore
 * trust it as the authoritative securities/non-securities signal.
 *
 * Only the CAMT (camt.05x) path ever fills this in: lib-fints sets
 * `fundsCode = bkTxCd.domainCode || creditDebitInd`. The MT940 path
 * (HKKAZ, what most German banks still deliver) parses subfield 4 of the
 * `:61:` line instead — a *single letter* such as "R" — and the manual
 * import path leaves it null. In those cases the field says nothing about
 * whether a booking is a Wertpapierabrechnung, so we must not gate on it.
 */
export function hasUsableBtcDomain(
  fundsCode: string | null | undefined,
): boolean {
  if (!fundsCode) return false;
  return BTC_DOMAIN_CODES.has(fundsCode.trim().toUpperCase());
}

/**
 * Decide whether a giro booking is worth examining as a possible
 * Wertpapierabrechnung.
 *
 * Two admissible routes, mirroring what the source data can tell us:
 *
 *   1. The bank gave us a real BTC domain → trust it completely. `SECU`
 *      qualifies, every other domain (PMNT, CAMT, …) is excluded. This
 *      keeps the original strict behaviour for camt-sourced bookings, so
 *      a rent payment that happens to quote an ISIN stays excluded.
 *   2. No usable BTC domain (MT940 single-letter code, or null) → fall
 *      back to the text, and require a hard security identifier: an ISIN
 *      or a prefixed WKN in the purpose or booking text. A booking that
 *      names neither is never considered on this route.
 *
 * Route 2 alone is not what creates a depot transaction — the caller
 * still has to match the extracted identifier against a holding that
 * actually exists on one of the bankcontact's depots, so a stray
 * ISIN-shaped token cannot conjure a position out of nothing.
 */
export function isSecuritiesCandidate(tx: {
  funds_code: string | null;
  purpose: string | null;
  entry_text?: string | null;
}): boolean {
  if (hasUsableBtcDomain(tx.funds_code)) {
    return tx.funds_code!.trim().toUpperCase() === "SECU";
  }
  const text = `${tx.purpose ?? ""}\n${tx.entry_text ?? ""}`;
  return extractIsin(text) !== null || extractWkn(text) !== null;
}

export type DerivedKind = "buy" | "sell" | "dividend";

/**
 * Classify a SECU-flagged giro transaction. Returns null when the row
 * should be skipped (e.g. custody fees or zero-amount oddities).
 */
export function classifySecuTransaction(tx: {
  amount: string;
  transaction_code: string | null;
  purpose?: string | null;
  entry_text?: string | null;
}): DerivedKind | null {
  const subFamily = tx.transaction_code?.toUpperCase() ?? "";
  if (subFamily === "CHRG") return null;
  if (subFamily === "DVCA") return "dividend";
  const n = Number(tx.amount);
  if (!Number.isFinite(n) || n === 0) return null;
  // Without the bank's code (MT940, manual import) the text decides. A
  // settlement account books more than trades: its fees, taxes on income
  // a fund kept, transfers — none of them a buy or a sale, even when the
  // text names the security.
  const text = `${tx.purpose ?? ""} ${tx.entry_text ?? ""}`;
  const bankSaysTrade = BANK_TRADE_CODES.has(subFamily);
  if (TRADE_TEXT_RE.test(text)) {
    // The wording's direction, where it has one. Money that came in with
    // "Kauf" on it is the transfer that pays for the purchase, not the
    // purchase; money out with "Verkauf" is no sale either.
    const sell = SELL_TEXT_RE.test(text);
    const buy = BUY_TEXT_RE.test(text);
    if (sell && !buy) return n > 0 ? "sell" : null;
    if (buy && !sell) return n < 0 ? "buy" : null;
    return n < 0 ? "buy" : "sell";
  }
  if (CHARGE_TEXT_RE.test(text)) return null;
  if (PAYOUT_TEXT_RE.test(text)) return n > 0 ? "dividend" : null;
  if (TRANSFER_TEXT_RE.test(text)) return null;
  if (n < 0) return "buy";
  // Money in without a word: a sale only on the bank's say-so.
  return bankSaysTrade ? "sell" : null;
}

/**
 * ISO BTC sub-families of a trade (camt only — MT940 puts the SWIFT type
 * such as "NMSC" here, which says nothing): a trade, a fund subscription,
 * a redemption.
 */
const BANK_TRADE_CODES: ReadonlySet<string> = new Set(["TRAD", "SUBS", "REDM"]);
/** Wording of a trade's booking: it decides over everything below. */
const TRADE_TEXT_RE = /wertpapierabrechnung|wertpapier-?kauf|wertpapier-?verkauf|\b(?:kauf|verkauf)\b|fondsanteile|ausf(?:ü|ue)hrung/i;
/** The trade's direction, when the text names one. */
const SELL_TEXT_RE = /verkauf/i;
const BUY_TEXT_RE = /(?<!ver)kauf/i;
/** Money moved onto or off the settlement account — a transfer, not a trade. */
const TRANSFER_TEXT_RE =
  /(?:ü|ue)berweisung|(?:ü|ue)bertrag|umbuchung|einzahlung|auszahlung|dauerauftrag|geldeingang|zahlungseingang/i;
/** Fees, charges and taxes a settlement account books besides trades. */
const CHARGE_TEXT_RE =
  /geb(?:ü|ue)hr|entgelt|spesen|verwaltungsverg|verg(?:ü|ue)tung|depotpreis|kontof(?:ü|ue)hrung|abschluss|steuer|vorabpauschale|thesaur/i;
/** A payout: dividend, distribution, interest on a bond. */
const PAYOUT_TEXT_RE = /dividende|aussch(?:ü|ue)ttung|ertr(?:ä|ae)g|zinsen|kupon/i;

export interface DerivationStats {
  /** Newly inserted rows. */
  derived: number;
  /** Securities bookings considered but skipped (no holding match, fee, …). */
  skipped: number;
  /** Bookings already covered by a prior derivation (dedupe hit). */
  duplicates: number;
  /** Bookings attached to a row a settlement document created first. */
  merged: number;
  /** Soft errors (per-tx insert failures). */
  errors: string[];
  /**
   * Bookings that passed `isSecuritiesCandidate` and were actually
   * examined. Zero here means nothing on this bankcontact looked like a
   * Wertpapierabrechnung at all — a different problem from "examined but
   * no holding matched", which the counters below separate out.
   */
  candidates: number;
  /** Skipped by `classifySecuTransaction` (custody fee, zero amount). */
  skipped_not_classified: number;
  /** No ISIN/WKN extractable and the name fallback found nothing. */
  skipped_no_identifier: number;
  /** Identifier found, but no holding on this bankcontact carries it. */
  skipped_no_holding: number;
}

/**
 * Walk securities-looking transactions on every account of the given
 * bankcontact and write `source='giro-derived'` rows into
 * finance_depot_transaction for the ones that match a known holding.
 */
/**
 * A row read from a settlement document that this booking confirms: same
 * depot, position and kind, executed within ±7 days, not yet linked to a
 * booking, with a net amount that agrees (or none). Returns its id.
 */
async function findDocumentRowForBooking(b: {
  accountId: number;
  isin: string | null;
  wkn: string | null;
  kind: DerivedKind;
  executedAt: string;
  net: number;
}): Promise<number | null> {
  const ids = [];
  if (b.isin) ids.push(eq(financeDepotTransaction.isin, b.isin));
  if (b.wkn) ids.push(eq(financeDepotTransaction.wkn, b.wkn));
  if (ids.length === 0) return null;
  const rows = await db
    .select({
      id: financeDepotTransaction.id,
      executed_at: financeDepotTransaction.executed_at,
      net_amount: financeDepotTransaction.net_amount,
    })
    .from(financeDepotTransaction)
    .where(
      and(
        eq(financeDepotTransaction.account_id, b.accountId),
        eq(financeDepotTransaction.kind, b.kind),
        eq(financeDepotTransaction.source, "document"),
        isNull(financeDepotTransaction.linked_transaction_id),
        or(...ids),
        sql`${financeDepotTransaction.executed_at} BETWEEN ${b.executedAt}::date - 7 AND ${b.executedAt}::date + 7`,
      ),
    );
  const target = Date.parse(`${b.executedAt}T00:00:00Z`);
  const fits = rows
    .filter((r) => {
      if (r.net_amount === null) return true;
      return Math.abs(Math.abs(Number(r.net_amount)) - Math.abs(b.net)) <= 0.011;
    })
    .sort(
      (x, y) =>
        Math.abs(Date.parse(`${x.executed_at.slice(0, 10)}T00:00:00Z`) - target) -
        Math.abs(Date.parse(`${y.executed_at.slice(0, 10)}T00:00:00Z`) - target),
    );
  return fits[0]?.id ?? null;
}

export async function deriveDepotTransactionsForBankcontact(
  bankcontactId: number,
): Promise<DerivationStats> {
  const stats: DerivationStats = {
    derived: 0,
    skipped: 0,
    duplicates: 0,
    merged: 0,
    errors: [],
    candidates: 0,
    skipped_not_classified: 0,
    skipped_no_identifier: 0,
    skipped_no_holding: 0,
  };

  // All accounts on this bankcontact — we look at giro/clearing txs and
  // attach derived rows back to a depot account on the same bankcontact.
  const accounts = await db
    .select({ id: financeAccount.id })
    .from(financeAccount)
    .where(eq(financeAccount.bankcontact_id, bankcontactId));
  if (accounts.length === 0) return stats;
  const accountIds = accounts.map((a) => a.id);
  /** Bookings a new row was derived from: their papers are read below. */
  const derivedBookings: number[] = [];

  const txs = await db
    .select({
      id: financeTransaction.id,
      account_id: financeTransaction.account_id,
      booking_date: financeTransaction.booking_date,
      value_date: financeTransaction.value_date,
      amount: financeTransaction.amount,
      currency_code: financeTransaction.currency_code,
      purpose: financeTransaction.purpose,
      counterparty: financeTransaction.counterparty,
      funds_code: financeTransaction.funds_code,
      entry_text: financeTransaction.entry_text,
      transaction_type: financeTransaction.transaction_type,
      transaction_code: financeTransaction.transaction_code,
    })
    .from(financeTransaction)
    .where(
      and(
        inArray(financeTransaction.account_id, accountIds),
        // Cheap SQL pre-filter; `isSecuritiesCandidate` below makes the
        // authoritative call. Either the bank flagged the booking SECU,
        // or the text mentions something identifier-shaped that is worth
        // running the precise regexes over.
        or(
          eq(financeTransaction.funds_code, "SECU"),
          sql`(
            coalesce(${financeTransaction.purpose}, '') || ' ' ||
            coalesce(${financeTransaction.entry_text}, '') || ' ' ||
            coalesce(${financeTransaction.counterparty}, '')
          ) ~* '([A-Z]{2}[A-Z0-9]{9}[0-9])|(WKN|WPKNR|WPK|WP-?KENN)'`,
        ),
      ),
    );

  for (const tx of txs) {
    if (!isSecuritiesCandidate(tx)) continue;
    stats.candidates++;

    const kind = classifySecuTransaction(tx);
    if (kind === null) {
      stats.skipped++;
      stats.skipped_not_classified++;
      continue;
    }

    const isin =
      extractIsin(tx.purpose) ??
      extractIsin(tx.entry_text) ??
      extractIsin(tx.counterparty);
    const wkn =
      extractWkn(tx.purpose) ??
      extractWkn(tx.entry_text) ??
      extractWkn(tx.counterparty);

    let holding: HoldingMatch | undefined;

    if (isin || wkn) {
      // Find a depot account on the same bankcontact whose holdings
      // include this ISIN or WKN. Pick the most recent snapshot to break
      // ties. We accept either identifier because some banks only fill in
      // WKN on the holdings side (or only ISIN on the booking side).
      const idMatches = [];
      if (isin) idMatches.push(eq(financeAccountHolding.isin, isin));
      if (wkn) idMatches.push(eq(financeAccountHolding.wkn, wkn));

      [holding] = await db
        .select({
          account_id: financeAccountHolding.account_id,
          isin: financeAccountHolding.isin,
          wkn: financeAccountHolding.wkn,
          name: financeAccountHolding.name,
          currency: financeAccountHolding.currency,
        })
        .from(financeAccountHolding)
        .innerJoin(
          financeAccount,
          eq(financeAccount.id, financeAccountHolding.account_id),
        )
        .where(
          and(
            eq(financeAccount.bankcontact_id, bankcontactId),
            or(...idMatches),
          ),
        )
        .orderBy(desc(financeAccountHolding.as_of))
        .limit(1);
    } else {
      // No ISIN and no WKN-prefixed code in the text (e.g. "SONNENOBST INC."
      // with nothing else) — fall back to matching the holding's own
      // display name against the purpose text.
      holding = await matchHoldingByName(bankcontactId, tx.purpose);
    }

    if (!holding && (isin || wkn)) {
      // A position sold before the first holdings snapshot has none — but
      // its settlement documents may already have put rows on a depot.
      holding = await matchDepotByTransactions(bankcontactId, isin, wkn);
    }

    if (!holding) {
      stats.skipped++;
      if (isin || wkn) stats.skipped_no_holding++;
      else stats.skipped_no_identifier++;
      continue;
    }

    // Build the row. Net amount on the giro side is the cash flow with
    // its original sign; gross_amount is the absolute value (the giro
    // booking already nets fees, so we don't try to split them out).
    const netSigned = Number(tx.amount);
    const gross = Math.abs(netSigned).toFixed(2);
    const net = netSigned.toFixed(2);
    const dedupeHash = `giro:${tx.id}`;

    // Prefer the value we actually extracted from the booking; fall
    // back to whatever the holding carries so the row always has the
    // best identifier we know about (UI filters per-position by isin
    // OR wkn, whichever is non-null on the holding).
    const rowIsin = isin ?? holding.isin;
    const rowWkn = wkn ?? holding.wkn;
    const executedAt = (tx.value_date ?? tx.booking_date).slice(0, 10);

    try {
      // Already merged into a row read from a settlement document on an
      // earlier run: that row carries the booking, not the giro hash.
      const [alreadyLinked] = await db
        .select({ id: financeDepotTransaction.id })
        .from(financeDepotTransaction)
        .where(eq(financeDepotTransaction.linked_transaction_id, tx.id))
        .limit(1);
      if (alreadyLinked) {
        stats.duplicates++;
        continue;
      }

      // A settlement document may have created the row before the booking
      // arrived (#1336, stage 4). Attach the booking to it instead of
      // deriving a second, poorer copy of the same trade.
      const docRow = await findDocumentRowForBooking({
        accountId: holding.account_id,
        isin: rowIsin,
        wkn: rowWkn,
        kind,
        executedAt,
        net: netSigned,
      });
      if (docRow !== null) {
        await db
          .update(financeDepotTransaction)
          .set({ linked_transaction_id: tx.id })
          .where(eq(financeDepotTransaction.id, docRow));
        stats.merged++;
        continue;
      }

      const inserted = await db
        .insert(financeDepotTransaction)
        .values({
          account_id: holding.account_id,
          isin: rowIsin,
          wkn: rowWkn,
          name: holding.name,
          kind,
          executed_at: executedAt,
          amount: null, // shares not known from a giro booking
          price: null,
          gross_amount: gross,
          fees: null,
          tax: null,
          net_amount: net,
          currency: tx.currency_code ?? holding.currency,
          source: "giro-derived",
          linked_transaction_id: tx.id,
          dedupe_hash: dedupeHash,
        })
        .onConflictDoNothing({
          target: [
            financeDepotTransaction.account_id,
            financeDepotTransaction.dedupe_hash,
          ],
          // Index is partial (WHERE dedupe_hash IS NOT NULL) so Postgres
          // needs the matching predicate in the ON CONFLICT clause.
          where: sql`${financeDepotTransaction.dedupe_hash} IS NOT NULL`,
        })
        .returning({ id: financeDepotTransaction.id });

      if (inserted.length > 0) {
        stats.derived++;
        derivedBookings.push(tx.id);
      } else {
        stats.duplicates++;
      }
    } catch (err) {
      stats.errors.push(
        `tx ${tx.id} (${rowIsin ?? rowWkn}): derivation insert failed: ` +
          ((err as Error).message ?? String(err)),
      );
    }
  }

  // Papers already linked to these bookings (by hand, or an accepted
  // suggestion) settle the new rows. Imported here, not at the top: the
  // enrichment's reader imports this module.
  if (derivedBookings.length > 0) {
    try {
      const { enrichDocumentsOfBookings } = await import("./depot-document-enrichment");
      await enrichDocumentsOfBookings(derivedBookings, { llm: "cache-only" });
    } catch (err) {
      stats.errors.push(`reading the papers of derived bookings failed: ${(err as Error).message ?? String(err)}`);
    }
  }

  return stats;
}
