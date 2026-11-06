import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import db from "../db/database";
import { handoverTokens, refreshTokens, sessions, users } from "../db/schema";
import { createUserLogic } from "./user.service";
import { validateToken } from "./auth.service";
import { createHandoverLogic, HANDOVER_TTL_MS, redeemHandoverLogic } from "./handover.service";

describe("session handover to the web app", () => {
  let user: { id: number };

  beforeEach(async () => {
    await db.delete(handoverTokens);
    await db.delete(refreshTokens);
    await db.delete(sessions);
    await db.delete(users);
    user = await createUserLogic({ email: "handover@test.local", name: "Handover", password: "secret123" });
  });

  it("issues a token that redeems for a session of the same user, once", async () => {
    const issued = await createHandoverLogic(user.id);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(new Date(issued.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(HANDOVER_TTL_MS);

    const session = await redeemHandoverLogic(issued.token);
    expect(session.user.id).toBe(user.id);
    expect(session.user.email).toBe("handover@test.local");
    expect(await validateToken(session.token)).toMatchObject({ userID: String(user.id) });
    expect(session.refreshToken).toBeTruthy();

    // Spent: the row is gone, a replay finds nothing.
    expect(await db.select().from(handoverTokens)).toEqual([]);
    await expect(redeemHandoverLogic(issued.token)).rejects.toThrow("invalid or expired");
  });

  it("refuses an expired, unknown or missing token", async () => {
    const issued = await createHandoverLogic(user.id);
    await db
      .update(handoverTokens)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(handoverTokens.token, issued.token));
    await expect(redeemHandoverLogic(issued.token)).rejects.toThrow("invalid or expired");
    await expect(redeemHandoverLogic("not-a-token")).rejects.toThrow("invalid or expired");
    await expect(redeemHandoverLogic("")).rejects.toThrow("required");
  });

  it("sweeps expired tokens when a new one is issued", async () => {
    const stale = await createHandoverLogic(user.id);
    await db
      .update(handoverTokens)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(handoverTokens.token, stale.token));
    const fresh = await createHandoverLogic(user.id);
    const rows = await db.select().from(handoverTokens);
    expect(rows.map((r) => r.token)).toEqual([fresh.token]);
  });
});
