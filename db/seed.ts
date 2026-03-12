import { hashSync } from "bcryptjs";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Seeds the database with initial roles and an admin user.
 * Credentials are read from environment variables:
 *   - ADMIN_EMAIL    (default: admin@example.com)
 *   - ADMIN_NAME     (default: Admin)
 *   - ADMIN_PASSWORD (required, no default for safety)
 *
 * The seed only runs if the roles or admin user don't exist yet.
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
    const adminRole = db
      .prepare(`SELECT id FROM roles WHERE name = 'Admin'`)
      .get() as { id: number };

    if (adminRole) {
      db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(
        adminUserId,
        adminRole.id
      );
    }

    console.log(`[seed] Created admin user: ${adminEmail}`);
  }
}

