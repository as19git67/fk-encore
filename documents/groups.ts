/**
 * Group management endpoints.
 *
 * A group groups users who share a pool of documents. Every member
 * can see and upload into the group; only `owner`-role members can
 * rename the group, add/remove members, or delete it.
 *
 * Every document belongs to either a single user (`visibility='private'`)
 * or a single group (`visibility='group'`). Private and shared
 * documents coexist per user — a family member's personal tax folder is
 * not exposed to the family pool.
 */

import { and, eq } from "drizzle-orm";
import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll, dbFirst } from "../db/adapter";
import { groupMembers, groups, users } from "../db/schema";
import { slugifyName } from "./documents.service";
import {
  assertGroupMember,
  assertGroupOwner,
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

export interface GroupMemberDTO {
  user_id: number;
  email: string;
  name: string | null;
  role: "owner" | "member";
  joined_at: string | null;
}

export interface GroupDTO {
  id: number;
  slug: string;
  name: string;
  created_at: string | null;
  /** Caller's role in this group. */
  my_role: "owner" | "member";
  member_count: number;
}

export interface GroupDetailDTO extends GroupDTO {
  members: GroupMemberDTO[];
}

/** List every group the caller belongs to. */
export const listGroups = api(
  { expose: true, method: "GET", path: "/groups", auth: true },
  async (): Promise<{ items: GroupDTO[] }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "groups.view");
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
          id: groups.id,
          slug: groups.slug,
          name: groups.name,
          created_at: groups.created_at,
          my_role: groupMembers.role,
        })
        .from(groups)
        .innerJoin(
          groupMembers,
          and(
            eq(groupMembers.group_id, groups.id),
            eq(groupMembers.user_id, userId),
          ),
        ),
    );

    // Count members per group in one go — trivially small (a handful
    // at most per user).
    const items: GroupDTO[] = [];
    for (const r of rows) {
      const members = await dbAll<{ user_id: number }>(
        db
          .select({ user_id: groupMembers.user_id })
          .from(groupMembers)
          .where(eq(groupMembers.group_id, r.id)),
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

export const getGroup = api(
  { expose: true, method: "GET", path: "/groups/:id", auth: true },
  async ({ id }: { id: number }): Promise<GroupDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "groups.view");
    const userId = getUserId();

    await assertGroupMember(userId, id);

    const h = await dbFirst<{
      id: number;
      slug: string;
      name: string;
      created_at: string | null;
    }>(
      db
        .select({
          id: groups.id,
          slug: groups.slug,
          name: groups.name,
          created_at: groups.created_at,
        })
        .from(groups)
        .where(eq(groups.id, id)),
    );
    if (!h) throw APIError.notFound("group not found");

    const members = await dbAll<{
      user_id: number;
      email: string;
      name: string | null;
      role: "owner" | "member";
      joined_at: string | null;
    }>(
      db
        .select({
          user_id: groupMembers.user_id,
          email: users.email,
          name: users.name,
          role: groupMembers.role,
          joined_at: groupMembers.joined_at,
        })
        .from(groupMembers)
        .innerJoin(users, eq(users.id, groupMembers.user_id))
        .where(eq(groupMembers.group_id, id)),
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

export interface CreateGroupRequest {
  name: string;
}

/**
 * Create a new group. The caller becomes its first member with
 * `owner` role. The slug is derived from the name and uniqueness is
 * enforced at the DB level; colliding names get a numeric suffix.
 */
export const createGroup = api(
  { expose: true, method: "POST", path: "/groups", auth: true },
  async ({ name }: CreateGroupRequest): Promise<GroupDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "groups.manage");
    const userId = getUserId();

    const trimmed = (name ?? "").trim();
    if (trimmed.length === 0) {
      throw APIError.invalidArgument("name must not be empty");
    }
    if (trimmed.length > 120) {
      throw APIError.invalidArgument("name must not exceed 120 characters");
    }

    const slug = await uniqueGroupSlug(trimmed);

    const created = await dbFirst<{ id: number }>(
      db
        .insert(groups)
        .values({ slug, name: trimmed })
        .returning({ id: groups.id }),
    );
    if (!created) throw new Error("insert groups: no row returned");

    await db
      .insert(groupMembers)
      .values({ group_id: created.id, user_id: userId, role: "owner" });

    return await getGroupDetail(created.id, userId);
  },
);

export interface UpdateGroupRequest {
  id: number;
  name: string;
}

export const updateGroup = api(
  { expose: true, method: "PATCH", path: "/groups/:id", auth: true },
  async ({ id, name }: UpdateGroupRequest): Promise<GroupDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "groups.manage");
    const userId = getUserId();

    await assertGroupOwner(userId, id);

    const trimmed = (name ?? "").trim();
    if (trimmed.length === 0) {
      throw APIError.invalidArgument("name must not be empty");
    }

    await db
      .update(groups)
      .set({ name: trimmed })
      .where(eq(groups.id, id));

    return await getGroupDetail(id, userId);
  },
);

