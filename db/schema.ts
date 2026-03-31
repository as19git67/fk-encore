import { pgTable, text, integer, primaryKey, serial, boolean, timestamp, real, doublePrecision, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ========== Users ==========

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").unique().notNull(),
  name: text("name").notNull(),
  password_hash: text("password_hash").notNull(),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string" }).defaultNow(),
});

// ========== Roles ==========

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").unique().notNull(),
  description: text("description").default(""),
});

// ========== User Roles (Many-to-Many) ==========

export const userRoles = pgTable(
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

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at").defaultNow(),
  expires_at: timestamp("expires_at", { mode: "string" }).notNull(),
});

// ========== Passkeys ==========

export const passkeys = pgTable("passkeys", {
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
  disabled: integer("disabled").notNull().default(0),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

// ========== Challenges ==========

export const challenges = pgTable("challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  user_id: integer("user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  created_at: timestamp("created_at").defaultNow(),
  expires_at: timestamp("expires_at", { mode: "string" }).notNull(),
});

// ========== Permissions ==========

export const permissions = pgTable("permissions", {
  id: serial("id").primaryKey(),
  key: text("key").unique().notNull(),
  description: text("description").default(""),
});

// ========== Role Permissions (Many-to-Many) ==========

export const rolePermissions = pgTable(
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

// ========== Photos ==========

export const photos = pgTable("photos", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  original_name: text("original_name").notNull(),
  mime_type: text("mime_type").notNull(),
  size: integer("size").notNull(),
  hash: text("hash"),
  taken_at: timestamp("taken_at", { mode: "string" }),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  location_name: text("location_name"),
  location_city: text("location_city"),
  location_country: text("location_country"),
  ai_quality_score: real("ai_quality_score"),
  ai_quality_details: jsonb("ai_quality_details").$type<Record<string, number>>(),
});

// ========== Persons ==========

export const persons = pgTable("persons", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Unbenannt"),
  cover_face_id: integer("cover_face_id"),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string" }).defaultNow(),
});

// ========== Faces ==========

export const faces = pgTable("faces", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  // Bounding box as JSON string: { x, y, width, height } relativ zu Bildgröße (0..1)
  bbox: text("bbox").notNull(),
  // Embedding als JSON-kodierte Float32-Liste (z. B. 128/512 Dimensionen)
  embedding: text("embedding").notNull(),
  person_id: integer("person_id").references(() => persons.id, { onDelete: "set null" }),
  quality: integer("quality").default(0),
  ignored: boolean("ignored").notNull().default(false),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

// ========== Photo Curation (per-user visibility) ==========

export const photoCuration = pgTable(
  "photo_curation",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    photo_id: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("visible"), // 'visible' | 'hidden' | 'favorite'
    updated_at: timestamp("updated_at").defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.photo_id] })]
);

// ========== Photo Groups (similar photo stacks) ==========

export const photoGroups = pgTable("photo_groups", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  cover_photo_id: integer("cover_photo_id")
    .references(() => photos.id, { onDelete: "set null" }),
  reviewed_at: timestamp("reviewed_at", { mode: "string" }),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

export const photoGroupMembers = pgTable(
  "photo_group_members",
  {
    group_id: integer("group_id")
      .notNull()
      .references(() => photoGroups.id, { onDelete: "cascade" }),
    photo_id: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    similarity_rank: integer("similarity_rank").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.group_id, table.photo_id] })]
);

// ========== Albums ==========

export const albums = pgTable("albums", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  cover_photo_id: integer("cover_photo_id")
    .references(() => photos.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string" }).defaultNow(),
});

// ========== Album Photos (Many-to-Many) ==========

export const albumPhotos = pgTable(
  "album_photos",
  {
    album_id: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    photo_id: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    added_by_user_id: integer("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    added_at: timestamp("added_at", { mode: "string" }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.album_id, table.photo_id] })]
);

// ========== Album Shares ==========

export const albumShares = pgTable(
  "album_shares",
  {
    album_id: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    access_level: text("access_level").notNull().default("read"),
  },
  (table) => [primaryKey({ columns: [table.album_id, table.user_id] })]
);

// ========== Album User Settings (Preferences) ==========

export const albumUserSettings = pgTable(
  "album_user_settings",
  {
    album_id: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hide_mode: text("hide_mode").notNull().default("mine"), // 'mine' | 'all'
    active_view: text("active_view").notNull().default("all"), // 'all' | 'favorites' | 'by_user'
    view_config: jsonb("view_config"),
  },
  (table) => [primaryKey({ columns: [table.album_id, table.user_id] })]
);

// ========== Photo Landmarks (Grounding DINO detection results) ==========

export const photoLandmarks = pgTable("photo_landmarks", {
  id: serial("id").primaryKey(),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  confidence: real("confidence").notNull(),
  // Bounding box as JSON string: { x, y, width, height } normalized to image size (0..1)
  bbox: text("bbox").notNull(),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

// ========== Scan Queue ==========

export const scanServiceEnum = pgEnum("scan_service", ["embedding", "face_detection", "landmark", "quality"]);
export const scanStatusEnum = pgEnum("scan_status", ["pending", "processing", "failed", "done"]);

export const photoScanQueue = pgTable("photo_scan_queue", {
  id: serial("id").primaryKey(),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  service: scanServiceEnum("service").notNull(),
  status: scanStatusEnum("status").notNull().default("pending"),
  force: boolean("force").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  error_msg: text("error_msg"),
  enqueued_at: timestamp("enqueued_at", { mode: "string" }).notNull().defaultNow(),
  started_at: timestamp("started_at", { mode: "string" }),
  finished_at: timestamp("finished_at", { mode: "string" }),
});
