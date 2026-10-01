/**
 * Rules and the language model, checked against each other (#1336).
 *
 * Pure functions, no database and no network:
 *
 *   parseLlmSettlement — validates what the model returned into the same
 *                        shape the rule-based parser produces.
 *   settlementChecks   — arithmetic and format checks one reading must pass:
 *                        gross ± fees ± taxes = net, quantity × price ≈
 *                        gross, the ISIN check digit, a plausible date.
 *   mergeSettlement    — one reading from both: fields both agree on are
 *                        taken as they are; where they disagree, the
 *                        reading whose figures add up wins. When neither
 *                        adds up and they disagree on something that
 *                        matters, the result is "unverified" — the caller
 *                        books nothing and asks the user.
 *
 * The rules are exact where they match and blind where a bank changed a
 * label; the model reads any layout but can misplace a digit without a
 * trace. The checks are what lets either one be trusted.
 */

import type { SettlementExtraction, SettlementKind } from "./depot-settlement-parser";

/** The fields a reading consists of, in the inspection view's order. */
export const MERGE_FIELDS = [
  "kind",
  "isin",
  "wkn",
  "name",
  "depotNumber",
  "executedAt",
  "quantity",
  "price",
  "gross",
  "fees",
  "tax",
  "net",
  "currency",
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

/** A reading without the parser's bookkeeping (markers, labels). */
export type SettlementValues = Pick<SettlementExtraction, Exclude<MergeField, "kind">> & {
  kind: SettlementKind | null;
};

export const EMPTY_SETTLEMENT: SettlementValues = {
  kind: null,
  isin: null,
  wkn: null,
  name: null,
  depotNumber: null,
  executedAt: null,
  quantity: null,
  price: null,
  gross: null,
  fees: null,
  tax: null,
  net: null,
  currency: null,
};

const AMOUNT_FIELDS: MergeField[] = ["quantity", "price", "gross", "fees", "tax", "net"];
/** Disagreeing on one of these changes what gets booked. */
const MATERIAL_FIELDS: MergeField[] = ["kind", "isin", "wkn", "executedAt", "quantity", "price", "gross", "fees", "tax", "net"];

// ----------------------------------------------------------------------
// Validating the model's answer
// ----------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.toLowerCase() !== "null" ? t : null;
}

/** Positive number from a number or a German/plain number string. */
function amount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.abs(v) : null;
  const s = str(v);
  if (!s) return null;
  const cleaned = s.replace(/[^\d,.-]/g, "");
  let normalized = cleaned;
  if (/,\d{1,8}$/.test(cleaned)) normalized = cleaned.replace(/\./g, "").replace(",", ".");
  else normalized = cleaned.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.abs(n) : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return s;
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (de) return `${de[3]}-${de[2]!.padStart(2, "0")}-${de[1]!.padStart(2, "0")}`;
  return null;
}

/**
 * Whether the model took the text for a settlement at all. null when it
 * did not say (an answer stored before the question was asked).
 */
export function parseLlmPaperVerdict(raw: Record<string, unknown>): boolean | null {
  const v = raw.is_settlement;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "ja" || t === "yes") return true;
    if (t === "false" || t === "nein" || t === "no") return false;
  }
  return null;
}

/** The model's JSON → a reading in the parser's shape; anything malformed becomes null. */
export function parseLlmSettlement(raw: Record<string, unknown>): SettlementValues {
  const kindRaw = str(raw.kind)?.toLowerCase();
  const kind: SettlementKind | null =
    kindRaw === "buy" || kindRaw === "sell" || kindRaw === "dividend" ? kindRaw : null;
  const isin = str(raw.isin)?.toUpperCase().replace(/\s/g, "") ?? null;
  const wkn = str(raw.wkn)?.toUpperCase().replace(/\s/g, "") ?? null;
  const depot = str(raw.depot_number)?.replace(/\D/g, "") ?? null;
  const net = amount(raw.net);
  const currency = str(raw.currency)?.toUpperCase() ?? null;
  return {
    kind,
    isin: isin && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin) ? isin : null,
    wkn: wkn && /^[A-Z0-9]{6}$/.test(wkn) ? wkn : null,
    name: str(raw.name),
    depotNumber: depot && depot.length >= 5 ? depot : null,
    executedAt: isoDate(raw.executed_at),
    quantity: amount(raw.quantity),
    price: amount(raw.price),
    gross: amount(raw.gross),
    fees: amount(raw.fees),
    tax: amount(raw.tax),
    // Signed like the rule-based reading: money out for a buy.
    net: net === null ? null : kind === "buy" ? -net : net,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : currency === "€" ? "EUR" : null,
  };
}

// ----------------------------------------------------------------------
// Checks
// ----------------------------------------------------------------------

export type CheckName = "net_equation" | "quantity_price" | "isin_checksum" | "date_plausible";
export type CheckResult = "ok" | "failed" | "skipped";

export interface SettlementCheck {
  name: CheckName;
  result: CheckResult;
  /** What was compared, for the inspection view. */
  detail: string | null;
}

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

