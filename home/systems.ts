/**
 * Haus › Anlagen endpoints (documentation/plans/haus-anlagen.md, stage 1).
 *
 *   GET    /home/systems                       list (q, category, archived)      home.view
 *   GET    /home/share-groups                  groups a system can be shared with home.view
 *   POST   /home/systems                       create                            home.manage
 *   GET    /home/systems/:id                   detail with guides, items, notes  home.view
 *   PATCH  /home/systems/:id                   edit, share, archive              home.manage
 *   DELETE /home/systems/:id                                                     home.manage
 *   POST   /home/systems/:id/guides            new guide                         home.manage
 *   PATCH  /home/systems/:id/guides/:guideId   edit (keeps a revision)           home.manage
 *   DELETE /home/systems/:id/guides/:guideId                                     home.manage
 *   GET    /home/systems/:id/guides/:guideId/revisions                           home.view
 *   POST   /home/systems/:id/guides/:guideId/revisions/:revisionId/restore       home.manage
 *   POST   /home/systems/:id/items             item in place                     home.manage
 *   PATCH  /home/systems/:id/items/:itemId / DELETE                              home.manage
 *   POST   /home/systems/:id/notes             dated note                        home.manage
 *   PATCH  /home/systems/:id/notes/:noteId / DELETE                              home.manage
 *
 * The spare parts (stage 3) are in parts.ts. Who may change what is decided
 * in systems.service.ts.
 */

import { api, APIError, type Query } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import type { HomeItemAttribute } from "../db/schema";
import { loadHouseholdGroup, loadShareGroups, type ShareGroup } from "../lib/household";
import {
  createGuide,
  createItem,
  createNote,
  createSystem,
  deleteGuide,
  deleteItem,
  deleteNote,
  deleteSystem,
  getSystemDetail,
  listGuideRevisions,
  listSystems,
  restoreGuideRevision,
  updateGuide,
  updateItem,
  updateNote,
  updateSystem,
  type GuideRevision,
  type HomeSystemDetail,
  type HomeSystemListItem,
} from "./systems.service";

function requireUser(permission: string): number {
  const auth = getAuthData();
  if (!auth) throw APIError.unauthenticated("Unauthorized");
  requirePermission(auth, permission);
  return parseInt(auth.userID, 10);
}

// ── Systems ─────────────────────────────────────────────────────────────────

interface ShareGroupsResponse {
  /** Where a new system goes when no group is chosen. */
  householdId: number | null;
  groups: ShareGroup[];
}

// The house module does not need `groups.view`: the sharing choice lists the
// caller's own groups from here.
export const listHomeShareGroups = api(
  { expose: true, method: "GET", path: "/home/share-groups", auth: true },
  async (): Promise<ShareGroupsResponse> => {
    const userId = requireUser("home.view");
    const [household, groups] = await Promise.all([loadHouseholdGroup(userId), loadShareGroups(userId)]);
    return { householdId: household?.id ?? null, groups };
  },
);

interface ListSystemsRequest {
  q?: Query<string>;
  category?: Query<string>;
  archived?: Query<boolean>;
}

export const listHomeSystems = api(
  { expose: true, method: "GET", path: "/home/systems", auth: true },
  async (req: ListSystemsRequest): Promise<{ systems: HomeSystemListItem[] }> => {
    const userId = requireUser("home.view");
    return {
      systems: await listSystems(userId, {
        q: req.q,
        category: req.category || undefined,
        archived: req.archived ?? false,
      }),
    };
  },
);

interface SystemFields {
  name: string;
  category: string;
  location?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  installedOn?: string | null;
  description?: string | null;
  /** Omitted: the caller's household; null: private. */
  groupId?: number | null;
}

export const createHomeSystem = api(
  { expose: true, method: "POST", path: "/home/systems", auth: true },
  async (req: SystemFields): Promise<{ id: number }> => {
    const userId = requireUser("home.manage");
    return await createSystem(userId, req);
  },
);

export const getHomeSystem = api(
  { expose: true, method: "GET", path: "/home/systems/:id", auth: true },
  async ({ id }: { id: number }): Promise<HomeSystemDetail> => {
    const userId = requireUser("home.view");
    return await getSystemDetail(userId, id);
  },
);

interface UpdateSystemRequest {
  id: number;
  name?: string;
  category?: string;
  location?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  installedOn?: string | null;
  description?: string | null;
  groupId?: number | null;
  archived?: boolean;
}

export const updateHomeSystem = api(
  { expose: true, method: "PATCH", path: "/home/systems/:id", auth: true },
  async ({ id, ...patch }: UpdateSystemRequest): Promise<HomeSystemDetail> => {
    const userId = requireUser("home.manage");
    await updateSystem(userId, id, patch);
    return await getSystemDetail(userId, id);
  },
);

