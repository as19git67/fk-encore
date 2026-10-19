/**
 * The per-user default group for new documents (UI upload and inbox
 * import), stored as the `upload_defaults` preference.
 *
 * A saved group only applies while the user is still a member. When the
 * membership is gone (or the group was deleted) new documents fall back
 * to private. That fallback used to be silent; `readUploadDefaults`
 * reports it as `stale` so the UI can warn, and `loadDefaultGroupForUser`
 * logs it whenever a document actually lands private because of it.
 */

import { and, eq } from "drizzle-orm";
import db from "../db/database";
import { dbFirst } from "../db/adapter";
import { documentsUserPref } from "../db/schema";
import { assertGroupMember } from "./visibility";

export const UPLOAD_DEFAULTS_PREF_KEY = "upload_defaults";

export interface UploadDefaultsPref {
  group_id: number | null;
}

export interface UploadDefaultsState {
  /** Group new documents join, or null when they stay private. */
  group_id: number | null;
  /** Group the user saved, whether or not it still applies. */
  saved_group_id: number | null;
  /** A group is saved, but the user is no longer a member of it. */
  stale: boolean;
}

export async function readUploadDefaults(userId: number): Promise<UploadDefaultsState> {
  const row = await dbFirst<{ value: unknown }>(
    db
      .select({ value: documentsUserPref.value })
      .from(documentsUserPref)
      .where(
        and(
          eq(documentsUserPref.user_id, userId),
          eq(documentsUserPref.key, UPLOAD_DEFAULTS_PREF_KEY),
        ),
      ),
  );
  const saved = (row?.value as UploadDefaultsPref | null)?.group_id ?? null;
  if (saved == null) return { group_id: null, saved_group_id: null, stale: false };
  try {
    await assertGroupMember(userId, saved);
  } catch {
    return { group_id: null, saved_group_id: saved, stale: true };
  }
  return { group_id: saved, saved_group_id: saved, stale: false };
}

/**
 * The group a new document of this user joins, or null for private.
 * Pass `context` (what is being created) when a document is about to be
 * created, so a stale preference shows up in the log.
 */
export async function loadDefaultGroupForUser(
  userId: number,
  context?: string,
): Promise<number | null> {
  const state = await readUploadDefaults(userId);
  if (state.stale && context) {
    console.warn(
      `[documents] ${context}: user ${userId} has default group ${state.saved_group_id} but is no longer a member; the document stays private`,
    );
  }
  return state.group_id;
}