function close(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

const f2 = (n: number) => n.toFixed(2);

export function settlementChecks(v: SettlementValues, today = new Date()): SettlementCheck[] {
  const checks: SettlementCheck[] = [];

  // gross ± fees ± taxes = net
  if (v.gross !== null && v.net !== null && v.kind) {
    const fees = v.fees ?? 0;
    const tax = v.tax ?? 0;
    const expected = v.kind === "buy" ? v.gross + fees + tax : v.gross - fees - tax;
    const ok = close(expected, Math.abs(v.net), 0.05);
    checks.push({
      name: "net_equation",
      result: ok ? "ok" : "failed",
      detail:
        v.kind === "buy"
          ? `${f2(v.gross)} + ${f2(fees)} + ${f2(tax)} = ${f2(expected)} ↔ ${f2(Math.abs(v.net))}`
          : `${f2(v.gross)} − ${f2(fees)} − ${f2(tax)} = ${f2(expected)} ↔ ${f2(Math.abs(v.net))}`,
    });
  } else {
    checks.push({ name: "net_equation", result: "skipped", detail: null });
  }

  // quantity × price ≈ gross (prices are rounded; allow 0.5 % or 5 cents)
  if (v.quantity !== null && v.price !== null && v.gross !== null) {
    const product = v.quantity * v.price;
    const ok = close(product, v.gross, Math.max(0.05, v.gross * 0.005));
    checks.push({
      name: "quantity_price",
      result: ok ? "ok" : "failed",
      detail: `${v.quantity} × ${v.price} = ${f2(product)} ↔ ${f2(v.gross)}`,
    });
  } else {
    checks.push({ name: "quantity_price", result: "skipped", detail: null });
  }

  checks.push(
    v.isin
      ? { name: "isin_checksum", result: isinChecksumValid(v.isin) ? "ok" : "failed", detail: v.isin }
      : { name: "isin_checksum", result: "skipped", detail: null },
  );

  if (v.executedAt) {
    const t = Date.parse(`${v.executedAt}T00:00:00Z`);
    const latest = today.getTime() + 7 * 86_400_000;
    const ok = Number.isFinite(t) && t >= Date.parse("1990-01-01T00:00:00Z") && t <= latest;
    checks.push({ name: "date_plausible", result: ok ? "ok" : "failed", detail: v.executedAt });
  } else {
    checks.push({ name: "date_plausible", result: "skipped", detail: null });
  }

  return checks;
}

function score(checks: SettlementCheck[]): { ok: number; failed: number } {
  return {
    ok: checks.filter((c) => c.result === "ok").length,
    failed: checks.filter((c) => c.result === "failed").length,
  };
}

// ----------------------------------------------------------------------
// Merging
// ----------------------------------------------------------------------

export type FieldSource = "both" | "rules" | "llm" | null;

export interface MergedField {
  field: MergeField;
  rules: string | number | null;
  llm: string | number | null;
  /** Where the value that was used came from; "both" when they agree. */
  source: FieldSource;
  /** Both read a value and they differ. */
  disagree: boolean;
}

export interface MergeResult {
  values: SettlementValues;
  fields: MergedField[];
  checks: SettlementCheck[];
  /** "unverified": they disagree on something that matters and the figures do not settle it. */
  verdict: "ok" | "unverified";
}

function same(field: MergeField, a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (AMOUNT_FIELDS.includes(field)) return close(Math.abs(Number(a)), Math.abs(Number(b)), 0.005);
  if (field === "name") return String(a).toLowerCase().replace(/\s+/g, " ") === String(b).toLowerCase().replace(/\s+/g, " ");
  return a === b;
}

function fill(primary: SettlementValues, secondary: SettlementValues): SettlementValues {
  const out = { ...primary } as Record<MergeField, unknown>;
  for (const f of MERGE_FIELDS) {
    if (out[f] === null) out[f] = secondary[f];
  }
  const v = out as SettlementValues;
  // The sign of net follows the kind that was settled on.
  if (v.net !== null && v.kind) v.net = v.kind === "buy" ? -Math.abs(v.net) : Math.abs(v.net);
  return v;
}

/**
 * One reading from the rule-based one and the model's (either may be
 * missing). Without the model, the rules stand as they are.
 */
export function mergeSettlement(
  rules: SettlementValues | null,
  llm: SettlementValues | null,
  today = new Date(),
): MergeResult {
  const r = rules ?? EMPTY_SETTLEMENT;
  const l = llm ?? EMPTY_SETTLEMENT;

  // Candidate readings: each source, its gaps filled from the other.
  const fromRules = fill(r, l);
  const fromLlm = fill(l, r);
  const rulesChecks = settlementChecks(fromRules, today);
  const llmChecks = settlementChecks(fromLlm, today);
  const rs = score(rulesChecks);
  const ls = score(llmChecks);

  // Fewer failures wins, then more passes; a tie goes to the rules, which
  // never invent a number.
  const llmWins = llm !== null && (ls.failed < rs.failed || (ls.failed === rs.failed && ls.ok > rs.ok));
  const values = llmWins ? fromLlm : fromRules;
  const checks = llmWins ? llmChecks : rulesChecks;

  const fields: MergedField[] = MERGE_FIELDS.map((field) => {
    const rv = r[field];
    const lv = l[field];
    const disagree = rv !== null && lv !== null && !same(field, rv, lv);
    let source: FieldSource = null;
    if (values[field] === null) source = null;
    else if (rv !== null && lv !== null && !disagree) source = "both";
    else if (disagree) source = llmWins ? "llm" : "rules";
    else source = rv !== null ? "rules" : "llm";
    return { field, rules: rv, llm: lv, source, disagree };
  });

  const materialDisagreement = fields.some((f) => f.disagree && MATERIAL_FIELDS.includes(f.field));
  const settled = checks.some((c) => c.result === "ok") && !checks.some((c) => c.result === "failed");
  const verdict: MergeResult["verdict"] = materialDisagreement && !settled ? "unverified" : "ok";

  return { values, fields, checks, verdict };
}
