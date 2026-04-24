/**
 * Account endpoints — CRUD plus ACL-filtered reads.
 *
 * Two permission layers apply:
 *
 *   - Module-level: `finance.view` to see anything, `finance.accounts
 *     .manage` to mutate. `finance.admin` bypasses the ACL filter.
 *   - Row-level (reads only): a non-admin user sees an account only
 *     if a row in finance_account_access ties their user_id to that
 *     account (any level ≥ 'read'). The ACL table is administered
 *     via account-access.ts.
 *
 * Architecture: docs/finance-data-model.md §5 (permissions) and
 * docs/finance-frontend.md §4.7 (ACL semantics).
 */

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, eq, inArray } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import {
  financeAccount,
  financeAccountAccess,
  financeAccountKindEnum,
  financeAccountType,
  financeBankcontact,
  financeCurrency,
  financeTransaction,
} from "../db/schema";

console.log("[boot] finance/accounts.ts: all imports resolved");

// -----------------------------------------------------------------------
// DTO shape
// -----------------------------------------------------------------------

interface AccountView {
  id: number;
  bankcontact_id: number;
  bankcontact_name: string;
  type_kind: string;
  type_label: string;
  currency_code: string;
  currency_symbol: string;
  iban: string | null;
  account_number: string;
  label: string;
  active: boolean;
  created_at: string | null;
}

interface ListResponse {
  items: AccountView[];
}

type AccountRow = typeof financeAccount.$inferSelect;
type BankcontactRow = typeof financeBankcontact.$inferSelect;
type TypeRow = typeof financeAccountType.$inferSelect;
type CurrencyRow = typeof financeCurrency.$inferSelect;

/** Join-aware row projector. The four refs are looked up once and
 * reused across rows so we don't emit N+1 queries. */
function toView(
  row: AccountRow,
  bankcontact: BankcontactRow,
  type: TypeRow,
  currency: CurrencyRow,
): AccountView {
  return {
    id: row.id,
    bankcontact_id: row.bankcontact_id,
    bankcontact_name: bankcontact.name,
    type_kind: type.kind,
    type_label: type.label,
    currency_code: currency.code,
    currency_symbol: currency.symbol,
    iban: row.iban,
    account_number: row.account_number,
    label: row.label,
    active: row.active,
    created_at: row.created_at,
  };
}

function hasAdmin(auth: { permissions: string[] }): boolean {
  return auth.permissions.includes("finance.admin");
}

// -----------------------------------------------------------------------
// List (ACL-filtered)
// -----------------------------------------------------------------------

export const listAccounts = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/accounts",
    auth: true,
  },
  async (): Promise<ListResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");
    const userId = Number(auth.userID);

    // Fetch either all rows (admin) or only rows visible via ACL.
    let rows: AccountRow[];
    if (hasAdmin(auth)) {
      rows = await db.select().from(financeAccount);
    } else {
      rows = await db
        .select({
          id: financeAccount.id,
          bankcontact_id: financeAccount.bankcontact_id,
          type_id: financeAccount.type_id,
          currency_code: financeAccount.currency_code,
          iban: financeAccount.iban,
          account_number: financeAccount.account_number,
          label: financeAccount.label,
          active: financeAccount.active,
          created_at: financeAccount.created_at,
        })
        .from(financeAccount)
        .innerJoin(
          financeAccountAccess,
          and(
            eq(financeAccountAccess.account_id, financeAccount.id),
            eq(financeAccountAccess.user_id, userId),
          ),
        );
    }
    if (rows.length === 0) return { items: [] };

    // Batch-load the three lookup dimensions.
    const bcIds = [...new Set(rows.map((r) => r.bankcontact_id))];
    const typeIds = [...new Set(rows.map((r) => r.type_id))];
    const currencyCodes = [...new Set(rows.map((r) => r.currency_code))];

    const [bankcontacts, types, currencies] = await Promise.all([
      db.select().from(financeBankcontact).where(inArray(financeBankcontact.id, bcIds)),
      db.select().from(financeAccountType).where(inArray(financeAccountType.id, typeIds)),
      db.select().from(financeCurrency).where(inArray(financeCurrency.code, currencyCodes)),
    ]);

    const bcById = new Map(bankcontacts.map((b) => [b.id, b]));
    const typeById = new Map(types.map((t) => [t.id, t]));
    const currByCode = new Map(currencies.map((c) => [c.code, c]));

    return {
      items: rows.map((r) =>
        toView(r, bcById.get(r.bankcontact_id)!, typeById.get(r.type_id)!, currByCode.get(r.currency_code)!),
      ),
    };
  },
);