export const deleteHomeSystem = api(
  { expose: true, method: "DELETE", path: "/home/systems/:id", auth: true },
  async ({ id }: { id: number }): Promise<void> => {
    const userId = requireUser("home.manage");
    await deleteSystem(userId, id);
  },
);

// ── Guides ──────────────────────────────────────────────────────────────────

interface CreateGuideRequest {
  id: number;
  title: string;
  body?: string;
}

export const createHomeGuide = api(
  { expose: true, method: "POST", path: "/home/systems/:id/guides", auth: true },
  async ({ id, ...input }: CreateGuideRequest): Promise<{ id: number }> => {
    const userId = requireUser("home.manage");
    return await createGuide(userId, id, input);
  },
);

interface UpdateGuideRequest {
  id: number;
  guideId: number;
  title?: string;
  body?: string;
  sort?: number;
}

export const updateHomeGuide = api(
  { expose: true, method: "PATCH", path: "/home/systems/:id/guides/:guideId", auth: true },
  async ({ id, guideId, ...patch }: UpdateGuideRequest): Promise<void> => {
    const userId = requireUser("home.manage");
    await updateGuide(userId, id, guideId, patch);
  },
);

export const deleteHomeGuide = api(
  { expose: true, method: "DELETE", path: "/home/systems/:id/guides/:guideId", auth: true },
  async ({ id, guideId }: { id: number; guideId: number }): Promise<void> => {
    const userId = requireUser("home.manage");
    await deleteGuide(userId, id, guideId);
  },
);

export const listHomeGuideRevisions = api(
  { expose: true, method: "GET", path: "/home/systems/:id/guides/:guideId/revisions", auth: true },
  async ({ id, guideId }: { id: number; guideId: number }): Promise<{ revisions: GuideRevision[] }> => {
    const userId = requireUser("home.view");
    return { revisions: await listGuideRevisions(userId, id, guideId) };
  },
);

export const restoreHomeGuideRevision = api(
  {
    expose: true,
    method: "POST",
    path: "/home/systems/:id/guides/:guideId/revisions/:revisionId/restore",
    auth: true,
  },
  async ({ id, guideId, revisionId }: { id: number; guideId: number; revisionId: number }): Promise<void> => {
    const userId = requireUser("home.manage");
    await restoreGuideRevision(userId, id, guideId, revisionId);
  },
);

// ── Items in place ──────────────────────────────────────────────────────────

interface CreateItemRequest {
  id: number;
  label: string;
  location?: string | null;
  attributes?: HomeItemAttribute[];
  /** The part this unit takes; it is fitted to the system as well. */
  partId?: number | null;
}

export const createHomeItem = api(
  { expose: true, method: "POST", path: "/home/systems/:id/items", auth: true },
  async ({ id, ...input }: CreateItemRequest): Promise<{ id: number }> => {
    const userId = requireUser("home.manage");
    return await createItem(userId, id, input);
  },
);

interface UpdateItemRequest {
  id: number;
  itemId: number;
  label?: string;
  location?: string | null;
  attributes?: HomeItemAttribute[];
  partId?: number | null;
  sort?: number;
}

export const updateHomeItem = api(
  { expose: true, method: "PATCH", path: "/home/systems/:id/items/:itemId", auth: true },
  async ({ id, itemId, ...patch }: UpdateItemRequest): Promise<void> => {
    const userId = requireUser("home.manage");
    await updateItem(userId, id, itemId, patch);
  },
);

export const deleteHomeItem = api(
  { expose: true, method: "DELETE", path: "/home/systems/:id/items/:itemId", auth: true },
  async ({ id, itemId }: { id: number; itemId: number }): Promise<void> => {
    const userId = requireUser("home.manage");
    await deleteItem(userId, id, itemId);
  },
);

// ── Notes ───────────────────────────────────────────────────────────────────

interface CreateNoteRequest {
  id: number;
  body: string;
  notedOn?: string | null;
}

export const createHomeNote = api(
  { expose: true, method: "POST", path: "/home/systems/:id/notes", auth: true },
  async ({ id, ...input }: CreateNoteRequest): Promise<{ id: number }> => {
    const userId = requireUser("home.manage");
    return await createNote(userId, id, input);
  },
);

interface UpdateNoteRequest {
  id: number;
  noteId: number;
  body?: string;
  notedOn?: string | null;
}

export const updateHomeNote = api(
  { expose: true, method: "PATCH", path: "/home/systems/:id/notes/:noteId", auth: true },
  async ({ id, noteId, ...patch }: UpdateNoteRequest): Promise<void> => {
    const userId = requireUser("home.manage");
    await updateNote(userId, id, noteId, patch);
  },
);

export const deleteHomeNote = api(
  { expose: true, method: "DELETE", path: "/home/systems/:id/notes/:noteId", auth: true },
  async ({ id, noteId }: { id: number; noteId: number }): Promise<void> => {
    const userId = requireUser("home.manage");
    await deleteNote(userId, id, noteId);
  },
);
