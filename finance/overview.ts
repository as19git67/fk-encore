/**
 * Configurable per-user overview page for the finance module.
 *
 * Two endpoints:
 *
 *   GET  /finance/overview   → resolved sections + accounts (latest
 *                              balance, last-update timestamp, count of
 *                              recent untagged transactions) plus the
 *                              list of accounts the user has access to
 *                              but has not yet placed in any section.
 *   PUT  /finance/overview   → save the section config.
 *
 * The config is stored as a JSONB blob in `finance_user_pref` keyed
 * by (user_id, key='overview'). When the user has not yet saved a
 * config, the GET handler returns a sensible default grouping derived
 * from the account types ("Täglich" for everyday accounts, "Sparen"
 * for savings/investment, "Kredit" for loan-style accounts).
 *
 * Permission model:
 *   - Module-level `finance.view`.
 *   - Row-level: a non-admin user only sees / can place accounts they
 *     hold an entry for in `finance_account_access`. Account ids in
 *     the saved config that the user no longer has access to are
 *     silently filtered out on read so the UI doesn't surface stale
 *     references; the saved blob itself is left untouched until the
 *     user saves a new config.
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountBalance,
  financeAccountType,
  financeCurrency,
  financeUserPref,
  users,
} from "../db/schema";

console.log("[boot] finance/overview.ts: all imports resolved");

const PREF_KEY = "overview";

// Window for the "needs-review" / pending count badge — count
// transactions in the last N days that don't yet have any user-tag.
const PENDING_WINDOW_DAYS = 30;

/**
 * Default grouping when the user hasn't saved a config yet.
 *
 * Each entry maps a finance_account_kind to a section name. Any kind
 * not listed falls into "Sonstiges" (rendered only if non-empty).
 */
const DEFAULT_SECTION_BY_KIND: Record<string, string> = {
  giro: "Täglich",
  kreditkarte: "Täglich",
  bargeld: "Täglich",
  tagesgeld: "Sparen",
  festgeld: "Sparen",
  depot: "Sparen",
  bausparen: "Sparen",
  kredit: "Kredit",
};

const DEFAULT_SECTION_ORDER = ["Täglich", "Sparen", "Kredit", "Sonstiges"];

// -----------------------------------------------------------------------
// DTO shapes
// -----------------------------------------------------------------------

interface OverviewAccount {
  id: number;
  label: string;
  type_kind: string;
  type_label: string;
  currency_code: string;
  currency_symbol: string;
  /** Latest balance from finance_account_balance, null when none exists. */
  balance: string | null;
  /** ISO timestamp of the latest balance row (null when none). */
  balance_as_of: string | null;
  /** Count of transactions in the last 30 days without user tags. */
  pending_count: number;
}

interface OverviewSection {
  /** Display name. Section identity is the name itself — no internal id. */
  name: string;
  accounts: OverviewAccount[];
}

interface OverviewResponse {
  /** The user's own email — surfaced in the page header. */
  user_email: string;
  /** Ordered sections with their resolved accounts. */
  sections: OverviewSection[];
  /** Accessible accounts that aren't yet in any section. */
  unassigned: OverviewAccount[];
  /** True when the response was synthesised from defaults (no saved
   *  config yet). The UI uses this to nudge first-time users into the
   *  "Übersicht konfigurieren" dialog. */
  is_default: boolean;
}

// -----------------------------------------------------------------------
// GET /finance/overview
// -----------------------------------------------------------------------

export const getOverview = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/overview",
    auth: true,
  },
  async (): Promise<OverviewResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);
    const isAdmin = auth.permissions.includes("finance.admin");

    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const accessible = await loadAccessibleAccounts(userId, isAdmin);
    const accountById = new Map(accessible.map((a) => [a.id, a]));

    const stored = await loadStoredConfig(userId);

    let sections: OverviewSection[];
    let isDefault: boolean;
    let placedIds: Set<number>;

    if (stored) {
      placedIds = new Set();
      sections = stored.sections.map((s) => {
        const accounts: OverviewAccount[] = [];
        for (const id of s.account_ids) {
          const acc = accountById.get(id);
          if (!acc) continue; // dropped from ACL or deleted — silently skip
          if (placedIds.has(id)) continue; // dedupe across sections
          placedIds.add(id);
          accounts.push(acc);
        }
        return { name: s.name, accounts };
      });
      isDefault = false;
    } else {
      const built = buildDefaultSections(accessible);
      sections = built.sections;
      placedIds = built.placed;
      isDefault = true;
    }

    const unassigned = accessible.filter((a) => !placedIds.has(a.id));

    return {
      user_email: user?.email ?? "",
      sections,
      unassigned,
      is_default: isDefault,
    };
  },
);

// -----------------------------------------------------------------------
// PUT /finance/overview
// -----------------------------------------------------------------------

interface SaveSectionInput {
  name: string;
  account_ids: number[];
}

interface SaveOverviewInput {
  sections: SaveSectionInput[];
}

interface SaveOverviewResponse {
  saved: true;
  sections_saved: number;
  accounts_saved: number;
}

