import { hashSync } from "bcryptjs";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Seeds the database with initial roles, permissions, and an admin user.
 */
export function seed(db: DatabaseType): void {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST;
  if (isTest) return;

  // --- Seed default roles ---
  const defaultRoles = [
    { name: "Admin", description: "Full administrative access" },
    { name: "User", description: "Regular user access" },
  ];

  for (const role of defaultRoles) {
    const existing = db
      .prepare(`SELECT id FROM roles WHERE name = ?`)
      .get(role.name);
    if (!existing) {
      db.prepare(`INSERT INTO roles (name, description) VALUES (?, ?)`).run(
        role.name,
        role.description
      );
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
  ];

  for (const perm of allPermissions) {
    const existing = db
      .prepare(`SELECT id FROM permissions WHERE key = ?`)
      .get(perm.key);
    if (!existing) {
      db.prepare(`INSERT INTO permissions (key, description) VALUES (?, ?)`).run(
        perm.key,
        perm.description
      );
      console.log(`[seed] Created permission: ${perm.key}`);
    }
  }

  // --- Assign all permissions to Admin role ---
  const adminRole = db
    .prepare(`SELECT id FROM roles WHERE name = 'Admin'`)
    .get() as { id: number } | undefined;

  if (adminRole) {
    const permissions = db
      .prepare(`SELECT id FROM permissions`)
      .all() as { id: number }[];

    for (const perm of permissions) {
      const existing = db
        .prepare(`SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?`)
        .get(adminRole.id, perm.id);
      if (!existing) {
        db.prepare(`INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`).run(
          adminRole.id,
          perm.id
        );
      }
    }
    console.log(`[seed] Assigned all permissions to Admin role`);
  }

  // --- Assign basic permissions to User role ---
  const userRole = db
    .prepare(`SELECT id FROM roles WHERE name = 'User'`)
    .get() as { id: number } | undefined;

  if (userRole) {
    const userPermissions = ["users.read"];
    for (const key of userPermissions) {
      const perm = db
        .prepare(`SELECT id FROM permissions WHERE key = ?`)
        .get(key) as { id: number } | undefined;
      if (perm) {
        const existing = db
          .prepare(`SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?`)
          .get(userRole.id, perm.id);
        if (!existing) {
          db.prepare(`INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`).run(
            userRole.id,
            perm.id
          );
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
    .prepare(`SELECT id FROM users WHERE email = ?`)
    .get(adminEmail) as { id: number } | undefined;

  if (!existingUser) {
    const passwordHash = hashSync(adminPassword, 10);
    const result = db
      .prepare(`INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)`)
      .run(adminEmail, adminName, passwordHash);

    const adminUserId = result.lastInsertRowid;

    // Assign Admin role
    if (adminRole) {
      db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(
        adminUserId,
        adminRole.id
      );
    }

    console.log(`[seed] Created admin user: ${adminEmail}`);
  }
}