export interface AddGroupMemberRequest {
  id: number;
  user_email: string;
  role?: "owner" | "member";
}

export const addGroupMember = api(
  { expose: true, method: "POST", path: "/groups/:id/members", auth: true },
  async ({ id, user_email, role }: AddGroupMemberRequest): Promise<GroupDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "groups.manage");
    const userId = getUserId();

    await assertGroupOwner(userId, id);

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
      .insert(groupMembers)
      .values({ group_id: id, user_id: target.id, role: desiredRole })
      .onConflictDoNothing();

    return await getGroupDetail(id, userId);
  },
);

export const removeGroupMember = api(
  {
    expose: true,
    method: "DELETE",
    path: "/groups/:id/members/:member_user_id",
    auth: true,
  },
  async ({
    id,
    member_user_id,
  }: {
    id: number;
    member_user_id: number;
  }): Promise<GroupDetailDTO> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "groups.manage");
    const userId = getUserId();

    await assertGroupOwner(userId, id);

    // Don't strand a group without any owner. If the target is the
    // last owner, refuse.
    const owners = await dbAll<{ user_id: number }>(
      db
        .select({ user_id: groupMembers.user_id })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.group_id, id),
            eq(groupMembers.role, "owner"),
          ),
        ),
    );
    if (
      owners.length <= 1 &&
      owners.some((o) => o.user_id === member_user_id)
    ) {
      throw APIError.failedPrecondition(
        "cannot remove the last owner of a group",
      );
    }

    await db
      .delete(groupMembers)
      .where(
        and(
          eq(groupMembers.group_id, id),
          eq(groupMembers.user_id, member_user_id),
        ),
      );

    return await getGroupDetail(id, userId);
  },
);

export const deleteGroup = api(
  { expose: true, method: "DELETE", path: "/groups/:id", auth: true },
  async ({ id }: { id: number }): Promise<{ success: boolean }> => {
    checkModule();
    const authData = getAuthData()!;
    requirePermission(authData, "groups.manage");
    const userId = getUserId();

    await assertGroupOwner(userId, id);

    // The `documents_group_id_fkey` FK uses ON DELETE RESTRICT, so
    // any lingering group-scoped document will fail this delete.
    // Surface that to the caller as a precondition error rather than a
    // raw SQL error.
    try {
      await db.delete(groups).where(eq(groups.id, id));
    } catch (err: any) {
      if (err?.code === "23503") {
        throw APIError.failedPrecondition(
          "group still owns documents — move or delete them first",
        );
      }
      throw err;
    }
    return { success: true };
  },
);

// ─── helpers ────────────────────────────────────────────────────────────────

async function uniqueGroupSlug(name: string): Promise<string> {
  const base = slugifyName(name, 48) || "gruppe";
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const hit = await dbFirst<{ id: number }>(
      db.select({ id: groups.id }).from(groups).where(eq(groups.slug, candidate)),
    );
    if (!hit) return candidate;
    candidate = `${base}-${i}`;
  }
  throw APIError.failedPrecondition("could not allocate a unique group slug");
}

async function getGroupDetail(
  id: number,
  viewerId: number,
): Promise<GroupDetailDTO> {
  const h = await dbFirst<{
    id: number;
    slug: string;
    name: string;
    created_at: string | null;
  }>(
    db
      .select({
        id: groups.id,
        slug: groups.slug,
        name: groups.name,
        created_at: groups.created_at,
      })
      .from(groups)
      .where(eq(groups.id, id)),
  );
  if (!h) throw APIError.notFound("group not found");

  const members = await dbAll<{
    user_id: number;
    email: string;
    name: string | null;
    role: "owner" | "member";
    joined_at: string | null;
  }>(
    db
      .select({
        user_id: groupMembers.user_id,
        email: users.email,
        name: users.name,
        role: groupMembers.role,
        joined_at: groupMembers.joined_at,
      })
      .from(groupMembers)
      .innerJoin(users, eq(users.id, groupMembers.user_id))
      .where(eq(groupMembers.group_id, id)),
  );
  const myRole = members.find((m) => m.user_id === viewerId)?.role ?? "member";

  return {
    ...h,
    my_role: myRole,
    member_count: members.length,
    members,
  };
}