// -----------------------------------------------------------------------
// Get by id (ACL-enforced)
// -----------------------------------------------------------------------

interface IdParams {
  id: number;
}

export const getAccount = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/accounts/:id",
    auth: true,
  },
  async ({ id }: IdParams): Promise<AccountView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.view");

    const row = await loadAccount(id);
    if (!hasAdmin(auth)) {
      await assertAclRead(id, Number(auth.userID));
    }
    const [bc, type, curr] = await Promise.all([
      loadBankcontact(row.bankcontact_id),
      loadType(row.type_id),
      loadCurrency(row.currency_code),
    ]);
    return toView(row, bc, type, curr);
  },
);

// -----------------------------------------------------------------------
// Create (finance.accounts.manage)
// -----------------------------------------------------------------------

interface CreateParams {
  bankcontact_id: number;
  type_kind: string;
  currency_code: string;
  iban?: string;
  account_number: string;
  label: string;
}

export const createAccount = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/accounts",
    auth: true,
  },
  async (p: CreateParams): Promise<AccountView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    await loadBankcontact(p.bankcontact_id); // 404 if missing
    if (!(financeAccountKindEnum.enumValues as readonly string[]).includes(p.type_kind)) {
      throw APIError.invalidArgument(`unknown account type '${p.type_kind}'`);
    }
    const [type] = await db
      .select()
      .from(financeAccountType)
      .where(eq(financeAccountType.kind, p.type_kind as any))
      .limit(1);
    if (!type) {
      throw APIError.invalidArgument(`unknown account type '${p.type_kind}'`);
    }
    const [currency] = await db
      .select()
      .from(financeCurrency)
      .where(eq(financeCurrency.code, p.currency_code))
      .limit(1);
    if (!currency) {
      throw APIError.invalidArgument(
        `unknown currency '${p.currency_code}'`,
      );
    }
    if (!p.account_number?.trim()) {
      throw APIError.invalidArgument("account_number required");
    }
    if (!p.label?.trim()) {
      throw APIError.invalidArgument("label required");
    }

    const [row] = await db
      .insert(financeAccount)
      .values({
        bankcontact_id: p.bankcontact_id,
        type_id: type.id,
        currency_code: currency.code,
        iban: p.iban?.trim() || null,
        account_number: p.account_number.trim(),
        label: p.label.trim(),
      })
      .returning();
    const bc = await loadBankcontact(row.bankcontact_id);
    return toView(row, bc, type, currency);
  },
);

// -----------------------------------------------------------------------
// Patch (finance.accounts.manage — label / active / iban)
// -----------------------------------------------------------------------

interface PatchParams {
  id: number;
  label?: string;
  iban?: string | null;
  active?: boolean;
}

export const updateAccount = api(
  {
    expose: true,
    method: "PATCH",
    path: "/finance/accounts/:id",
    auth: true,
  },
  async (p: PatchParams): Promise<AccountView> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");

    const existing = await loadAccount(p.id);
    const patch: Partial<typeof financeAccount.$inferInsert> = {};
    if (p.label !== undefined) {
      if (!p.label.trim()) {
        throw APIError.invalidArgument("label cannot be empty");
      }
      patch.label = p.label.trim();
    }
    if (p.iban !== undefined) {
      patch.iban = p.iban === null ? null : p.iban.trim() || null;
    }
    if (p.active !== undefined) patch.active = p.active;

    if (Object.keys(patch).length === 0) {
      throw APIError.invalidArgument("no fields to update");
    }

    const [row] = await db
      .update(financeAccount)
      .set(patch)
      .where(eq(financeAccount.id, p.id))
      .returning();

    const [bc, type, curr] = await Promise.all([
      loadBankcontact(row.bankcontact_id),
      loadType(row.type_id),
      loadCurrency(row.currency_code),
    ]);
    void existing;
    return toView(row, bc, type, curr);
  },
);

