import { hashSync } from "bcryptjs";
import { eq, and, inArray, notInArray } from "drizzle-orm";
import * as schema from "./schema";
import { categoryTaxonomy, flattenTaxonomy } from "../documents/taxonomy";
import { adminExcludedPermissions, allPermissions, defaultRoles, rolePermissionsMap } from "./role-defaults";

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
const ASSISTANT_ROLE = "Assistent User";

/** The module roles that carried `module.assistant` before #1648. */
const ASSISTANT_SOURCE_ROLES = ["Photo User", "Dokumente User", "Finance User", "Label User", "Zähler User"];

async function grantAssistantToModuleUsers(db: any): Promise<void> {
  const assistantRoleId = (await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, ASSISTANT_ROLE)))[0]?.id as number | undefined;
  if (!assistantRoleId) return;
  const sourceRoleIds = (await db
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(inArray(schema.roles.name, ASSISTANT_SOURCE_ROLES)) as { id: number }[]).map((r) => r.id);
  if (!sourceRoleIds.length) return;
  const holders = await db
    .selectDistinct({ user_id: schema.userRoles.user_id })
    .from(schema.userRoles)
    .where(inArray(schema.userRoles.role_id, sourceRoleIds)) as { user_id: number }[];
  for (const { user_id } of holders) {
    await db.insert(schema.userRoles).values({ user_id, role_id: assistantRoleId }).onConflictDoNothing();
    console.log(`[seed] Granted "${ASSISTANT_ROLE}" to user_id=${user_id} (assistant split from the module roles)`);
  }
}

export async function seed(db: any): Promise<void> {
  const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;
  if (isTest) return;

  // --- 1. Default roles (definitions in role-defaults.ts) ---
  const createdRoles = new Set<string>();
  for (const role of defaultRoles) {
    const existing = (await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.name, role.name)))[0];
    if (!existing) {
      await db.insert(schema.roles).values(role);
      createdRoles.add(role.name);
      console.log(`[seed] Created role: ${role.name}`);
    }
  }

  // --- 2. Permissions ---
  for (const perm of allPermissions) {
    const existing = (await db.select({ id: schema.permissions.id, description: schema.permissions.description }).from(schema.permissions).where(eq(schema.permissions.key, perm.key)))[0];
    if (!existing) {
      await db.insert(schema.permissions).values(perm);
      console.log(`[seed] Created permission: ${perm.key}`);
    } else if (existing.description !== perm.description) {
      // Descriptions are what the role editor shows next to each checkbox,
      // so they are the one place a warning actually reaches the person
      // granting the permission. Insert-only would have left every existing
      // deployment with the old text.
      await db.update(schema.permissions).set({ description: perm.description }).where(eq(schema.permissions.id, existing.id));
      console.log(`[seed] Updated description: ${perm.key}`);
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

  // --- 3b. Backfill: the assistant used to come with every module role
  //      (#1528) and is a role of its own now (#1648). Whoever held a module
  //      role when "Assistent User" appeared gets it once, so nobody loses
  //      the chat on upgrade. Only in the start that creates the role: on
  //      every later start an admin's withdrawal stands.
  if (createdRoles.has(ASSISTANT_ROLE)) {
    await grantAssistantToModuleUsers(db);
  }

  // --- 4. Enforce role -> permission assignments.
  //     This is additive *and* convergent: any extra permission currently
  //     attached to one of the managed roles but not in the declared set is
  //     removed. The Admin role is handled separately (all minus excluded).

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
      .select({
        id: schema.documentCategories.id,
        name: schema.documentCategories.name,
        icon: schema.documentCategories.icon,
        sort_order: schema.documentCategories.sort_order,
      })
      .from(schema.documentCategories)
      .where(eq(schema.documentCategories.slug, row.slug)))[0];
    if (!existing) {
      await db.insert(schema.documentCategories).values({
        slug: row.slug,
        name: row.name,
        icon: row.icon,
        sort_order: row.sort_order,
      });
      continue;
    }
    // Keep the presentation columns in step with the seed taxonomy. Inserting
    // once and never updating meant a category renamed in taxonomy.ts kept its
    // original label on every database that already had the row — the new name
    // only ever showed up on a fresh install. Slugs stay untouched: they are
    // the identity documents are attached by, so a slug change is a different
    // category and belongs in a migration.
    if (
      existing.name !== row.name ||
      existing.icon !== row.icon ||
      existing.sort_order !== row.sort_order
    ) {
      await db
        .update(schema.documentCategories)
        .set({ name: row.name, icon: row.icon, sort_order: row.sort_order })
        .where(eq(schema.documentCategories.id, existing.id));
    }
  }

  // Resolve parent_id references for rows whose parent slug exists.
  for (const row of taxonomyRows) {
    if (!row.parent_slug) {
      // A category promoted to top level in taxonomy.ts used to keep its old
      // parent_id forever: the loop skipped every row without a parent_slug and
      // so never cleared one. The classifier renders the taxonomy by walking
      // down from the roots (`_taxonomy_outline`), so a stale parent misfiles
      // the category in the outline — and if the old parent has meanwhile
      // become a child of this very category, the resulting cycle drops both,
      // plus everything beneath them, out of the prompt entirely. A label the
      // model is never shown can never be chosen.
      await db
        .update(schema.documentCategories)
        .set({ parent_id: null })
        .where(eq(schema.documentCategories.slug, row.slug));
      continue;
    }
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

  // Categories the database has but the seed taxonomy does not. The classifier
  // reads its label set from this table and its hints from taxonomy.ts, so such
  // a row is a label the model can pick but nothing describes — and the cloud
  // audit, which reads taxonomy.ts, can never agree with it. Reported rather
  // than deleted: removing a category moves documents, which is a migration's
  // job (0152), not a side effect of seeding.
  const seededSlugs = new Set(taxonomyRows.map((r) => r.slug));
  const orphans = (await db
    .select({ slug: schema.documentCategories.slug })
    .from(schema.documentCategories))
    .map((r) => r.slug)
    .filter((slug) => !seededSlugs.has(slug));
  if (orphans.length > 0) {
    console.warn(
      `[seed] ${orphans.length} document categor${orphans.length === 1 ? "y is" : "ies are"} ` +
        `not in the seed taxonomy and have no hint: ${orphans.join(", ")}. ` +
        `The classifier can still choose them. Remove them in a migration.`,
    );
  }

  // --- 7. Initial admin user ---
  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminName = process.env.ADMIN_NAME || "Admin";
  const adminPassword = process.env.ADMIN_PASSWORD;

  // Skipping the admin must not skip the rest of the seed: everything below
  // is unrelated to it, and an early return here left a deployment without
  // ADMIN_PASSWORD missing the AI system user too.
  if (!adminPassword) {
    console.warn(
      "[seed] ADMIN_PASSWORD not set — skipping initial admin user creation. " +
        "Make sure to set it in your .env file."
    );
  } else {
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
