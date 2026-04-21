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

// ========== Refresh Tokens ==========

export const refreshTokens = pgTable("refresh_tokens", {
  token: text("token").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at").defaultNow(),
  expires_at: timestamp("expires_at", { mode: "string" }).notNull(),
});

// ========== Password Reset Tokens ==========

export const passwordResetTokens = pgTable("password_reset_tokens", {
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

// ========== Photo Libraries (external photo directories) ==========

export const libraryImportModeEnum = pgEnum("library_import_mode", ["link", "move"]);

export const photoLibraries = pgTable("photo_libraries", {
  id: serial("id").primaryKey(),
  // Owner of all photos imported from this library.
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Path inside the container, must be under PHOTO_LIBRARIES_ROOT.
  path: text("path").notNull().unique(),
  import_mode: libraryImportModeEnum("import_mode").notNull().default("link"),
  // When true a filesystem watcher imports newly arriving files automatically.
  auto_import: boolean("auto_import").notNull().default(false),
  // When true an album per first-level sub-directory is auto-created and each
  // imported photo is added to it.
  auto_albums: boolean("auto_albums").notNull().default(false),
  // Minimum XMP:Rating (1..5) at which a newly imported photo is marked as
  // favourite for the library owner. 0 disables the auto-favourite behaviour.
  favorite_rating_threshold: integer("favorite_rating_threshold").notNull().default(0),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  last_scan_at: timestamp("last_scan_at", { mode: "string" }),
});

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
  // Maintained by a DB trigger (see migration 0034) on every photo UPDATE
  // and every photo_curation mutation. Read by the /photos/index ETag
  // computation to emit cheap 304 Not Modified responses.
  updated_at: timestamp("updated_at", { mode: "string" }).notNull().defaultNow(),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  location_name: text("location_name"),
  location_city: text("location_city"),
  location_country: text("location_country"),
  location_short: text("location_short"),
  ai_quality_score: real("ai_quality_score"),
  ai_quality_details: jsonb("ai_quality_details").$type<Record<string, number>>(),
  auto_crop: jsonb("auto_crop").$type<{ x: number; y: number }>(),
  description: text("description"),
  // IPTC Keywords / XMP dc:subject — user-facing tags imported from the file.
  keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
  // External photo library this row belongs to (NULL = uploaded via HTTP).
  library_id: integer("library_id").references(() => photoLibraries.id, { onDelete: "set null" }),
  // Absolute filesystem path for `link`-imported photos. NULL for uploads and
  // for `move`-imported photos (which live under UPLOAD_DIR like uploads do).
  external_path: text("external_path"),
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

// ========== Faces (global detection results — one row per detected face per photo) ==========

export const faces = pgTable("faces", {
  id: serial("id").primaryKey(),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  // Bounding box as JSON string: { x, y, width, height } relativ zu Bildgröße (0..1)
  bbox: text("bbox").notNull(),
  // Embedding als JSON-kodierte Float32-Liste (z. B. 128/512 Dimensionen)
  embedding: text("embedding").notNull(),
  quality: integer("quality").default(0),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

// ========== User Face Assignments (per-user person mapping & ignored state) ==========

export const userFaceAssignments = pgTable(
  "user_face_assignments",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    face_id: integer("face_id")
      .notNull()
      .references(() => faces.id, { onDelete: "cascade" }),
    person_id: integer("person_id").references(() => persons.id, { onDelete: "set null" }),
    ignored: boolean("ignored").notNull().default(false),
    created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.face_id] })]
);

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
  // Optional event label derived from the source folder (e.g. "Hochzeit" from
  // "2020-06 Hochzeit"). Only populated by the library auto-album feature;
  // manual albums leave it null.
  event_name: text("event_name"),
  cover_photo_id: integer("cover_photo_id")
    .references(() => photos.id, { onDelete: "set null" }),
  display_mode: text("display_mode").notNull().default("grid"), // 'grid' | 'map'
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

// ========== Album Public Links ==========

export const albumPublicLinks = pgTable("album_public_links", {
  id: serial("id").primaryKey(),
  album_id: integer("album_id")
    .notNull()
    .references(() => albums.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  created_by_user_id: integer("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  expires_at: timestamp("expires_at", { mode: "string" }),
});

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
        cover_photo_id: integer("cover_photo_id").references(() => photos.id, { onDelete: "set null" }),
  },
  (table) => [primaryKey({ columns: [table.album_id, table.user_id] })]
);

// ========== Photo Landmarks (Grounding DINO detection results) ==========

