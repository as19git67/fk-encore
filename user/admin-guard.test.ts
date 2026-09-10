// The escalation #1164 described: three permissions that read like ordinary
// delegations and each amount to full Admin.
//
//   users.update  → change the administrator's password, log in as them
//   roles.assign  → give yourself the Admin role
//   roles.update  → rewrite what the Admin role means
//
// The rule these pin is narrow on purpose: whatever those permissions allow
// in general, doing it to an administrator or to the Admin role also
// requires being one. An administrator notices nothing; a delegate managing
// ordinary accounts and ordinary roles notices nothing either.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getAuthData } from "~encore/auth";

import db from "../db/database";
import { users, roles, userRoles, permissions, rolePermissions, sessions } from "../db/schema";
import { createUserLogic } from "./user.service";
import { updateUser, deleteUser } from "./user";
import { assignRole, removeRole } from "./user-roles";
import { updateRole, deleteRole, assignPermission, revokePermission } from "../role/role";
import { ADMIN_ROLE_NAME, isAdminRole, isAdminUser } from "./admin-guard";

const PASSWORD = "correct-horse";

/** Everything the three permissions cover, so only the guard can refuse. */
const DELEGATE_PERMISSIONS = [
  "users.update",
  "users.delete",
  "roles.assign",
  "roles.revoke",
  "roles.update",
  "roles.delete",
];

let admin: { id: number };
let secondAdmin: { id: number };
let delegate: { id: number };
let ordinary: { id: number };
let adminRoleId: number;
let plainRoleId: number;
let somePermissionId: number;

function actingAs(user: { id: number }, perms: string[] = DELEGATE_PERMISSIONS) {
  vi.mocked(getAuthData).mockReturnValue({ userID: String(user.id), permissions: perms });
}

async function makeRole(name: string): Promise<number> {
  const [row] = await db.insert(roles).values({ name, description: name }).returning({ id: roles.id });
  return row!.id;
}

beforeEach(async () => {
  await db.delete(rolePermissions);
  await db.delete(userRoles);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(roles);
  await db.delete(permissions);

  admin = await createUserLogic({ email: "admin@test.local", name: "A", password: PASSWORD });
  secondAdmin = await createUserLogic({ email: "admin2@test.local", name: "A2", password: PASSWORD });
  delegate = await createUserLogic({ email: "delegate@test.local", name: "D", password: PASSWORD });
  ordinary = await createUserLogic({ email: "user@test.local", name: "U", password: PASSWORD });

  adminRoleId = await makeRole(ADMIN_ROLE_NAME);
  plainRoleId = await makeRole("Photo User");
  await db.insert(userRoles).values([
    { user_id: admin.id, role_id: adminRoleId },
    { user_id: secondAdmin.id, role_id: adminRoleId },
    { user_id: delegate.id, role_id: plainRoleId },
  ]);

  const [perm] = await db
    .insert(permissions)
    .values({ key: "photos.view", description: "View photos" })
    .returning({ id: permissions.id });
  somePermissionId = perm!.id;

  actingAs(delegate);
});

describe("the helpers", () => {
  it("recognizes who is an administrator", async () => {
    expect(await isAdminUser(admin.id)).toBe(true);
    expect(await isAdminUser(delegate.id)).toBe(false);
    expect(await isAdminUser(ordinary.id)).toBe(false);
  });

  it("recognizes the Admin role", async () => {
    expect(await isAdminRole(adminRoleId)).toBe(true);
    expect(await isAdminRole(plainRoleId)).toBe(false);
  });
});

describe("users.update on an administrator", () => {
  it("is refused for a delegate — this was the takeover", async () => {
    const before = (await db.select().from(users).where(eq(users.id, admin.id)))[0]!;

    await expect(
      (updateUser as any)({ id: admin.id, password: "brand-new-password" }),
    ).rejects.toThrow(/only an administrator/);

    // Refusing is only half of it — the password must be untouched.
    const after = (await db.select().from(users).where(eq(users.id, admin.id)))[0]!;
    expect(after.password_hash).toBe(before.password_hash);
  });

  it("is refused even when only the email is touched", async () => {
    // A password reset to a mailbox you control is the same takeover, one
    // step longer.
    await expect(
      (updateUser as any)({ id: admin.id, email: "attacker@test.local" }),
    ).rejects.toThrow(/only an administrator/);
  });

  it("still works on an ordinary account", async () => {
    const updated = await (updateUser as any)({ id: ordinary.id, name: "Renamed" });
    expect(updated.name).toBe("Renamed");
  });

  it("is allowed for another administrator", async () => {
    actingAs(admin);
    const updated = await (updateUser as any)({ id: secondAdmin.id, name: "Still admin" });
    expect(updated.name).toBe("Still admin");
  });

  it("never blocks somebody editing themselves", async () => {
    actingAs(admin);
    const updated = await (updateUser as any)({ id: admin.id, name: "Myself" });
    expect(updated.name).toBe("Myself");
  });
});

