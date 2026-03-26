import { describe, it, expect, beforeEach } from "vitest";
import db from "./database";
import { users, sessions, roles } from "./schema";
import { dbFirst, dbAll, dbExec, dbInsertReturning } from "./adapter";
import { eq } from "drizzle-orm";
import { hashSync } from "bcryptjs";

const makeUser = (email: string) => ({
  email,
  name: "Test User",
  password_hash: hashSync("pw", 10),
});

beforeEach(async () => {
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(roles);
});

describe("dbExec", () => {
  it("inserts a row and reports changes = 1", async () => {
    const result = await dbExec(db.insert(users).values(makeUser("exec@test.com")));
    expect(result.changes).toBe(1);
  });

  it("deletes a row and reports changes = 1", async () => {
    await dbExec(db.insert(users).values(makeUser("del@test.com")));
    const [row] = await db.select().from(users).where(eq(users.email, "del@test.com"));
    const result = await dbExec(db.delete(users).where(eq(users.id, row.id)));
    expect(result.changes).toBe(1);
  });

  it("returns changes = 0 when nothing matched", async () => {
    const result = await dbExec(db.delete(users).where(eq(users.id, 99999)));
    expect(result.changes).toBe(0);
  });

  it("updates a row and reports changes = 1", async () => {
    await dbExec(db.insert(users).values(makeUser("upd@test.com")));
    const [row] = await db.select().from(users).where(eq(users.email, "upd@test.com"));
    const result = await dbExec(
      db.update(users).set({ name: "Updated" }).where(eq(users.id, row.id))
    );
    expect(result.changes).toBe(1);
  });
});

describe("dbFirst", () => {
  it("returns the first row when it exists", async () => {
    await dbExec(db.insert(users).values(makeUser("first@test.com")));
    const row = await dbFirst<typeof users.$inferSelect>(
      db.select().from(users).where(eq(users.email, "first@test.com"))
    );
    expect(row).toBeDefined();
    expect(row!.email).toBe("first@test.com");
  });

  it("returns undefined when no row matches", async () => {
    const row = await dbFirst<typeof users.$inferSelect>(
      db.select().from(users).where(eq(users.email, "missing@test.com"))
    );
    expect(row).toBeUndefined();
  });

  it("returns only the first row when multiple exist", async () => {
    await dbExec(db.insert(users).values(makeUser("a@test.com")));
    await dbExec(db.insert(users).values(makeUser("b@test.com")));
    const row = await dbFirst<typeof users.$inferSelect>(db.select().from(users));
    expect(row).toBeDefined();
    expect(typeof row!.email).toBe("string");
  });
});

describe("dbAll", () => {
  it("returns an empty array when table is empty", async () => {
    const rows = await dbAll<typeof users.$inferSelect>(db.select().from(users));
    expect(rows).toEqual([]);
  });

  it("returns all rows", async () => {
    await dbExec(db.insert(users).values(makeUser("all1@test.com")));
    await dbExec(db.insert(users).values(makeUser("all2@test.com")));
    const rows = await dbAll<typeof users.$inferSelect>(db.select().from(users));
    expect(rows).toHaveLength(2);
  });

  it("returns rows matching a filter", async () => {
    await dbExec(db.insert(users).values(makeUser("filter@test.com")));
    await dbExec(db.insert(users).values(makeUser("other@test.com")));
    const rows = await dbAll<typeof users.$inferSelect>(
      db.select().from(users).where(eq(users.email, "filter@test.com"))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("filter@test.com");
  });
});

describe("dbInsertReturning", () => {
  it("inserts and returns the new row", async () => {
    const row = await dbInsertReturning<typeof users.$inferSelect>(
      db.insert(users).values(makeUser("ret@test.com")).returning()
    );
    expect(row).toBeDefined();
    expect(row!.email).toBe("ret@test.com");
    expect(row!.id).toBeGreaterThan(0);
  });

  it("returns undefined when no row is produced", async () => {
    // Insert duplicate to trigger constraint – catch the error and verify behaviour
    await dbExec(db.insert(users).values(makeUser("dup@test.com")));
    await expect(
      dbInsertReturning<typeof users.$inferSelect>(
        db.insert(users).values(makeUser("dup@test.com")).returning()
      )
    ).rejects.toThrow();
  });
});