// ========== Photo Landmarks (global detection results — one set per photo) ==========

export const photoLandmarks = pgTable("photo_landmarks", {
  id: serial("id").primaryKey(),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  confidence: real("confidence").notNull(),
  // Bounding box as JSON string: { x, y, width, height } normalized to image size (0..1)
  bbox: text("bbox").notNull(),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

// ========== Scan Queue ==========

export const scanServiceEnum = pgEnum("scan_service", ["embedding", "face_detection", "face_assignment", "landmark", "quality", "geocoding", "thumbnail"]);
export const scanStatusEnum = pgEnum("scan_status", ["pending", "processing", "failed", "done"]);

export const photoScanQueue = pgTable("photo_scan_queue", {
  id: serial("id").primaryKey(),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  user_id: integer("user_id")
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

// ========== Library Scan Queue ==========

export const libraryScanQueue = pgTable("library_scan_queue", {
  id: serial("id").primaryKey(),
  library_id: integer("library_id")
    .notNull()
    .references(() => photoLibraries.id, { onDelete: "cascade" }),
  status: scanStatusEnum("status").notNull().default("pending"),
  // When true the worker also runs reconcileLibrary() before scanLibrary().
  reconcile: boolean("reconcile").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  error_msg: text("error_msg"),
  enqueued_at: timestamp("enqueued_at", { mode: "string" }).notNull().defaultNow(),
  started_at: timestamp("started_at", { mode: "string" }),
  finished_at: timestamp("finished_at", { mode: "string" }),
  // Post-run counts from ScanReport (null while pending/processing).
  scanned: integer("scanned"),
  imported: integer("imported"),
  skipped_duplicate: integer("skipped_duplicate"),
  skipped_unsupported: integer("skipped_unsupported"),
  skipped_empty: integer("skipped_empty"),
  errors: integer("errors"),
  removed: integer("removed"),
});

// ========== Documents ==========

export const documentStatusEnum = pgEnum("document_status", [
  "pending",
  "extracting",
  "classifying",
  "ready",
  "failed",
]);

export const documentJobServiceEnum = pgEnum("document_job_service", [
  "text_extract",
  "classify",
  "embed",
]);

export const documentJobStatusEnum = pgEnum("document_job_status", [
  "pending",
  "processing",
  "failed",
  "done",
]);

export const documentSuggestionStatusEnum = pgEnum("document_suggestion_status", [
  "open",
  "accepted",
  "rejected",
]);

export const documentTaxSourceEnum = pgEnum("document_tax_source", [
  "ai",
  "user",
]);

export const documentVisibilityEnum = pgEnum("document_visibility", [
  "private",
  "household",
]);

export const householdMemberRoleEnum = pgEnum("household_member_role", [
  "owner",
  "member",
]);

// A household groups users who share a pool of documents (visibility='household').
// The slug is used both as the URL path and as the filesystem directory name.
export const households = pgTable("households", {
  id: serial("id").primaryKey(),
  slug: text("slug").unique().notNull(),
  name: text("name").notNull(),
  created_at: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});

export const householdMembers = pgTable(
  "household_members",
  {
    household_id: integer("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: householdMemberRoleEnum("role").notNull().default("member"),
    joined_at: timestamp("joined_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.household_id, table.user_id] })]
);

export const documentCategories = pgTable("document_categories", {
  id: serial("id").primaryKey(),
  slug: text("slug").unique().notNull(),
  name: text("name").notNull(),
  parent_id: integer("parent_id").references((): any => documentCategories.id, { onDelete: "set null" }),
  icon: text("icon"),
  sort_order: integer("sort_order").notNull().default(0),
});

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sha256: text("sha256").unique().notNull(),
  original_filename: text("original_filename").notNull(),
  mime_type: text("mime_type").notNull(),
  size_bytes: integer("size_bytes").notNull(),
  disk_path: text("disk_path").notNull(),
  uploaded_at: timestamp("uploaded_at", { mode: "string" }).defaultNow(),
  status: documentStatusEnum("status").notNull().default("pending"),
  // AI-produced fields (nullable until the worker has run).
  category_id: integer("category_id").references(() => documentCategories.id, { onDelete: "set null" }),
  title: text("title"),
  // ISO date-only (YYYY-MM-DD) — date printed on the document itself, if detected.
  doc_date: text("doc_date"),
  sender: text("sender"),
  summary: text("summary"),
  extracted_text: text("extracted_text"),
  classification_confidence: real("classification_confidence"),
  // When true, `text_extract` skips the PDF text layer and always runs
  // OCR. Used to recover documents whose pre-baked text layer lost its
  // spaces (see migration 0028).
  force_ocr: boolean("force_ocr").notNull().default(false),
  // Tax-return metadata (migration 0029). Filled by the LLM classifier;
  // the user can override via the tax-detail endpoint (flips
  // `tax_reviewed` to true). Section assignments live in the N:M
  // join table `document_tax_sections` below.
  tax_relevant: boolean("tax_relevant").notNull().default(false),
  tax_year: integer("tax_year"),
  tax_year_confidence: real("tax_year_confidence"),
  tax_reviewed: boolean("tax_reviewed").notNull().default(false),
  // Access control (migration 0036). `visibility` drives who can see
  // the document; `household_id` must be set iff visibility='household'
  // (DB CHECK constraint). `user_id` stays as the uploader regardless.
  visibility: documentVisibilityEnum("visibility").notNull().default("private"),
  household_id: integer("household_id").references(() => households.id, { onDelete: "restrict" }),
  // NOTE: the generated `text_tsv tsvector` column and its GIN index are
  // added by migration 0025 and accessed only via raw SQL (drizzle-orm has
  // no first-class tsvector support).
});

// N:M mapping of a document to one or more German tax-return sections
// (Anlagen / Abzugsbereiche). Slug values are NOT a Postgres enum —
// they are validated in the service layer against
// `documents/tax-sections.ts`, so new sections don't need a migration.
export const documentTaxSections = pgTable(
  "document_tax_sections",
  {
    document_id: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tax_section: text("tax_section").notNull(),
    confidence: real("confidence"),
    source: documentTaxSourceEnum("source").notNull().default("ai"),
    created_at: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.document_id, table.tax_section] })]
);

export const documentTags = pgTable("document_tags", {
  id: serial("id").primaryKey(),
  name: text("name").unique().notNull(),
  color: text("color"),
});

export const documentTagLinks = pgTable(
  "document_tag_links",
  {
    document_id: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    tag_id: integer("tag_id")
      .notNull()
      .references(() => documentTags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.document_id, table.tag_id] })]
);

