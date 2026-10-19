import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import db from "../db/database";
import { loadDefaultGroupForUser, readUploadDefaults } from "./upload-defaults";

const MEMBER_ID = 95_101;
const LEFT_ID = 95_102;
const NONE_ID = 95_103;
let groupId = 0;

async function ensureUser(id: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, password_hash)
    VALUES (${id}, ${`user-${id}@upload-defaults.test`}, ${`User ${id}`}, 'x')
    ON CONFLICT (id) DO NOTHING
  `);
}

async function saveDefault(userId: number, group: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO documents_user_pref (user_id, key, value)
    VALUES (${userId}, 'upload_defaults', ${JSON.stringify({ group_id: group })}::jsonb)
    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value
  `);
}

describe("upload defaults", () => {
  beforeAll(async () => {
    for (const id of [MEMBER_ID, LEFT_ID, NONE_ID]) await ensureUser(id);
    const res = await db.execute<{ id: number }>(sql`
      INSERT INTO groups (slug, name) VALUES ('upload-defaults-test', 'Testgruppe')
      RETURNING id
    `);
    groupId = Number(res.rows[0]!.id);
    await db.execute(sql`
      INSERT INTO group_members (group_id, user_id) VALUES (${groupId}, ${MEMBER_ID})
    `);
    await saveDefault(MEMBER_ID, groupId);
    // Saved the group while a member, then left it.
    await saveDefault(LEFT_ID, groupId);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM groups WHERE id = ${groupId}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${MEMBER_ID}, ${LEFT_ID}, ${NONE_ID})`);
  });

  it("applies the saved group while the user is a member", async () => {
    expect(await readUploadDefaults(MEMBER_ID)).toEqual({
      group_id: groupId,
      saved_group_id: groupId,
      stale: false,
    });
    expect(await loadDefaultGroupForUser(MEMBER_ID, "upload")).toBe(groupId);
  });

  it("reports a group the user left as stale and falls back to private", async () => {
    expect(await readUploadDefaults(LEFT_ID)).toEqual({
      group_id: null,
      saved_group_id: groupId,
      stale: true,
    });
  });

  it("is neither set nor stale without a preference", async () => {
    expect(await readUploadDefaults(NONE_ID)).toEqual({
      group_id: null,
      saved_group_id: null,
      stale: false,
    });
  });

  it("logs the fallback only when a document is being created", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await loadDefaultGroupForUser(LEFT_ID)).toBeNull();
      expect(warn).not.toHaveBeenCalled();

      expect(await loadDefaultGroupForUser(LEFT_ID, 'inbox import "scan.pdf"')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('inbox import "scan.pdf"');
      expect(warn.mock.calls[0]![0]).toContain(`default group ${groupId}`);

      await loadDefaultGroupForUser(NONE_ID, "upload");
      await loadDefaultGroupForUser(MEMBER_ID, "upload");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