// -----------------------------------------------------------------------
// Delete
// -----------------------------------------------------------------------
//
// Hard-delete a single account and everything downstream of it:
//   finance_transaction          (explicit; FK RESTRICT blocks otherwise)
//   finance_transaction_embedding (cascades from transaction)
//   finance_tag_transaction       (cascades from transaction)
//   finance_account_balance       (cascades from account)
//   finance_account_access        (cascades from account)
//
// The RESTRICT edge on transaction → account exists so a stray UI
// click can't nuke years of bookings; this endpoint is the explicit
// opt-in. The UI must show a summary + confirm before hitting it.

interface DeleteAccountParams {
  id: number;
}

interface DeleteAccountResponse {
  deleted: true;
  transactions_deleted: number;
  balances_deleted: number;
}

export const deleteAccount = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/accounts/:id",
    auth: true,
  },
  async ({ id }: DeleteAccountParams): Promise<DeleteAccountResponse> => {
    const auth = getAuthData()!;
    requirePermission(auth, "finance.accounts.manage");
    await loadAccount(id);

    // Count before delete so the caller gets a useful summary.
    const txRows = await db
      .select({ id: financeTransaction.id })
      .from(financeTransaction)
      .where(eq(financeTransaction.account_id, id));
    const txCount = txRows.length;

    // Delete transactions first — embedding + tag_transaction cascade.
    await db
      .delete(financeTransaction)
      .where(eq(financeTransaction.account_id, id));

    // Delete the account — balance + access cascade.
    await db.delete(financeAccount).where(eq(financeAccount.id, id));

    return {
      deleted: true,
      transactions_deleted: txCount,
      balances_deleted: 0, // cascaded; exact count not tracked
    };
  },
);

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

async function loadAccount(id: number): Promise<AccountRow> {
  const [row] = await db
    .select()
    .from(financeAccount)
    .where(eq(financeAccount.id, id))
    .limit(1);
  if (!row) throw APIError.notFound(`account ${id} not found`);
  return row;
}

async function loadBankcontact(id: number): Promise<BankcontactRow> {
  const [row] = await db
    .select()
    .from(financeBankcontact)
    .where(eq(financeBankcontact.id, id))
    .limit(1);
  if (!row) throw APIError.notFound(`bankcontact ${id} not found`);
  return row;
}

async function loadType(id: number): Promise<TypeRow> {
  const [row] = await db
    .select()
    .from(financeAccountType)
    .where(eq(financeAccountType.id, id))
    .limit(1);
  if (!row) throw APIError.internal(`finance_account_type ${id} missing`);
  return row;
}

async function loadCurrency(code: string): Promise<CurrencyRow> {
  const [row] = await db
    .select()
    .from(financeCurrency)
    .where(eq(financeCurrency.code, code))
    .limit(1);
  if (!row) throw APIError.internal(`finance_currency ${code} missing`);
  return row;
}

async function assertAclRead(accountId: number, userId: number): Promise<void> {
  const [row] = await db
    .select({ user_id: financeAccountAccess.user_id })
    .from(financeAccountAccess)
    .where(
      and(
        eq(financeAccountAccess.account_id, accountId),
        eq(financeAccountAccess.user_id, userId),
      ),
    )
    .limit(1);
  if (!row) {
    // Mirror the 404 from missing accounts so callers can't enumerate
    // existence of accounts they don't have access to.
    throw APIError.notFound(`account ${accountId} not found`);
  }
}