export const saveOverview = api(
  {
    expose: true,
    method: "PUT",
    path: "/finance/overview",
    auth: true,
  },
  async (p: SaveOverviewInput): Promise<SaveOverviewResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);
    const isAdmin = auth.permissions.includes("finance.admin");

    if (!Array.isArray(p.sections)) {
      throw APIError.invalidArgument("sections must be an array");
    }

    // Normalise + validate the payload before reaching for the DB.
    const seenNames = new Set<string>();
    const placed = new Set<number>();
    const sections: SaveSectionInput[] = [];
    for (const s of p.sections) {
      const name = (s?.name ?? "").trim();
      if (!name) throw APIError.invalidArgument("section name required");
      if (name.length > 80) {
        throw APIError.invalidArgument(
          `section name '${name.slice(0, 20)}…' exceeds 80 characters`,
        );
      }
      if (seenNames.has(name)) {
        throw APIError.invalidArgument(`duplicate section name '${name}'`);
      }
      seenNames.add(name);

      if (!Array.isArray(s.account_ids)) {
        throw APIError.invalidArgument(
          `section '${name}': account_ids must be an array`,
        );
      }
      const ids: number[] = [];
      for (const raw of s.account_ids) {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0) {
          throw APIError.invalidArgument(
            `section '${name}': invalid account id ${raw}`,
          );
        }
        if (placed.has(id)) {
          throw APIError.invalidArgument(
            `account ${id} appears in more than one section`,
          );
        }
        placed.add(id);
        ids.push(id);
      }
      sections.push({ name, account_ids: ids });
    }

    // Verify the caller can actually access every referenced account.
    if (placed.size > 0 && !isAdmin) {
      const visible = await db
        .select({ id: financeAccountAccess.account_id })
        .from(financeAccountAccess)
        .where(
          and(
            eq(financeAccountAccess.user_id, userId),
            inArray(financeAccountAccess.account_id, [...placed]),
          ),
        );
      const visibleSet = new Set(visible.map((r) => r.id));
      const missing = [...placed].filter((id) => !visibleSet.has(id));
      if (missing.length > 0) {
        throw APIError.permissionDenied(
          `no access to account(s): ${missing.join(", ")}`,
        );
      }
    } else if (placed.size > 0) {
      // Admin bypasses ACL but the ids must still exist.
      const present = await db
        .select({ id: financeAccount.id })
        .from(financeAccount)
        .where(inArray(financeAccount.id, [...placed]));
      const presentSet = new Set(present.map((r) => r.id));
      const missing = [...placed].filter((id) => !presentSet.has(id));
      if (missing.length > 0) {
        throw APIError.notFound(`account(s) not found: ${missing.join(", ")}`);
      }
    }

    const value = { sections };
    await db
      .insert(financeUserPref)
      .values({
        user_id: userId,
        key: PREF_KEY,
        value,
      })
      .onConflictDoUpdate({
        target: [financeUserPref.user_id, financeUserPref.key],
        set: { value, updated_at: new Date().toISOString() },
      });

    let accountsSaved = 0;
    for (const s of sections) accountsSaved += s.account_ids.length;
    return { saved: true, sections_saved: sections.length, accounts_saved: accountsSaved };
  },
);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function loadStoredConfig(
  userId: number,
): Promise<{ sections: SaveSectionInput[] } | null> {
  const [row] = await db
    .select({ value: financeUserPref.value })
    .from(financeUserPref)
    .where(
      and(
        eq(financeUserPref.user_id, userId),
        eq(financeUserPref.key, PREF_KEY),
      ),
    )
    .limit(1);
  if (!row) return null;

  const v = row.value as unknown;
  if (!v || typeof v !== "object") return null;
  const sectionsRaw = (v as { sections?: unknown }).sections;
  if (!Array.isArray(sectionsRaw)) return null;

  const sections: SaveSectionInput[] = [];
  for (const s of sectionsRaw) {
    if (!s || typeof s !== "object") continue;
    const name = typeof (s as any).name === "string" ? (s as any).name : "";
    const ids = Array.isArray((s as any).account_ids)
      ? ((s as any).account_ids as unknown[])
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x > 0)
      : [];
    if (!name) continue;
    sections.push({ name, account_ids: ids });
  }
  return { sections };
}

/**
 * Loads every account the caller can read, fully annotated with the
 * fields the overview UI needs (latest balance, pending-count). Admins
 * see every account; non-admin callers are filtered through the ACL.
 *
 * Two passes only: one for the account/type/currency join and one for
 * the latest balance. The pending-count is a single grouped query so
 * we don't issue N round-trips on a large account set.
 */
