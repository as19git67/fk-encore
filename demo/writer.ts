/**
 * Lays the planned household down (documentation/plans/demodaten.md,
 * stage 1): the spouse as a user of her own, the household's subject
 * persons and joint assessment for the admin, the four accounts with their
 * access lists and the bookings on them. Every top-level row is registered
 * with the run; bookings go with their account.
 *
 * Bookings are written the way the manual booking endpoint writes them
 * (`finance/transactions.ts`: same columns, a dedupe hash per account),
 * without its auth layer, because the run is a background job of the
 * admin and not a request.
 */

import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeTransaction,
  roles,
  userAssessmentSettings,
  userRoles,
  users,
  userSubjectPersons,
} from "../db/schema";
import { DEMO_HOUSEHOLD, DEMO_SPOUSE } from "./names";
import type { AccountKey, HouseholdPlan, PlannedBooking } from "./household";
import { register } from "./registry";

/** A hash bcrypt never produces: the spouse cannot log in until an admin sets a password. */
const NO_LOGIN_HASH = "$2a$10$NOLOGIN.DEMO.USER.SET.A.PASSWORD.IN.THE.USER.LIST.000000";

/** The roles of a household member: every module, the assistant, nothing administrative. */
const MEMBER_ROLES = ["User", "Photo User", "Dokumente User", "Finance User", "Zähler User", "Assistent User"];

export interface WriteHooks {
  /** Called after each batch of bookings with how many are written. */
  progress?: (done: number, total: number) => Promise<void>;
  /** Checked between batches; true stops the run where it is. */
  cancelled?: () => Promise<boolean>;
}

export interface WrittenHousehold {
  spouseId: number;
  accounts: Record<AccountKey, number>;
  bookings: number;
}

export class DemoCancelled extends Error {
  constructor() {
    super("demo run cancelled");
  }
}

function cents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function dedupeHash(runId: number, index: number, b: PlannedBooking): string {
  return crypto.createHash("sha256").update(`demo:${runId}:${index}:${b.date}:${b.cents}:${b.purpose}`).digest("hex");
}

async function createSpouse(runId: number): Promise<number> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_SPOUSE.email)).limit(1);
  if (existing) throw new Error(`a user ${DEMO_SPOUSE.email} exists already — remove the earlier demo first`);
  const [spouse] = await db
    .insert(users)
    .values({ email: DEMO_SPOUSE.email, name: DEMO_SPOUSE.name, password_hash: NO_LOGIN_HASH })
    .returning({ id: users.id });
  await register(runId, "users", [spouse.id]);
  const roleRows = await db.select({ id: roles.id }).from(roles).where(inArray(roles.name, MEMBER_ROLES));
  if (roleRows.length) {
    await db.insert(userRoles).values(roleRows.map((r) => ({ user_id: spouse.id, role_id: r.id }))).onConflictDoNothing();
  }
  return spouse.id;
}

/**
 * The household as the tax side sees it: for the admin the spouse and the
 * child, for the spouse the admin and the child, and a joint assessment.
 * A person the admin entered already (a `self` row, an assessment) is left
 * alone and not duplicated.
 */
async function createHouseholdPersons(runId: number, ownerId: number, spouseId: number, firstYear: number): Promise<void> {
  const created: number[] = [];
  const personsOf = async (userId: number) =>
    db.select({ kind: userSubjectPersons.relation_kind }).from(userSubjectPersons).where(eq(userSubjectPersons.user_id, userId));

  const wanted: Array<{ user: number; full_name: string; tag: string; kind: "self" | "spouse" | "child" }> = [
    { user: ownerId, full_name: DEMO_HOUSEHOLD.self, tag: "Ich", kind: "self" },
    { user: ownerId, full_name: DEMO_HOUSEHOLD.spouse, tag: "Ehefrau", kind: "spouse" },
    { user: ownerId, full_name: DEMO_HOUSEHOLD.child, tag: "Kind", kind: "child" },
    { user: spouseId, full_name: DEMO_HOUSEHOLD.spouse, tag: "Ich", kind: "self" },
    { user: spouseId, full_name: DEMO_HOUSEHOLD.self, tag: "Ehemann", kind: "spouse" },
    { user: spouseId, full_name: DEMO_HOUSEHOLD.child, tag: "Kind", kind: "child" },
  ];
  const ownerKinds = new Set((await personsOf(ownerId)).map((p) => p.kind));
  for (const w of wanted) {
    if (w.user === ownerId && ownerKinds.has(w.kind)) continue;
    const [row] = await db
      .insert(userSubjectPersons)
      .values({
        user_id: w.user,
        full_name: w.full_name,
        relation_tag: w.tag,
        relation_kind: w.kind,
        in_household: true,
        tax_cost_bearer: w.kind === "child" ? "user" : "unknown",
      })
      .returning({ id: userSubjectPersons.id });
    created.push(row.id);
  }
  await register(runId, "user_subject_persons", created);

  const assessments: number[] = [];
  for (const userId of [ownerId, spouseId]) {
    const [has] = await db.select({ id: userAssessmentSettings.id }).from(userAssessmentSettings).where(eq(userAssessmentSettings.user_id, userId)).limit(1);
    if (has) continue;
    const [row] = await db
      .insert(userAssessmentSettings)
      .values({ user_id: userId, assessment_type: "zusammen", valid_from_tax_year: firstYear })
      .returning({ id: userAssessmentSettings.id });
    assessments.push(row.id);
  }
  await register(runId, "user_assessment_settings", assessments);
}

