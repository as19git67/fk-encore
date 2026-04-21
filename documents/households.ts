/**
 * Household management endpoints.
 *
 * A household groups users who share a pool of documents. Every member
 * can see and upload into the household; only `owner`-role members can
 * rename the household, add/remove members, or delete it.
 *
 * Every document belongs to either a single user (`visibility='private'`)
 * or a single household (`visibility='household'`). Private and shared
 * documents coexist per user — a family member's personal tax folder is
 * not exposed to the family pool.
 */

import { and, eq } from "drizzle-orm";
import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { householdMembers, households, users } from "../db/schema";
import { slugifyName } from "./documents.service";
import {
  assertHouseholdMember,
  assertHouseholdOwner,
} from "./visibility";

function getUserId(): number {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  return parseInt(authData.userID, 10);
}

function checkModule(): void {
  const authData = getAuthData();
  if (!authData) throw APIError.unauthenticated("Unauthorized");
  requirePermission(authData, "module.documents");
}

export interface HouseholdMemberDTO {
  user_id: number;
  email: string;
  name: string | null;
  role: "owner" | "member";
  joined_at: string | null;
}

export interface HouseholdDTO {
  id: number;
  slug: string;
  name: string;
  created_at: string | null;
  /** Caller's role in this household. */
  my_role: "owner" | "member";
  member_count: number;
}

export interface HouseholdDetailDTO extends HouseholdDTO {
  members: HouseholdMemberDTO[];
}

/** List every household the caller belongs to. */
export const listHouseholds = api(
  { expose: true, method: "GET", path: "/households", auth: true },
  async (): Promise<{ items: HouseholdDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "households.view");
    const userId = getUserId();

    const rows = await dbAll<{
      id: number;
      slug: string;
      name: string;
      created_at: string | null;
      my_role: "owner" | "member";
    }>(
      db
        .select({
          id: households.id,
          slug: households.slug,
          name: households.name,
          created_at: households.created_at,
          my_role: householdMembers.role,
        })
        .from(households)
        .innerJoin(
          householdMembers,
          and(
            eq(householdMembers.household_id, households.id),
            eq(householdMembers.user_id, userId),
          ),
        ),
    );

    // Count members per household in one go — trivially small (a handful
    // at most per user).
    const items: HouseholdDTO[] = [];
    for (const r of rows) {
      const members = await dbAll<{ user_id: number }>(
        db
          .select({ user_id: householdMembers.user_id })
          .from(householdMembers)
          .where(eq(householdMembers.household_id, r.id)),
      );
      items.push({
        id: r.id,
        slug: r.slug,
        name: r.name,
        created_at: r.created_at,
        my_role: r.my_role,
        member_count: members.length,
      });
    }
    return { items };
  },
);

export const getHousehold = api(
  { expose: true, method: "GET", path: "/households/:id", auth: true },
  async ({ id }: { id: number }): Promise<HouseholdDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "households.view");
    const userId = getUserId();

    await assertHouseholdMember(userId, id);

    const h = await dbFirst<{
      id: number;
      slug: string;
      name: string;
      created_at: string | null;
    }>(
      db
        .select({
          id: households.id,
          slug: households.slug,
          name: households.name,
          created_at: households.created_at,
        })
        .from(households)
        .where(eq(households.id, id)),
    );
    if (!h) throw APIError.notFound("household not found");

    const members = await dbAll<{
      user_id: number;
      email: string;
      name: string | null;
      role: "owner" | "member";
      joined_at: string | null;
    }>(
      db
        .select({
          user_id: householdMembers.user_id,
          email: users.email,
          name: users.name,
          role: householdMembers.role,
          joined_at: householdMembers.joined_at,
        })
        .from(householdMembers)
        .innerJoin(users, eq(users.id, householdMembers.user_id))
        .where(eq(householdMembers.household_id, id)),
    );

    const myRole = members.find((m) => m.user_id === userId)?.role ?? "member";

    return {
      ...h,
      my_role: myRole,
      member_count: members.length,
      members,
    };
  },
);

export interface CreateHouseholdRequest {
  name: string;
}

/**
 * Create a new household. The caller becomes its first member with
 * `owner` role. The slug is derived from the name and uniqueness is
 * enforced at the DB level; colliding names get a numeric suffix.
 */
export const createHousehold = api(
  { expose: true, method: "POST", path: "/households", auth: true },
  async ({ name }: CreateHouseholdRequest): Promise<HouseholdDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "households.manage");
    const userId = getUserId();

    const trimmed = (name ?? "").trim();
    if (trimmed.length === 0) {
      throw APIError.invalidArgument("name must not be empty");
    }
    if (trimmed.length > 120) {
      throw APIError.invalidArgument("name must not exceed 120 characters");
    }

    const slug = await uniqueHouseholdSlug(trimmed);

    const created = await dbFirst<{ id: number }>(
      db
        .insert(households)
        .values({ slug, name: trimmed })
        .returning({ id: households.id }),
    );
    if (!created) throw new Error("insert households: no row returned");

    await db
      .insert(householdMembers)
      .values({ household_id: created.id, user_id: userId, role: "owner" });

    return await getHouseholdDetail(created.id, userId);
  },
);

