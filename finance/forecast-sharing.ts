// Retirement forecast — sharing it within the household (migration 0215).
//
// The owner shares the forecast with a person or a group, to edit or to
// view. Someone it is shared with who keeps no forecast of their own works
// on the owner's directly (forecast-household.service.ts); someone who
// does keep one sees the offer and may switch, which deletes their own.

import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

import { requirePermission } from "../user/auth-handler";
import { getUserIdsWithPermission } from "../user/user.service";
import db from "../db/database";
import {
  financeForecastShare,
  groupMembers,
  groups,
  users,
} from "../db/schema";
import {
  deleteOwnForecast,
  groupIdsOf,
  hasOwnForecast,
  incomingShares,
  resolveHousehold,
  type HouseholdRole,
  type IncomingShare,
} from "./forecast-household.service";

console.log("[boot] finance/forecast-sharing.ts: all imports resolved");

export interface ShareDto {
  id: number;
  userId: number | null;
  userName: string | null;
  groupId: number | null;
  groupName: string | null;
  level: "edit" | "view";
}

export interface SharingState {
  /** The caller's role in the forecast they currently work on. */
  role: HouseholdRole;
  /** Whose forecast that is, when not the caller's own. */
  ownerName: string | null;
  /** The caller's own shares going out (only for an owner). */
  shares: ShareDto[];
  /** Forecasts shared with the caller that they do not work on (they keep their own). */
  offers: IncomingShare[];
  /** Whether the caller keeps a forecast of their own. */
  hasOwnForecast: boolean;
}

export interface ShareCandidates {
  users: Array<{ id: number; name: string }>;
  groups: Array<{ id: number; name: string }>;
}

interface CreateShareRequest {
  userId?: number;
  groupId?: number;
  level: "edit" | "view";
}

interface UpdateShareRequest {
  id: number;
  level: "edit" | "view";
}

interface IdRequest {
  id: number;
}

interface JoinRequest {
  ownerId: number;
}

function caller(): { id: number; isAdmin: boolean } {
  const auth = getAuthData()!;
  requirePermission(auth, "finance.view");
  return {
    id: Number(auth.userID),
    isAdmin: auth.permissions.includes("finance.admin"),
  };
}

async function sharesOf(ownerId: number): Promise<ShareDto[]> {
  const rows = await db
    .select({
      id: financeForecastShare.id,
      userId: financeForecastShare.target_user_id,
      userName: users.name,
      groupId: financeForecastShare.target_group_id,
      groupName: groups.name,
      level: financeForecastShare.level,
    })
    .from(financeForecastShare)
    .leftJoin(users, eq(users.id, financeForecastShare.target_user_id))
    .leftJoin(groups, eq(groups.id, financeForecastShare.target_group_id))
    .where(eq(financeForecastShare.owner_user_id, ownerId))
    .orderBy(asc(financeForecastShare.id));
  return rows.map((r) => ({
    ...r,
    userName: r.userId != null ? r.userName : null,
    groupName: r.groupId != null ? r.groupName : null,
  }));
}

const checkLevel = (level: unknown) => {
  if (level !== "edit" && level !== "view")
    throw APIError.invalidArgument("level must be edit or view");
};

async function sharingState(me: {
  id: number;
  isAdmin: boolean;
}): Promise<SharingState> {
  const access = await resolveHousehold(me.id, me.isAdmin);
  const own = await hasOwnForecast(me.id);
  const offers = (await incomingShares(me.id)).filter(
    (o) => o.ownerId !== access.ownerId,
  );
  let ownerName: string | null = null;
  if (access.role !== "owner") {
    const [u] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, access.ownerId));
    ownerName = u?.name ?? null;
  }
  return {
    role: access.role,
    ownerName,
    shares: access.role === "owner" ? await sharesOf(me.id) : [],
    offers: own ? offers : [],
    hasOwnForecast: own,
  };
}

export const getSharing = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/forecast/sharing",
    auth: true,
  },
  async (): Promise<SharingState> => sharingState(caller()),
);