export const documentScanQueue = pgTable("document_scan_queue", {
  id: serial("id").primaryKey(),
  document_id: integer("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  service: documentJobServiceEnum("service").notNull(),
  status: documentJobStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  error_msg: text("error_msg"),
  enqueued_at: timestamp("enqueued_at", { mode: "string" }).notNull().defaultNow(),
  started_at: timestamp("started_at", { mode: "string" }),
  finished_at: timestamp("finished_at", { mode: "string" }),
});

// AI-proposed taxonomy refinements. Populated by the classifier when
// confidence is low or documents end up in "sonstiges". Admin accepts /
// rejects entries in the UI; accepted ones create new document_categories.
export const documentCategorySuggestions = pgTable("document_category_suggestions", {
  id: serial("id").primaryKey(),
  suggested_name: text("suggested_name").notNull(),
  parent_slug: text("parent_slug"),
  example_document_ids: integer("example_document_ids").array().notNull().default(sql`'{}'::integer[]`),
  rationale: text("rationale"),
  status: documentSuggestionStatusEnum("status").notNull().default("open"),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
});

// NOTE: `document_embeddings` (pgvector) is created via raw SQL in migration
// 0025 and accessed only through raw queries — drizzle-orm has no native
// vector column type.

// ========== Rueckblicke (Recaps) ==========

export const recapKindEnum = pgEnum("recap_kind", [
  "on_this_day",
  "trip",
  "person",
  "place",
  "theme",
  "recent_highlights",
]);

export const recaps = pgTable("recaps", {
  id: serial("id").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: recapKindEnum("kind").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  cover_photo_id: integer("cover_photo_id").references(() => photos.id, { onDelete: "set null" }),
  period_start: timestamp("period_start", { mode: "string" }),
  period_end: timestamp("period_end", { mode: "string" }),
  score: real("score").notNull().default(0),
  dedup_key: text("dedup_key").notNull(),
  seed: jsonb("seed").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  created_at: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
  dismissed_at: timestamp("dismissed_at", { mode: "string" }),
  seen_at: timestamp("seen_at", { mode: "string" }),
});

export const recapPhotos = pgTable(
  "recap_photos",
  {
    recap_id: integer("recap_id")
      .notNull()
      .references(() => recaps.id, { onDelete: "cascade" }),
    photo_id: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.recap_id, table.photo_id] })]
);
