import { hashSync } from "bcryptjs";
import { eq, and, inArray, notInArray } from "drizzle-orm";
import * as schema from "./schema";
import { categoryTaxonomy, flattenTaxonomy } from "../documents/taxonomy";

/**
 * Seeds the database with initial roles, permissions, an admin user, and the
 * document-management category taxonomy.
 *
 * Design notes:
 * - Module access is modeled as dedicated additive roles ("Photo User",
 *   "Dokumente User") rather than lumping everything into the base "User"
 *   role. This lets operators grant a user just one module.
 * - Every assignment step is idempotent: re-running the seed converges to the
 *   declared state without duplicating rows or clobbering user changes.
 * - The seed is a no-op under NODE_ENV=test / VITEST.
 */
export async function seed(db: any): Promise<void> {
  const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;
  if (isTest) return;

  // --- 1. Default roles ---
  const defaultRoles = [
    { name: "Admin", description: "Full administrative access" },
    { name: "User", description: "Basic user access (login, profile)" },
    { name: "Photo User", description: "Access to the photos module" },
    { name: "Dokumente User", description: "Access to the documents module" },
    { name: "Finance User", description: "Access to the finance module" },
    { name: "Label User", description: "Access to the label printing module" },
    { name: "Zähler User", description: "Access to the utility meters module" },
  ];

  for (const role of defaultRoles) {
    const existing = (await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, role.name)))[0];
    if (!existing) {
      await db.insert(schema.roles).values(role);
      console.log(`[seed] Created role: ${role.name}`);
    }
  }

  // --- 2. Permissions ---
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
    { key: "photos.purge", description: "Purge all photo-related data (destructive)" },
    { key: "photos.libraries.manage", description: "Configure external photo libraries" },
    // --- Documents module ---
    { key: "module.documents", description: "Enable documents module" },
    { key: "documents.view", description: "View documents" },
    { key: "documents.upload", description: "Upload documents" },
    { key: "documents.edit", description: "Edit document metadata and reclassify" },
    { key: "documents.delete", description: "Delete documents" },
    { key: "documents.manage_taxonomy", description: "Manage document categories and AI suggestions" },
    { key: "groups.view", description: "View groups the user belongs to" },
    { key: "groups.manage", description: "Create and edit groups, manage members" },
    // --- Finance module ---
    { key: "module.finance", description: "Enable finance module" },
    { key: "finance.view", description: "View accounts and transactions (ACL-filtered)" },
    { key: "finance.accounts.manage", description: "Manage bank contacts and accounts" },
    { key: "finance.admin", description: "Finance admin (ACL bypass, data import)" },
    // --- POI detection / OSM admin (Epic #383) ---
    { key: "osm.admin", description: "Manage self-hosted PostGIS region imports for reverse geocoding + POI lookup" },
    // --- Label module ---
    { key: "module.label", description: "Enable label printing module" },
    { key: "label.view", description: "View label module and select a printer" },
    { key: "label.print", description: "Print labels to a CUPS printer" },
    // --- Utility meters module (Issue #792) ---
    { key: "module.meters", description: "Enable utility meters module" },
    { key: "meters.view", description: "View meters, readings and reports" },
    { key: "meters.read_entry", description: "Enter meter readings (manual/OCR)" },
    { key: "meters.manage", description: "Create/edit/replace meters and manage API keys" },
  ];

  // Permissions that are NEVER auto-assigned to the Admin role.
  // These must be granted manually to a dedicated role for safety.
  //   - photos.purge wipes the photo library (destructive).
  //   - finance.admin bypasses the finance_account_access ACL.
  const adminExcludedPermissions = new Set<string>([
    "photos.purge",
    "finance.admin",
  ]);

  for (const perm of allPermissions) {
    const existing = (await db.select({ id: schema.permissions.id }).from(schema.permissions).where(eq(schema.permissions.key, perm.key)))[0];
    if (!existing) {
      await db.insert(schema.permissions).values(perm);
      console.log(`[seed] Created permission: ${perm.key}`);
    }
  }

  const allPermRows = await db
    .select({ id: schema.permissions.id, key: schema.permissions.key })
    .from(schema.permissions) as { id: number; key: string }[];
  const permIdByKey = new Map(allPermRows.map((p) => [p.key, p.id]));

  // --- 3. Backfill: existing users with role "User" are granted "Photo User"
  //     so they keep their previous photo access after the role split.
  //     Must run BEFORE enforcing the new permission sets on the "User" role
  //     (which no longer includes photo permissions).
  const userRoleId = (await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, "User")))[0]?.id as number | undefined;
  const photoUserRoleId = (await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, "Photo User")))[0]?.id as number | undefined;

  if (userRoleId && photoUserRoleId) {
    const usersWithUserRole = await db
      .select({ user_id: schema.userRoles.user_id })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.role_id, userRoleId)) as { user_id: number }[];

    for (const { user_id } of usersWithUserRole) {
      const existing = (await db
        .select({ user_id: schema.userRoles.user_id })
        .from(schema.userRoles)
        .where(and(
          eq(schema.userRoles.user_id, user_id),
          eq(schema.userRoles.role_id, photoUserRoleId)
        )))[0];
      if (!existing) {
        await db.insert(schema.userRoles).values({ user_id, role_id: photoUserRoleId });
        console.log(`[seed] Granted "Photo User" to user_id=${user_id} (migration from "User" role)`);
      }
    }
  }

  // --- 4. Enforce role -> permission assignments.
  //     This is additive *and* convergent: any extra permission currently
  //     attached to one of the managed roles but not in the declared set is
  //     removed. The Admin role is handled separately (all minus excluded).
  const rolePermissionsMap: Record<string, string[]> = {
    User: ["users.read"],
    "Photo User": [
      "module.photos",
      "photos.view",
      "photos.upload",
      "photos.delete",
      "people.view",
      "people.edit",
    ],
    "Dokumente User": [
      "module.documents",
      "documents.view",
      "documents.upload",
      "documents.edit",
      "documents.delete",
      "groups.view",
      "groups.manage",
    ],
    "Finance User": [
      "module.finance",
      "finance.view",
      "finance.accounts.manage",
    ],
    "Label User": [
      "module.label",
      "label.view",
      "label.print",
    ],
    "Zähler User": [
      "module.meters",
      "meters.view",
      "meters.read_entry",
    ],
  };

  for (const [roleName, permKeys] of Object.entries(rolePermissionsMap)) {
    const role = (await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, roleName)))[0] as { id: number } | undefined;
    if (!role) continue;

    const desiredPermIds = permKeys
      .map((k) => permIdByKey.get(k))
      .filter((id): id is number => typeof id === "number");

    // Add missing assignments.
    for (const permId of desiredPermIds) {
      const existing = (await db
        .select({ role_id: schema.rolePermissions.role_id })
        .from(schema.rolePermissions)
        .where(and(
          eq(schema.rolePermissions.role_id, role.id),
          eq(schema.rolePermissions.permission_id, permId)
        )))[0];
      if (!existing) {
        await db.insert(schema.rolePermissions).values({ role_id: role.id, permission_id: permId });
      }
    }

    // Remove stale assignments that are not in the declared set.
    // Permissions in adminExcludedPermissions (e.g. finance.admin) are
    // intentionally excluded from auto-management — if an admin manually
    // grants them to a role they must not be silently revoked on restart.
    const managedPermIds = [...permIdByKey.values()].filter(
      (id) => {
        const key = [...permIdByKey.entries()].find(([, v]) => v === id)?.[0];
        return key !== undefined && !adminExcludedPermissions.has(key);
      }
    );
    const staleClause = desiredPermIds.length > 0
      ? and(
          eq(schema.rolePermissions.role_id, role.id),
          inArray(schema.rolePermissions.permission_id, managedPermIds),
          notInArray(schema.rolePermissions.permission_id, desiredPermIds)
        )
      : and(
          eq(schema.rolePermissions.role_id, role.id),
          inArray(schema.rolePermissions.permission_id, managedPermIds)
        );
    await db.delete(schema.rolePermissions).where(staleClause);

    console.log(`[seed] Enforced permission set on role "${roleName}" (${permKeys.length} perms)`);
  }

  // --- 5. Admin role: all permissions except the excluded ones. ---
  const adminRole = (await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, "Admin")))[0] as { id: number } | undefined;

  if (adminRole) {
    for (const perm of allPermRows) {
      if (adminExcludedPermissions.has(perm.key)) continue;
      const existing = (await db.select({ role_id: schema.rolePermissions.role_id })
        .from(schema.rolePermissions)
        .where(and(
          eq(schema.rolePermissions.role_id, adminRole.id),
          eq(schema.rolePermissions.permission_id, perm.id)
        )))[0];
      if (!existing) {
        await db.insert(schema.rolePermissions).values({ role_id: adminRole.id, permission_id: perm.id });
      }
    }

    // Note: excluded permissions are only skipped during auto-assignment above.
    // They are NOT actively removed — admins who manually grant e.g. finance.admin
    // to the Admin role via the UI will keep that assignment across restarts.
    console.log(`[seed] Assigned all permissions to Admin role (excluded from auto-grant: ${[...adminExcludedPermissions].join(", ")})`);
  }

  // --- 6. Document categories (starter taxonomy). ---
  //     Two-pass insert so parent_id references resolve correctly.
  const taxonomyRows = flattenTaxonomy(categoryTaxonomy);

  for (const row of taxonomyRows) {
    const existing = (await db
      .select({ id: schema.documentCategories.id })
      .from(schema.documentCategories)
      .where(eq(schema.documentCategories.slug, row.slug)))[0];
    if (!existing) {
      await db.insert(schema.documentCategories).values({
        slug: row.slug,
        name: row.name,
        icon: row.icon,
        sort_order: row.sort_order,
      });
    }
  }

  // Resolve parent_id references for rows whose parent slug exists.
  for (const row of taxonomyRows) {
    if (!row.parent_slug) continue;
    const parent = (await db
      .select({ id: schema.documentCategories.id })
      .from(schema.documentCategories)
      .where(eq(schema.documentCategories.slug, row.parent_slug)))[0] as { id: number } | undefined;
    if (!parent) continue;
    await db
      .update(schema.documentCategories)
      .set({ parent_id: parent.id })
      .where(eq(schema.documentCategories.slug, row.slug));
  }
  console.log(`[seed] Ensured ${taxonomyRows.length} document categories`);

  // --- 7. Initial admin user ---
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

  const existingUser = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, adminEmail)))[0];

  if (!existingUser) {
    const passwordHash = hashSync(adminPassword, 10);
    const result = (await db.insert(schema.users)
      .values({ email: adminEmail, name: adminName, password_hash: passwordHash })
      .returning({ id: schema.users.id }))[0] as { id: number } | undefined;

    if (adminRole && result) {
      await db.insert(schema.userRoles).values({ user_id: result.id, role_id: adminRole.id });
    }

    console.log(`[seed] Created admin user: ${adminEmail}`);
  }

  // --- 8. AI system user (virtual participant for quality-based curation) ---
  const AI_USER_EMAIL = "ai@system.local";
  const existingAiUser = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, AI_USER_EMAIL)))[0];

  if (!existingAiUser) {
    // Password hash is a dummy — this user cannot log in (no valid bcrypt hash for any password)
    await db.insert(schema.users).values({
      email: AI_USER_EMAIL,
      name: "KI-Bewertung",
      password_hash: "$2a$10$NOLOGIN.SYSTEM.USER.AI.QUALITY.000000000000000000000",
    });
    console.log(`[seed] Created AI system user: ${AI_USER_EMAIL}`);
  }
}