/** Whom the owner can share with: users with finance access, and the groups the owner belongs to. */
export const getShareCandidates = api(
  {
    expose: true,
    method: "GET",
    path: "/finance/forecast/share-candidates",
    auth: true,
  },
  async (): Promise<ShareCandidates> => {
    const me = caller();
    const allowed = await getUserIdsWithPermission("finance.view");
    const userRows = allowed.length
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(and(inArray(users.id, allowed), ne(users.id, me.id)))
          .orderBy(asc(users.name))
      : [];
    const myGroups = await groupIdsOf(me.id);
    const groupRows = myGroups.length
      ? await db
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(inArray(groups.id, myGroups))
          .orderBy(asc(groups.name))
      : [];
    return { users: userRows, groups: groupRows };
  },
);

export const createShare = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/forecast/shares",
    auth: true,
  },
  async (req: CreateShareRequest): Promise<ShareDto> => {
    const me = caller();
    checkLevel(req.level);
    const access = await resolveHousehold(me.id, me.isAdmin);
    if (access.role !== "owner")
      throw APIError.permissionDenied("only the owner can share a forecast");
    if ((req.userId == null) === (req.groupId == null))
      throw APIError.invalidArgument("give either userId or groupId");
    if (req.userId != null) {
      if (req.userId === me.id)
        throw APIError.invalidArgument(
          "a forecast cannot be shared with its owner",
        );
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, req.userId));
      if (!u) throw APIError.notFound(`user ${req.userId} not found`);
    } else {
      // Only a group the owner belongs to.
      const [m] = await db
        .select({ id: groupMembers.group_id })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.group_id, req.groupId!),
            eq(groupMembers.user_id, me.id),
          ),
        );
      if (!m) throw APIError.notFound(`group ${req.groupId} not found`);
    }
    const existing = (await sharesOf(me.id)).find((s) =>
      req.userId != null ? s.userId === req.userId : s.groupId === req.groupId,
    );
    if (existing)
      throw APIError.alreadyExists("the forecast is already shared there");
    const [row] = await db
      .insert(financeForecastShare)
      .values({
        owner_user_id: me.id,
        target_user_id: req.userId ?? null,
        target_group_id: req.groupId ?? null,
        level: req.level,
      })
      .returning({ id: financeForecastShare.id });
    return (await sharesOf(me.id)).find((s) => s.id === row.id)!;
  },
);

export const updateShare = api(
  {
    expose: true,
    method: "PUT",
    path: "/finance/forecast/shares/:id",
    auth: true,
  },
  async (req: UpdateShareRequest): Promise<ShareDto> => {
    const me = caller();
    checkLevel(req.level);
    const [row] = await db
      .update(financeForecastShare)
      .set({ level: req.level })
      .where(
        and(
          eq(financeForecastShare.id, req.id),
          eq(financeForecastShare.owner_user_id, me.id),
        ),
      )
      .returning({ id: financeForecastShare.id });
    if (!row) throw APIError.notFound(`share ${req.id} not found`);
    return (await sharesOf(me.id)).find((s) => s.id === row.id)!;
  },
);

export const deleteShare = api(
  {
    expose: true,
    method: "DELETE",
    path: "/finance/forecast/shares/:id",
    auth: true,
  },
  async (req: IdRequest): Promise<void> => {
    const me = caller();
    const [row] = await db
      .delete(financeForecastShare)
      .where(
        and(
          eq(financeForecastShare.id, req.id),
          eq(financeForecastShare.owner_user_id, me.id),
        ),
      )
      .returning({ id: financeForecastShare.id });
    if (!row) throw APIError.notFound(`share ${req.id} not found`);
  },
);

/** Switch to a forecast shared with the caller; their own forecast is deleted. */
export const joinShare = api(
  {
    expose: true,
    method: "POST",
    path: "/finance/forecast/sharing/join",
    auth: true,
  },
  async (req: JoinRequest): Promise<SharingState> => {
    const me = caller();
    const offer = (await incomingShares(me.id)).find(
      (o) => o.ownerId === req.ownerId,
    );
    if (!offer)
      throw APIError.notFound("no forecast of that user is shared with you");
    await deleteOwnForecast(me.id);
    return sharingState(me);
  },
);
