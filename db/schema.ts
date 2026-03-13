import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ========== Users ==========

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").unique().notNull(),
  name: text("name").notNull(),
  password_hash: text("password_hash").notNull(),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  updated_at: text("updated_at").default(sql`(datetime('now'))`),
});

// ========== Roles ==========

export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").unique().notNull(),
  description: text("description").default(""),
});

// ========== User Roles (Many-to-Many) ==========

export const userRoles = sqliteTable(
  "user_roles",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role_id: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.role_id] })]
);

// ========== Sessions ==========

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  expires_at: text("expires_at").notNull(),
});

// ========== Passkeys ==========

export const passkeys = sqliteTable("passkeys", {
  credential_id: text("credential_id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  public_key: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  device_type: text("device_type").notNull().default("singleDevice"),
  backed_up: integer("backed_up").notNull().default(0),
  transports: text("transports").default("[]"),
  name: text("name").notNull().default("Passkey"),
  created_at: text("created_at").default(sql`(datetime('now'))`),
});

// ========== Challenges ==========

export const challenges = sqliteTable("challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  user_id: integer("user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  created_at: text("created_at").default(sql`(datetime('now'))`),
  expires_at: text("expires_at").notNull(),
});

// ========== Permissions ==========

export const permissions = sqliteTable("permissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").unique().notNull(),
  description: text("description").default(""),
});

// ========== Role Permissions (Many-to-Many) ==========

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    role_id: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission_id: integer("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.role_id, table.permission_id] })]
);