describe("users.delete on an administrator", () => {
  it("is refused for a delegate", async () => {
    await expect((deleteUser as any)({ id: admin.id })).rejects.toThrow(/only an administrator/);
    expect(await db.select().from(users).where(eq(users.id, admin.id))).toHaveLength(1);
  });

  it("still works on an ordinary account", async () => {
    await (deleteUser as any)({ id: ordinary.id });
    expect(await db.select().from(users).where(eq(users.id, ordinary.id))).toHaveLength(0);
  });
});

describe("roles.assign of the Admin role", () => {
  it("is refused for a delegate — no self-promotion", async () => {
    await expect(
      (assignRole as any)({ userId: delegate.id, roleId: adminRoleId }),
    ).rejects.toThrow(/only an administrator/);
    expect(await isAdminUser(delegate.id)).toBe(false);
  });

  it("still assigns an ordinary role", async () => {
    const res = await (assignRole as any)({ userId: ordinary.id, roleId: plainRoleId });
    expect(res.roles.map((r: any) => r.id)).toContain(plainRoleId);
  });

  it("is allowed for an administrator", async () => {
    actingAs(admin);
    await (assignRole as any)({ userId: ordinary.id, roleId: adminRoleId });
    expect(await isAdminUser(ordinary.id)).toBe(true);
  });
});

describe("roles.revoke of the Admin role", () => {
  it("is refused for a delegate — no locking the admins out", async () => {
    await expect(
      (removeRole as any)({ userId: admin.id, roleId: adminRoleId }),
    ).rejects.toThrow(/only an administrator/);
    expect(await isAdminUser(admin.id)).toBe(true);
  });

  it("still revokes an ordinary role", async () => {
    await (removeRole as any)({ userId: delegate.id, roleId: plainRoleId });
    const held = await db.select().from(userRoles).where(eq(userRoles.user_id, delegate.id));
    expect(held).toHaveLength(0);
  });
});

describe("roles.update on the Admin role", () => {
  it("refuses a delegate adding a permission to it", async () => {
    await expect(
      (assignPermission as any)({ roleId: adminRoleId, permissionId: somePermissionId }),
    ).rejects.toThrow(/only an administrator/);
  });

  it("refuses a delegate taking one away", async () => {
    await db.insert(rolePermissions).values({ role_id: adminRoleId, permission_id: somePermissionId });
    await expect(
      (revokePermission as any)({ roleId: adminRoleId, permissionId: somePermissionId }),
    ).rejects.toThrow(/only an administrator/);
  });

  it("refuses a delegate renaming or deleting it", async () => {
    await expect(
      (updateRole as any)({ id: adminRoleId, name: "Not Admin Anymore" }),
    ).rejects.toThrow(/only an administrator/);
    await expect((deleteRole as any)({ id: adminRoleId })).rejects.toThrow(/only an administrator/);
  });

  it("leaves ordinary roles alone", async () => {
    const res = await (assignPermission as any)({
      roleId: plainRoleId,
      permissionId: somePermissionId,
    });
    expect(res.permissions.map((p: any) => p.id)).toContain(somePermissionId);
  });

  it("is allowed for an administrator", async () => {
    actingAs(admin);
    const res = await (assignPermission as any)({
      roleId: adminRoleId,
      permissionId: somePermissionId,
    });
    expect(res.permissions.map((p: any) => p.id)).toContain(somePermissionId);
  });
});

describe("what the guard deliberately does not cover", () => {
  it("still lets roles.update stack permissions onto another role", async () => {
    // Documented rather than fixed: the obvious rule — you may only grant
    // what you hold — would also stop administrators granting photos.purge
    // and finance.admin, which the seed keeps off the Admin role on
    // purpose. roles.update stays admin-equivalent by nature.
    const res = await (assignPermission as any)({
      roleId: plainRoleId,
      permissionId: somePermissionId,
    });
    expect(res.permissions.map((p: any) => p.id)).toContain(somePermissionId);
  });
});
