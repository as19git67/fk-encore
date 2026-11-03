/**
 * The demo owner (documentation/plans/demodaten.md, "Demo deployment"):
 * on the public demo, visitors sign in to look at the demo, so the demo must
 * not belong to the admin — whoever holds the admin login can remove the
 * demo, manage users and change settings.
 *
 * With `DEMO_OWNER_EMAIL` (and `DEMO_OWNER_PASSWORD`) set, every demo run —
 * at boot and from the Systemstatus card — belongs to that account instead:
 * a plain user with every module role and no Admin role. The run creates it
 * when it is missing. It is not a demo row: removing the demo leaves the
 * login in place, and `contentCounts` does not count it as a user, so the
 * system stays untouched with it.
 *
 * Without the variable the demo belongs to the admin who loads it, as
 * before (a test installation, the E2E stack).
 */

import { hashSync } from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import db from "../db/database";
import { defaultRoles } from "../db/role-defaults";
import { roles, userRoles, users } from "../db/schema";
import { DemoRefused } from "./run";

export interface DemoOwnerSetting {
  email: string;
  password: string;
  name: string;
}

/** The configured demo owner; null when the demo belongs to the admin. */
export function demoOwnerEmail(env: NodeJS.ProcessEnv = process.env): string | null {
  const email = (env.DEMO_OWNER_EMAIL ?? "").trim().toLowerCase();
  return email || null;
}

export function demoOwnerSetting(env: NodeJS.ProcessEnv = process.env): DemoOwnerSetting | null {
  const email = demoOwnerEmail(env);
  if (!email) return null;
  return { email, password: env.DEMO_OWNER_PASSWORD ?? "", name: (env.DEMO_OWNER_NAME ?? "").trim() || "Demo" };
}

/** Every default role but Admin: the demo owner sees every module and administers nothing. */
export const OWNER_ROLES = defaultRoles.map((r) => r.name).filter((n) => n !== "Admin");

/**
 * The user a demo run loaded by `adminId` belongs to: the configured demo
 * owner, created with its roles when missing, or the admin itself.
 */
export async function demoOwnerFor(adminId: number, setting: DemoOwnerSetting | null = demoOwnerSetting()): Promise<number> {
  if (!setting) return adminId;
  let [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, setting.email)).limit(1);
  if (!owner) {
    if (!setting.password) throw new DemoRefused("DEMO_OWNER_EMAIL is set but DEMO_OWNER_PASSWORD is not — the demo owner could not sign in");
    [owner] = await db
      .insert(users)
      .values({ email: setting.email, name: setting.name, password_hash: hashSync(setting.password, 10) })
      .returning({ id: users.id });
  }
  if (owner.id === adminId) throw new DemoRefused("DEMO_OWNER_EMAIL names the admin — the demo owner must be a separate account");

  // Its roles, every time: never Admin, always every module.
  const [admin] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "Admin"));
  if (admin) {
    const held = await db.select({ role: userRoles.role_id }).from(userRoles).where(eq(userRoles.user_id, owner.id));
    if (held.some((h) => h.role === admin.id)) {
      throw new DemoRefused(`${setting.email} holds the Admin role — the demo owner must not be an administrator`);
    }
  }
  const wanted = await db.select({ id: roles.id }).from(roles).where(inArray(roles.name, OWNER_ROLES));
  if (wanted.length) {
    await db.insert(userRoles).values(wanted.map((r) => ({ user_id: owner.id, role_id: r.id }))).onConflictDoNothing();
  }
  return owner.id;
}
