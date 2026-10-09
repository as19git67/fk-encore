/**
 * Which inbox folder belongs to which user.
 *
 * The inbox watcher (`inbox-watcher.ts`) takes the first folder below
 * `DOCUMENTS_INBOX_DIR` as the owner's login slug. The slug is derived
 * from the e-mail address, so nobody can read it off the user list; this
 * endpoint spells it out for the admin who sets up the scanner targets,
 * together with the group each owner's imports will land in.
 */

import { asc } from "drizzle-orm";
import { api, APIError } from "encore.dev/api";
import { getAuthData } from "~encore/auth";
import { requirePermission } from "../user/auth-handler";
import db from "../db/database";
import { dbAll } from "../db/adapter";
import { groups, users } from "../db/schema";
import { DOCUMENTS_INBOX_DIR, slugifyUserLogin } from "./documents.service";
import { loadDefaultGroupForUser } from "./import";
import { resolveInboxOwnerId } from "./inbox-watcher";

export interface InboxFolderEntry {
  user_id: number;
  name: string;
  email: string;
  /** First folder below the inbox root that routes files to this user. */
  folder: string;
  /** Group new imports for this user join, or null when they stay private. */
  default_group_id: number | null;
  default_group_name: string | null;
  /** Files outside any user folder go to this user. */
  is_fallback: boolean;
  /**
   * Another user with a lower id has the same slug; that user wins
   * the folder, this one cannot be reached through it.
   */
  shadowed: boolean;
}

export interface InboxFoldersResponse {
  inbox_dir: string;
  entries: InboxFolderEntry[];
}

export const listInboxFolders = api(
  { expose: true, method: "GET", path: "/documents/inbox-folders", auth: true },
  async (): Promise<InboxFoldersResponse> => {
    const authData = getAuthData();
    if (!authData) throw APIError.unauthenticated("Unauthorized");
    requirePermission(authData, "module.documents");
    requirePermission(authData, "data.manage");

    const [userRows, groupRows, fallbackId] = await Promise.all([
      dbAll<{ id: number; name: string; email: string }>(
        db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .orderBy(asc(users.id)),
      ),
      dbAll<{ id: number; name: string }>(
        db.select({ id: groups.id, name: groups.name }).from(groups),
      ),
      resolveInboxOwnerId(),
    ]);
    const groupNames = new Map(groupRows.map((g) => [g.id, g.name]));

    const seen = new Set<string>();
    const entries: InboxFolderEntry[] = [];
    for (const u of userRows) {
      const folder = slugifyUserLogin(u.email, u.id);
      const defaultGroupId = await loadDefaultGroupForUser(u.id);
      entries.push({
        user_id: u.id,
        name: u.name,
        email: u.email,
        folder,
        default_group_id: defaultGroupId,
        default_group_name:
          defaultGroupId == null ? null : (groupNames.get(defaultGroupId) ?? null),
        is_fallback: u.id === fallbackId,
        shadowed: seen.has(folder),
      });
      seen.add(folder);
    }

    return { inbox_dir: DOCUMENTS_INBOX_DIR, entries };
  },
);