export interface UpdateHouseholdRequest {
  id: number;
  name: string;
}

export const updateHousehold = api(
  { expose: true, method: "PATCH", path: "/households/:id", auth: true },
  async ({ id, name }: UpdateHouseholdRequest): Promise<HouseholdDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "households.manage");
    const userId = getUserId();

    await assertHouseholdOwner(userId, id);

    const trimmed = (name ?? "").trim();
    if (trimmed.length === 0) {
      throw APIError.invalidArgument("name must not be empty");
    }

    await db
      .update(households)
      .set({ name: trimmed })
      .where(eq(households.id, id));

    return await getHouseholdDetail(id, userId);
  },
);

export interface AddHouseholdMemberRequest {
  id: number;
  user_email: string;
  role?: "owner" | "member";
}

export const addHouseholdMember = api(
  { expose: true, method: "POST", path: "/households/:id/members", auth: true },
  async ({ id, user_email, role }: AddHouseholdMemberRequest): Promise<HouseholdDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "households.manage");
    const userId = getUserId();

    await assertHouseholdOwner(userId, id);

    const email = (user_email ?? "").trim().toLowerCase();
    if (email.length === 0) {
      throw APIError.invalidArgument("user_email must not be empty");
    }
    const target = await dbFirst<{ id: number }>(
      db.select({ id: users.id }).from(users).where(eq(users.email, email)),
    );
    if (!target) throw APIError.notFound(`no user with email ${email}`);

    const desiredRole: "owner" | "member" = role === "owner" ? "owner" : "member";

    await db
      .insert(householdMembers)
      .values({ household_id: id, user_id: target.id, role: desiredRole })
      .onConflictDoNothing();

    return await getHouseholdDetail(id, userId);
  },
);

export const removeHouseholdMember = api(
  {
    expose: true,
    method: "DELETE",
    path: "/households/:id/members/:member_user_id",
    auth: true,
  },
  async ({
    id,
    member_user_id,
  }: {
    id: number;
    member_user_id: number;
  }): Promise<HouseholdDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "households.manage");
    const userId = getUserId();

    await assertHouseholdOwner(userId, id);

    // Don't strand a household without any owner. If the target is the
    // last owner, refuse.
    const owners = await dbAll<{ user_id: number }>(
      db
        .select({ user_id: householdMembers.user_id })
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.household_id, id),
            eq(householdMembers.role, "owner"),
          ),
        ),
    );
    if (
      owners.length <= 1 &&
      owners.some((o) => o.user_id === member_user_id)
    ) {
      throw APIError.failedPrecondition(
        "cannot remove the last owner of a household",
      );
    }

    await db
      .delete(householdMembers)
      .where(
        and(
          eq(householdMembers.household_id, id),
          eq(householdMembers.user_id, member_user_id),
        ),
      );

    return await getHouseholdDetail(id, userId);
  },
);

export const deleteHousehold = api(
  { expose: true, method: "DELETE", path: "/households/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "households.manage");
    const userId = getUserId();

    await assertHouseholdOwner(userId, id);

    // The `documents_household_id_fkey` FK uses ON DELETE RESTRICT, so
    // any lingering household-scoped document will fail this delete.
    // Surface that to the caller as a precondition error rather than a
    // raw SQL error.
    try {
      await db.delete(households).where(eq(households.id, id));
    } catch (err: any) {
      if (err?.code === "23503") {
        throw APIError.failedPrecondition(
          "household still owns documents — move or delete them first",
        );
      }
      throw err;
    }
    return { success: true };
  },
);

// ─── helpers ────────────────────────────────────────────────────────────────

async function uniqueHouseholdSlug(name: string): Promise<string> {
  const base = slugifyName(name, 48) || "haushalt";
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const hit = await dbFirst<{ id: number }>(
      db.select({ id: households.id }).from(households).where(eq(households.slug, candidate)),
    );
    if (!hit) return candidate;
    candidate = `${base}-${i}`;
  }
  throw APIError.failedPrecondition("could not allocate a unique household slug");
}

async function getHouseholdDetail(
  id: number,
  viewerId: number,
): Promise<HouseholdDetailDTO> {
  const h = await dbFirst<{
    id: number;
    slug: string;
    name: string;
    created_at: string | null;
  }>(
    db
      .select({
        id: households.id,
        slug: households.slug,
        name: households.name,
        created_at: households.created_at,
      })
      .from(households)
      .where(eq(households.id, id)),
  );
  if (!h) throw APIError.notFound("household not found");

  const members = await dbAll<{
    user_id: number;
    email: string;
    name: string | null;
    role: "owner" | "member";
    joined_at: string | null;
  }>(
    db
      .select({
        user_id: householdMembers.user_id,
        email: users.email,
        name: users.name,
        role: householdMembers.role,
        joined_at: householdMembers.joined_at,
      })
      .from(householdMembers)
      .innerJoin(users, eq(users.id, householdMembers.user_id))
      .where(eq(householdMembers.household_id, id)),
  );
  const myRole = members.find((m) => m.user_id === viewerId)?.role ?? "member";

  return {
    ...h,
    my_role: myRole,
    member_count: members.length,
    members,
  };
}