async function loadAccessibleAccounts(
  userId: number,
  isAdmin: boolean,
): Promise<OverviewAccount[]> {
  // Step 1 — account rows + lookup joins. Admin path skips the ACL
  // join; non-admin path inner-joins financeAccountAccess so users
  // only see accounts they hold an entry for.
  const fields = {
    id: financeAccount.id,
    label: financeAccount.label,
    type_kind: financeAccountType.kind,
    type_label: financeAccountType.label,
    currency_code: financeCurrency.code,
    currency_symbol: financeCurrency.symbol,
  };

  // Closed accounts are filtered out of the overview — the dashboard
  // is "current state at a glance", and a closed account by definition
  // has no current activity. Historical access lives in the per-account
  // transactions view.
  const rows = isAdmin
    ? await db
        .select(fields)
        .from(financeAccount)
        .innerJoin(
          financeAccountType,
          eq(financeAccountType.id, financeAccount.type_id),
        )
        .innerJoin(
          financeCurrency,
          eq(financeCurrency.code, financeAccount.currency_code),
        )
        .where(isNull(financeAccount.closed_at))
    : await db
        .select(fields)
        .from(financeAccount)
        .innerJoin(
          financeAccountType,
          eq(financeAccountType.id, financeAccount.type_id),
        )
        .innerJoin(
          financeCurrency,
          eq(financeCurrency.code, financeAccount.currency_code),
        )
        .innerJoin(
          financeAccountAccess,
          and(
            eq(financeAccountAccess.account_id, financeAccount.id),
            eq(financeAccountAccess.user_id, userId),
          ),
        )
        .where(isNull(financeAccount.closed_at));

  if (rows.length === 0) return [];

  const accountIds = rows.map((r) => r.id);

  // Step 2 — latest balance per account.
  const latestBalances = new Map<number, { balance: string; as_of: string }>();
  const balanceRows = await db
    .select({
      account_id: financeAccountBalance.account_id,
      balance: financeAccountBalance.balance,
      as_of: financeAccountBalance.as_of,
    })
    .from(financeAccountBalance)
    .where(inArray(financeAccountBalance.account_id, accountIds))
    .orderBy(desc(financeAccountBalance.as_of));
  for (const row of balanceRows) {
    if (latestBalances.has(row.account_id)) continue;
    latestBalances.set(row.account_id, {
      balance: row.balance,
      as_of: row.as_of,
    });
  }

  // Step 3 — pending counts: transactions in the last 30 days that
  // don't yet carry any user-source tag. Single grouped raw SQL query
  // with NOT EXISTS so transactions with multiple AI-tag rows aren't
  // counted multiple times.
  const cutoff = new Date(Date.now() - PENDING_WINDOW_DAYS * 86_400_000)
    .toISOString();
  const pendingByAccount = new Map<number, number>();

  const pendingRows = (
    await db.execute(sql`
      SELECT t.account_id AS account_id, COUNT(*)::int AS n
      FROM finance_transaction t
      WHERE t.account_id IN (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
        AND t.booking_date >= ${cutoff}
        AND NOT EXISTS (
          SELECT 1
          FROM finance_tag_transaction tt
          INNER JOIN finance_tag tag ON tag.id = tt.tag_id
          WHERE tt.transaction_id = t.id AND tag.source = 'user'
        )
      GROUP BY t.account_id
    `)
  ).rows as Array<{ account_id: number; n: number }>;
  for (const r of pendingRows) {
    pendingByAccount.set(Number(r.account_id), Number(r.n));
  }

  return rows.map((r) => {
    const bal = latestBalances.get(r.id);
    return {
      id: r.id,
      label: r.label,
      type_kind: r.type_kind,
      type_label: r.type_label,
      currency_code: r.currency_code,
      currency_symbol: r.currency_symbol,
      balance: bal?.balance ?? null,
      balance_as_of: bal?.as_of ?? null,
      pending_count: pendingByAccount.get(r.id) ?? 0,
    };
  });
}

function buildDefaultSections(accounts: OverviewAccount[]): {
  sections: OverviewSection[];
  placed: Set<number>;
} {
  const byName = new Map<string, OverviewAccount[]>();
  for (const acc of accounts) {
    const name = DEFAULT_SECTION_BY_KIND[acc.type_kind] ?? "Sonstiges";
    let list = byName.get(name);
    if (!list) {
      list = [];
      byName.set(name, list);
    }
    list.push(acc);
  }

  const sections: OverviewSection[] = [];
  for (const name of DEFAULT_SECTION_ORDER) {
    const list = byName.get(name);
    if (!list || list.length === 0) continue;
    sections.push({ name, accounts: list });
  }
  // Any extra sections that didn't appear in DEFAULT_SECTION_ORDER —
  // there shouldn't be any, but stay defensive.
  for (const [name, list] of byName) {
    if (DEFAULT_SECTION_ORDER.includes(name)) continue;
    if (list.length > 0) sections.push({ name, accounts: list });
  }

  const placed = new Set<number>();
  for (const s of sections) for (const a of s.accounts) placed.add(a.id);
  return { sections, placed };
}

// Internal hook — referenced by tests so they can exercise the
// helpers directly without going through the API surface.
export const __testing = {
  loadAccessibleAccounts,
  loadStoredConfig,
  buildDefaultSections,
  PREF_KEY,
  PENDING_WINDOW_DAYS,
};
