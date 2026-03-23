import { hashSync } from "bcryptjs";
import { eq, and } from "drizzle-orm";
import * as schema from "./schema";

// Thin adapter so seed works with both SQLite (sync) and Postgres (async) drizzle instances.
function makeAdapter(db: any) {
  const isPg = process.env.DB_TYPE?.toLowerCase() === 'postgres'
  return {
    async first<T>(q: any): Promise<T | undefined> {
      if (isPg) return (await q)[0]
      return q.get()
    },
    async all<T>(q: any): Promise<T[]> {
      if (isPg) return await q
      return q.all()
    },
    async exec(q: any): Promise<void> {
      if (isPg) { await q } else { q.run() }
    },
    async insertReturning<T>(q: any): Promise<T | undefined> {
      if (isPg) return (await q)[0]
      return q.get()
    },
  }
}

/**
 * Seeds the database with initial roles, permissions, and an admin user.
 * Works with both SQLite (better-sqlite3) and PostgreSQL (node-postgres) drizzle instances.
 */
export async function seed(db: any): Promise<void> {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST;
  if (isTest) return;

  const { first, all, exec, insertReturning } = makeAdapter(db)

  // --- Seed default roles ---
  const defaultRoles = [
    { name: "Admin", description: "Full administrative access" },
    { name: "User", description: "Regular user access" },
  ];

  for (const role of defaultRoles) {
    const existing = await first(
      db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, role.name))
    )
    if (!existing) {
      await exec(db.insert(schema.roles).values(role))
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
    { key: "photos.delete", description: "Delete photos" },
    { key: "photos.refresh_metadata", description: "Refresh photos metadata (EXIF)" },
    { key: "albums.manage", description: "Manage albums" },
    { key: "people.view", description: "View people and faces" },
    { key: "people.edit", description: "Edit people names and merge" },
    { key: "data.manage", description: "Access data management (reindex, maintenance)" },
  ];

  for (const perm of allPermissions) {
    const existing = await first(
      db.select({ id: schema.permissions.id }).from(schema.permissions).where(eq(schema.permissions.key, perm.key))
    )
    if (!existing) {
      await exec(db.insert(schema.permissions).values(perm))
      console.log(`[seed] Created permission: ${perm.key}`);
    }
  }

  // --- Assign all permissions to Admin role ---
  const adminRole = await first<{ id: number }>(
    db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, "Admin"))
  )

  if (adminRole) {
    const perms = await all<{ id: number }>(
      db.select({ id: schema.permissions.id }).from(schema.permissions)
    )

    for (const perm of perms) {
      const existing = await first(
        db.select({ role_id: schema.rolePermissions.role_id })
          .from(schema.rolePermissions)
          .where(and(
            eq(schema.rolePermissions.role_id, adminRole.id),
            eq(schema.rolePermissions.permission_id, perm.id)
          ))
      )
      if (!existing) {
        await exec(db.insert(schema.rolePermissions).values({ role_id: adminRole.id, permission_id: perm.id }))
      }
    }
    console.log(`[seed] Assigned all permissions to Admin role`);
  }

  // --- Assign basic permissions to User role ---
  const userRole = await first<{ id: number }>(
    db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, "User"))
  )

  if (userRole) {
    const userPermissions = ["users.read", "module.photos", "photos.view", "photos.upload", "photos.delete", "people.view", "people.edit"];
    for (const key of userPermissions) {
      const perm = await first<{ id: number }>(
        db.select({ id: schema.permissions.id }).from(schema.permissions).where(eq(schema.permissions.key, key))
      )
      if (perm) {
        const existing = await first(
          db.select({ role_id: schema.rolePermissions.role_id })
            .from(schema.rolePermissions)
            .where(and(
              eq(schema.rolePermissions.role_id, userRole.id),
              eq(schema.rolePermissions.permission_id, perm.id)
            ))
        )
        if (!existing) {
          await exec(db.insert(schema.rolePermissions).values({ role_id: userRole.id, permission_id: perm.id }))
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
        "Make sure to set it in your .env file."
    );
    return;
  }

  const existingUser = await first(
    db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, adminEmail))
  )

  if (!existingUser) {
    const passwordHash = hashSync(adminPassword, 10);
    const result = await insertReturning<{ id: number }>(
      db.insert(schema.users)
        .values({ email: adminEmail, name: adminName, password_hash: passwordHash })
        .returning({ id: schema.users.id })
    )

    if (adminRole && result) {
      await exec(db.insert(schema.userRoles).values({ user_id: result.id, role_id: adminRole.id }))
    }

    console.log(`[seed] Created admin user: ${adminEmail}`);
  }
}
