import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
import { pgTable, text as pgText, integer as pgInteger, primaryKey as pgPrimaryKey, serial, boolean, timestamp, foreignKey } from "drizzle-orm/pg-core";
import { sql, type Column } from "drizzle-orm";

const isPg = process.env.DB_TYPE?.toLowerCase() === 'postgres';

/**
 * A proxy that switches between SQLite and PostgreSQL table creators and column types.
 */
const tableProxy = (name: string, columns: any, extra?: (table: any) => any[]) => {
  if (isPg) {
    return pgTable(name, columns, extra);
  } else {
    return sqliteTable(name, columns, extra);
  }
};

const textProxy = (name: string) => isPg ? pgText(name) : text(name);
const integerProxy = (name: string) => isPg ? pgInteger(name) : integer(name);
const primaryKeyProxy = (columns: Column[]) => isPg ? pgPrimaryKey({ columns }) : primaryKey({ columns });

const idProxy = (name: string = "id") => isPg ? serial(name).primaryKey() : integer(name).primaryKey({ autoIncrement: true });
const createdAtProxy = () => isPg ? timestamp("created_at").defaultNow() : text("created_at").default(sql`(datetime('now'))`);
const updatedAtProxy = () => isPg ? timestamp("updated_at").defaultNow() : text("updated_at").default(sql`(datetime('now'))`);
const booleanProxy = (name: string) => isPg ? boolean(name) : integer(name, { mode: "boolean" });

// ========== Users ==========

export const users = tableProxy("users", {
  id: idProxy(),
  email: textProxy("email").unique().notNull(),
  name: textProxy("name").notNull(),
  password_hash: textProxy("password_hash").notNull(),
  created_at: createdAtProxy(),
  updated_at: updatedAtProxy(),
});

// ========== Roles ==========

export const roles = tableProxy("roles", {
  id: idProxy(),
  name: textProxy("name").unique().notNull(),
  description: textProxy("description").default(""),
});

// ========== User Roles (Many-to-Many) ==========

export const userRoles = tableProxy(
  "user_roles",
  {
    user_id: integerProxy("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role_id: integerProxy("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKeyProxy([table.user_id, table.role_id])]
);

// ========== Sessions ==========

export const sessions = tableProxy("sessions", {
  token: textProxy("token").primaryKey(),
  user_id: integerProxy("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  created_at: createdAtProxy(),
  expires_at: textProxy("expires_at").notNull(), // Keep as text for simplicity or change to timestamp
});

// ========== Passkeys ==========

export const passkeys = tableProxy("passkeys", {
  credential_id: textProxy("credential_id").primaryKey(),
  user_id: integerProxy("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  public_key: textProxy("public_key").notNull(),
  counter: integerProxy("counter").notNull().default(0),
  device_type: textProxy("device_type").notNull().default("singleDevice"),
  backed_up: integerProxy("backed_up").notNull().default(0),
  transports: textProxy("transports").default("[]"),
  name: textProxy("name").notNull().default("Passkey"),
  disabled: integerProxy("disabled").notNull().default(0),
  created_at: createdAtProxy(),
});

// ========== Challenges ==========

export const challenges = tableProxy("challenges", {
  id: textProxy("id").primaryKey(),
  challenge: textProxy("challenge").notNull(),
  user_id: integerProxy("user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  created_at: createdAtProxy(),
  expires_at: textProxy("expires_at").notNull(),
});

// ========== Permissions ==========

export const permissions = tableProxy("permissions", {
  id: idProxy(),
  key: textProxy("key").unique().notNull(),
  description: textProxy("description").default(""),
});

// ========== Role Permissions (Many-to-Many) ==========

export const rolePermissions = tableProxy(
  "role_permissions",
  {
    role_id: integerProxy("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission_id: integerProxy("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKeyProxy([table.role_id, table.permission_id])]
);

// ========== Photos ==========

export const photos = tableProxy("photos", {
  id: idProxy(),
  user_id: integerProxy("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: textProxy("filename").notNull(),
  original_name: textProxy("original_name").notNull(),
  mime_type: textProxy("mime_type").notNull(),
  size: integerProxy("size").notNull(),
  hash: textProxy("hash"),
  taken_at: textProxy("taken_at"),
  created_at: createdAtProxy(),
});

// ========== Persons ==========

export const persons = tableProxy("persons", {
  id: idProxy(),
  user_id: integerProxy("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: textProxy("name").notNull().default("Unbenannt"),
  cover_face_id: integerProxy("cover_face_id"),
  created_at: createdAtProxy(),
  updated_at: updatedAtProxy(),
});

// ========== Faces ==========

export const faces = tableProxy("faces", {
  id: idProxy(),
  user_id: integerProxy("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  photo_id: integerProxy("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  // Bounding box as JSON string: { x, y, width, height } relativ zu Bildgröße (0..1)
  bbox: textProxy("bbox").notNull(),
  // Embedding als JSON-kodierte Float32-Liste (z. B. 128/512 Dimensionen)
  embedding: textProxy("embedding").notNull(),
  person_id: integerProxy("person_id").references(() => persons.id, { onDelete: "set null" }),
  quality: integerProxy("quality").default(0),
  ignored: booleanProxy("ignored").notNull().default(false),
  created_at: createdAtProxy(),
});

// ========== Photo Curation (per-user visibility) ==========

export const photoCuration = tableProxy(
  "photo_curation",
  {
    user_id: integerProxy("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    photo_id: integerProxy("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    status: textProxy("status").notNull().default("visible"), // 'visible' | 'hidden' | 'favorite'
    updated_at: createdAtProxy(),
  },
  (table) => [primaryKeyProxy([table.user_id, table.photo_id])]
);

// ========== Photo Groups (similar photo stacks) ==========

export const photoGroups = tableProxy("photo_groups", {
  id: idProxy(),
  user_id: integerProxy("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  cover_photo_id: integerProxy("cover_photo_id")
    .references(() => photos.id, { onDelete: "set null" }),
  reviewed_at: textProxy("reviewed_at"),
  created_at: createdAtProxy(),
});

export const photoGroupMembers = tableProxy(
  "photo_group_members",
  {
    group_id: integerProxy("group_id")
      .notNull()
      .references(() => photoGroups.id, { onDelete: "cascade" }),
    photo_id: integerProxy("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    similarity_rank: integerProxy("similarity_rank").notNull().default(0),
  },
  (table) => [primaryKeyProxy([table.group_id, table.photo_id])]
);

// ========== Albums ==========

export const albums = tableProxy("albums", {
  id: idProxy(),
  user_id: integerProxy("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: textProxy("name").notNull(),
  created_at: createdAtProxy(),
  updated_at: updatedAtProxy(),
});

// ========== Album Photos (Many-to-Many) ==========

export const albumPhotos = tableProxy(
  "album_photos",
  {
    album_id: integerProxy("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    photo_id: integerProxy("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKeyProxy([table.album_id, table.photo_id])]
);

// ========== Album Shares ==========

export const albumShares = tableProxy(
  "album_shares",
  {
    album_id: integerProxy("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    user_id: integerProxy("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    access_level: textProxy("access_level").notNull().default("read"),
  },
  (table) => [primaryKeyProxy([table.album_id, table.user_id])]
);

