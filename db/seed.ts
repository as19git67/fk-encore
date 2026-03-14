import { hashSync } from "bcryptjs";
import { eq, and } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

/**
 * Seeds the database with initial roles, permissions, and an admin user.
 */
export function seed(db: BetterSQLite3Database<typeof schema>): void {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST;
  if (isTest) return;

  // --- Seed default roles ---
  const defaultRoles = [
    { name: "Admin", description: "Full administrative access" },
    { name: "User", description: "Regular user access" },
  ];

  for (const role of defaultRoles) {
    const existing = db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.name, role.name))
      .get();
    if (!existing) {
      db.insert(schema.roles).values(role).run();
      console.log(`[seed] Created role: ${role.name}`);
    }
  }

  // --- Seed permissions ---
  const allPermissions = [
    { key: "users.list", description: "View user list" },
    { key: "users.read", description: "View user details" },
    { key: "users.create", description: "Create new users" },
    { key: "users.update", description: "Update existing users" },
    { key: "users.delete", description: "Delete users" },
    { key: "roles.list", description: "View role list" },
    { key: "roles.read", description: "View role details" },
    { key: "roles.create", description: "Create new roles" },
    { key: "roles.update", description: "Update existing roles" },
    { key: "roles.delete", description: "Delete roles" },
    { key: "roles.assign", description: "Assign roles to users" },
    { key: "roles.revoke", description: "Revoke roles from users" },
    { key: "module.photos", description: "Enable photos module" },
    { key: "photos.upload", description: "Upload photos" },
    { key: "photos.view", description: "View photos" },
    { key: "albums.manage", description: "Manage albums" },
  ];

  for (const perm of allPermissions) {
    const existing = db
      .select({ id: schema.permissions.id })
      .from(schema.permissions)
      .where(eq(schema.permissions.key, perm.key))
      .get();
    if (!existing) {
      db.insert(schema.permissions).values(perm).run();
      console.log(`[seed] Created permission: ${perm.key}`);
    }
  }

  // --- Assign all permissions to Admin role ---
  const adminRole = db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.name, "Admin"))
    .get();

  if (adminRole) {
    const perms = db.select({ id: schema.permissions.id }).from(schema.permissions).all();

    for (const perm of perms) {
      const existing = db
        .select({ role_id: schema.rolePermissions.role_id })
        .from(schema.rolePermissions)
        .where(
          and(
            eq(schema.rolePermissions.role_id, adminRole.id),
            eq(schema.rolePermissions.permission_id, perm.id)
          )
        )
        .get();
      if (!existing) {
        db.insert(schema.rolePermissions)
          .values({ role_id: adminRole.id, permission_id: perm.id })
          .run();
      }
    }
    console.log(`[seed] Assigned all permissions to Admin role`);
  }

  // --- Assign basic permissions to User role ---
  const userRole = db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.name, "User"))
    .get();

  if (userRole) {
    const userPermissions = ["users.read", "module.photos", "photos.view", "photos.upload"];
    for (const key of userPermissions) {
      const perm = db
        .select({ id: schema.permissions.id })
        .from(schema.permissions)
        .where(eq(schema.permissions.key, key))
        .get();
      if (perm) {
        const existing = db
          .select({ role_id: schema.rolePermissions.role_id })
          .from(schema.rolePermissions)
          .where(
            and(
              eq(schema.rolePermissions.role_id, userRole.id),
              eq(schema.rolePermissions.permission_id, perm.id)
            )
          )
          .get();
        if (!existing) {
          db.insert(schema.rolePermissions)
            .values({ role_id: userRole.id, permission_id: perm.id })
            .run();
        }
      }
    }
    console.log(`[seed] Assigned basic permissions to User role`);
  }

  // --- Seed initial admin user ---
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminName = process.env.ADMIN_NAME || "Admin";
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    console.warn(
      "[seed] ADMIN_PASSWORD not set — skipping initial admin user creation. " +
        "Set ADMIN_PASSWORD environment variable to create the admin user."
    );
    return;
  }

  const existingUser = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, adminEmail))
    .get();

  if (!existingUser) {
    const passwordHash = hashSync(adminPassword, 10);
    const result = db
      .insert(schema.users)
      .values({ email: adminEmail, name: adminName, password_hash: passwordHash })
      .returning({ id: schema.users.id })
      .get();

    // Assign Admin role
    if (adminRole) {
      db.insert(schema.userRoles)
        .values({ user_id: result.id, role_id: adminRole.id })
        .run();
    }

    console.log(`[seed] Created admin user: ${adminEmail}`);
  }
}