async function createAccounts(runId: number, plan: HouseholdPlan, ownerId: number, spouseId: number): Promise<Record<AccountKey, number>> {
  const types = await db.select({ id: financeAccountType.id, kind: financeAccountType.kind }).from(financeAccountType);
  const typeId = (kind: string) => {
    const t = types.find((x) => x.kind === kind);
    if (!t) throw new Error(`finance_account_type '${kind}' is missing — the seed has not run`);
    return t.id;
  };
  const ids = {} as Record<AccountKey, number>;
  for (const a of plan.accounts) {
    const [row] = await db
      .insert(financeAccount)
      .values({ type_id: typeId(a.kind), currency_code: "EUR", account_number: a.accountNumber, iban: a.iban, label: a.label })
      .returning({ id: financeAccount.id });
    ids[a.key] = row.id;
    // Registered right away: if a later step fails, removal still finds the account.
    await register(runId, "finance_account", [row.id]);
    const holders = a.owner === "self" ? [ownerId] : a.owner === "spouse" ? [spouseId] : [ownerId, spouseId];
    await db.insert(financeAccountAccess).values(holders.map((user_id) => ({ account_id: row.id, user_id, level: "write" as const })));
  }
  return ids;
}

export async function writeHousehold(runId: number, ownerId: number, plan: HouseholdPlan, hooks: WriteHooks = {}): Promise<WrittenHousehold> {
  const spouseId = await createSpouse(runId);
  await createHouseholdPersons(runId, ownerId, spouseId, Number(plan.from.slice(0, 4)));
  const accounts = await createAccounts(runId, plan, ownerId, spouseId);

  const BATCH = 50;
  for (let i = 0; i < plan.bookings.length; i += BATCH) {
    if (hooks.cancelled && (await hooks.cancelled())) throw new DemoCancelled();
    const batch = plan.bookings.slice(i, i + BATCH);
    await db.insert(financeTransaction).values(
      batch.map((b, j) => ({
        account_id: accounts[b.account],
        booking_date: `${b.date}T00:00:00`,
        value_date: `${b.date}T00:00:00`,
        amount: cents(b.cents),
        currency_code: "EUR",
        purpose: b.purpose,
        counterparty: b.counterparty,
        counterparty_iban: b.counterpartyIban,
        entry_text: b.entryText,
        dedupe_hash: dedupeHash(runId, i + j, b),
      })),
    );
    await hooks.progress?.(Math.min(i + BATCH, plan.bookings.length), plan.bookings.length);
  }

  // Today's balance per account: the opening balance plus every booking.
  const asOf = `${plan.to}T18:00:00Z`;
  for (const a of plan.accounts) {
    const total = plan.bookings.filter((b) => b.account === a.key).reduce((s, b) => s + b.cents, a.openingCents);
    await db.insert(financeAccountBalance).values({ account_id: accounts[a.key], as_of: asOf, balance: cents(total), source: "manual" });
  }

  return { spouseId, accounts, bookings: plan.bookings.length };
}

/** The bookings of the given accounts, for the remover: they do not cascade from their account. */
export async function deleteBookingsOf(accountIds: number[]): Promise<void> {
  if (!accountIds.length) return;
  await db.delete(financeTransaction).where(inArray(financeTransaction.account_id, accountIds));
}

