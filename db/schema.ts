import { pgTable, text, integer, primaryKey, serial, boolean, timestamp, real, doublePrecision, pgEnum, jsonb, bigserial, numeric, uuid, uniqueIndex, index, bigint } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ========== Users ==========

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").unique().notNull(),
  name: text("name").notNull(),
  password_hash: text("password_hash").notNull(),
  created_at: timestamp("created_at", { mode: "string" }).defaultNow(),
  updated_at: timestamp("updated_at", { mode: "string" }).defaultNow(),
  // Per-user push notification preferences: maps FeedItemKind → boolean.
  // Absent keys default to true (enabled). false = explicitly disabled.
  notification_prefs: jsonb("notification_prefs").notNull().default({}),
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
  // SHA-256 over the decoded image pixel data only (no embedded EXIF/IPTC/XMP
  // metadata). Sent by the iOS client as the X-Image-Data-Hash header so a
  // re-upload that only changed metadata is recognised as the same photo and
  // updated in place instead of creating a duplicate (issue #432). NULL for
  // rows uploaded before this protocol existed and for library-scanned files.
  image_data_hash: text("image_data_hash"),
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
  // Image dimensions post-EXIF-rotation (so a portrait phone shot stored
  // as 4032x3024 EXIF rot=6 lands here as width=3024, height=4032).
  // Used by the AI auto-pick orientation-diversity rule. NULL until
  // the next face scan or the dimensions-backfill admin pass populates them.
  width: integer("width"),
  height: integer("height"),
  auto_crop: jsonb("auto_crop").$type<{ x: number; y: number }>(),
  description: text("description"),
  // IPTC Keywords / XMP dc:subject — user-facing tags imported from the file.
  keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
  // External photo library this row belongs to (NULL = uploaded via HTTP).
  library_id: integer("library_id").references(() => photoLibraries.id, { onDelete: "set null" }),
  // Absolute filesystem path for `link`-imported photos. NULL for uploads and
  // for `move`-imported photos (which live under UPLOAD_DIR like uploads do).
  external_path: text("external_path"),
  // iOS hash-based sync protocol (issue #432).
  // image_data_hash: SHA-256 of PHAssetResource.photo bytes (X-Image-Data-Hash header).
  // full_hash:       SHA-256(imageDataHash+caption+isFavorite+capturedAt) (X-Full-Hash).
  // device_asset_id: iOS PHAsset.localIdentifier (X-Asset-Id) — stable dedup key.
  image_data_hash: text("image_data_hash"),
  full_hash: text("full_hash"),
  device_asset_id: text("device_asset_id"),
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
  // AI auto-pick (see migration 0075). NULL until the scoring pass has
  // run for this group; user reviewed_at always takes precedence over
  // the AI pick.
  ai_picked_photo_ids: integer("ai_picked_photo_ids").array(),
  ai_picked_at: timestamp("ai_picked_at", { mode: "string" }),
  ai_picked_confidence: text("ai_picked_confidence"),
  ai_pick_details: jsonb("ai_pick_details").$type<AiPickDetails>(),
});

// Per-photo scoring breakdown stored in photo_groups.ai_pick_details.
// Kept verbose so future calibration runs (Stufe D) can regress the
// weights from User-Override events without re-fetching every signal.
export interface AiPickPhotoScore {
  photo_id: number;
  score: number;
  has_face: boolean;
  // Recorded only when known; pre-backfill rows carry no value rather
  // than a misleading default. Stufe-D regression can ignore the field
  // when it's absent.
  orientation?: "portrait" | "landscape" | "square";
  signals: {
    face_sharpness?: number;
    eyes_open?: number;
    face_coverage?: number;
    face_composition?: number;
    blur?: number;
    contrast?: number;
    exposure?: number;
    clip_aesthetics?: number;
    clip_composition?: number;
    clip_technical?: number;
  };
}

export interface AiPickDetails {
  // Score-difference between top-1 and the best non-pick. Drives the
  // confidence gate (see migration 0075).
  runner_up_delta: number;
  // Multi-pick threshold actually applied (default 0.92).
  multi_pick_threshold: number;
  scores: AiPickPhotoScore[];
}

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
  (table) => [
    primaryKey({ columns: [table.group_id, table.photo_id] }),
    index("photo_group_members_photo_id_idx").on(table.photo_id),
  ]
);

// Per-user weights for the AI auto-pick scoring formula. Fitted from
// the user's reviewed groups via pairwise logistic regression (see
// photo/group-auto-pick.calibration.ts). Absent rows fall back to the
// hardcoded defaults in scorePhoto().
export interface AiPickWeights {
  face: number[];     // [face_sharpness, eyes_open, face_coverage,
                      //  face_composition, blur, clip_aesthetics,
                      //  exposure_contrast_avg]
  non_face: number[]; // [blur, clip_aesthetics, clip_composition,
                      //  clip_technical, exposure_contrast_avg]
}

export interface AiPickWeightsMetadata {
  pair_count_face: number;
  pair_count_non_face: number;
  pair_count_skipped_mixed: number;
  // Top-1 agreement on the training data after the fit. 0..1.
  top1_accuracy_face: number;
  top1_accuracy_non_face: number;
  // Top-1 agreement of the *defaults* on the same data, for reference.
  top1_accuracy_face_baseline: number;
  top1_accuracy_non_face_baseline: number;
}

export const aiPickUserWeights = pgTable("ai_pick_user_weights", {
  user_id: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  weights: jsonb("weights").$type<AiPickWeights>().notNull(),
  fitted_at: timestamp("fitted_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  metadata: jsonb("metadata").$type<AiPickWeightsMetadata>().notNull().default({} as any),
});

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
    invited_by_user_id: integer("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
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

// ========== Photo Transformations (AI crop/exposure suggestions + per-user recipes) ==========
//
// See docs/photos-ai-transforms.md. Originals are never overwritten; user
// recipes live here, and the AI suggestion payload is shared per photo.

export type PhotoTransformCrop = { x: number; y: number; w: number; h: number };

export type PhotoTransformAspectRatio =
  | "1:1"
  | "4:5"
  | "5:4"
  | "3:4"
  | "4:3"
  | "16:9"
  | "9:16";

export interface PhotoTransformSuggestionsPayload {
  // One crop per supported aspect ratio. Missing keys mean the subject hull
  // didn't fit that ratio at this orientation; the client should fall back
  // to the cropper UI for that one.
  crops: Partial<Record<PhotoTransformAspectRatio, PhotoTransformCrop>>;
  exposure: number;     // EV, e.g. -2..+2
  contrast: number;     // -1..+1
  gamma: number;        // multiplicative, default 1
  white_point?: number; // 0..1, optional
  black_point?: number; // 0..1, optional
}

export const photoTransformSuggestions = pgTable("photo_transform_suggestions", {
  photo_id: integer("photo_id")
    .primaryKey()
    .references(() => photos.id, { onDelete: "cascade" }),
  payload: jsonb("payload").$type<PhotoTransformSuggestionsPayload>().notNull(),
  model_version: text("model_version").notNull(),
  computed_at: timestamp("computed_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export const photoTransforms = pgTable(
  "photo_transforms",
  {
    id: serial("id").primaryKey(),
    photo_id: integer("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'ai' = materialised from a suggestion. 'user' = composed in the editor.
    // 'adopted' = copied from another user's row (adopted_from points to it).
    source: text("source").notNull(),
    // Self-reference FK (defined in SQL only — drizzle struggles with circular
    // references at table-definition time). ON DELETE SET NULL so adopted
    // recipes survive deletion of the source.
    adopted_from: integer("adopted_from"),
    crop: jsonb("crop").$type<PhotoTransformCrop>(),
    rotation: integer("rotation").notNull().default(0), // 0 | 90 | 180 | 270
    exposure: real("exposure").notNull().default(0),
    contrast: real("contrast").notNull().default(0),
    gamma: real("gamma").notNull().default(1),
    white_point: real("white_point"),
    black_point: real("black_point"),
    applied_at: timestamp("applied_at", { withTimezone: true, mode: "string" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("photo_transforms_photo_user_uniq").on(table.photo_id, table.user_id),
    index("photo_transforms_user_id_idx").on(table.user_id),
  ]
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

// Per-photo POI matches produced by the osm-admin POI matcher (Epic #383).
// The (photo_id, qid|osm_ref) uniqueness + the score-sorted index are
// declared in raw SQL (migration 0087) — drizzle's coalesce-in-index
// support isn't strong enough.
export const photoPoiMatches = pgTable("photo_poi_matches", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  qid: text("qid"),
  osm_ref: text("osm_ref").notNull(),
  name: text("name").notNull(),
  name_de: text("name_de"),
  distance_m: real("distance_m"),
  heading_match: real("heading_match"),
  match_score: real("match_score").notNull(),
  ambiguous: boolean("ambiguous").notNull().default(false),
  source: text("source").notNull(),
  region_slug: text("region_slug"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// ========== Scan Queue ==========

export const scanServiceEnum = pgEnum("scan_service", ["embedding", "face_detection", "face_assignment", "landmark", "quality", "geocoding", "thumbnail", "poi_detection"]);
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
  priority: integer("priority").notNull().default(2),
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
  total: integer("total"),
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
  "group",
]);

export const groupMemberRoleEnum = pgEnum("group_member_role", [
  "owner",
  "member",
]);

// A group groups users who share a pool of documents (visibility='group').
// The slug is used both as the URL path and as the filesystem directory name.
export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  slug: text("slug").unique().notNull(),
  name: text("name").notNull(),
  created_at: timestamp("created_at", { mode: "string" }).notNull().defaultNow(),
});

export const groupMembers = pgTable(
  "group_members",
  {
    group_id: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: groupMemberRoleEnum("role").notNull().default("member"),
    joined_at: timestamp("joined_at", { mode: "string" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.group_id, table.user_id] })]
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
  // Access control (migration 0036/0069). `visibility` drives who can see
  // the document; `group_id` must be set iff visibility='group'
  // (DB CHECK constraint). `user_id` stays as the uploader regardless.
  visibility: documentVisibilityEnum("visibility").notNull().default("private"),
  group_id: integer("group_id").references(() => groups.id, { onDelete: "restrict" }),
  // Last failure reason from the worker pipeline. Set by markDocumentFailed,
  // cleared whenever the document re-enters the pipeline (reclassify) so a
  // stale error never lingers on a healthy document.
  last_error: text("last_error"),
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
  priority: integer("priority").notNull().default(2),
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

// Admin overrides for the per-section `hint` string that is sent to the
// LLM in the /classify prompt. Missing row → use the hardcoded default
// from documents/tax-sections.ts.
export const taxSectionHintOverrides = pgTable("tax_section_hint_overrides", {
  slug: text("slug").primaryKey(),
  hint: text("hint").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// NOTE: `document_embeddings` (pgvector) is created via raw SQL in migration
// 0025 and accessed only through raw queries — drizzle-orm has no native
// vector column type.

// ========== POI Detection (Epic #383) ==========
//
// `osm_region_imports` tracks per-region Geofabrik extracts imported
// into the geo service's PostGIS database (one db per region). The
// bbox columns are used by the request router to map a photo's GPS
// coordinates to the right region database.
//
// Status values (kept as TEXT, not an enum, so the lifecycle can evolve
// without migrations):
//   pending_approval | importing | ready_running | failed
//
// `ready_stopped` and `blocked_disk` are legacy values left over from
// the docker-driven era — pickRegion still accepts ready_stopped as a
// synonym for ready_running so existing rows stay readable.

export const osmRegionImports = pgTable("osm_region_imports", {
  slug: text("slug").primaryKey(),
  geofabrik_url: text("geofabrik_url").notNull(),
  pbf_size_mb: integer("pbf_size_mb"),
  postgres_db: text("postgres_db").notNull(),
  bbox_min_lat: doublePrecision("bbox_min_lat").notNull(),
  bbox_min_lon: doublePrecision("bbox_min_lon").notNull(),
  bbox_max_lat: doublePrecision("bbox_max_lat").notNull(),
  bbox_max_lon: doublePrecision("bbox_max_lon").notNull(),
  status: text("status").notNull().default("pending_approval"),
  last_used_at: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
  imported_at: timestamp("imported_at", { withTimezone: true, mode: "string" }),
  replication_seq: text("replication_seq"),
  last_error: text("last_error"),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

// `poi_references` is the cached pool of POI metadata + DINOv2 reference
// embeddings used for image matching against user photos. The
// `embedding vector(768)` column and its HNSW index live in raw SQL
// (migration 0084) — drizzle has no native vector type, same approach as
// `document_embeddings`.

export const poiReferences = pgTable("poi_references", {
  qid: text("qid").primaryKey(),
  name: text("name").notNull(),
  name_de: text("name_de"),
  wikipedia_url: text("wikipedia_url"),
  commons_image_url: text("commons_image_url"),
  embedded_at: timestamp("embedded_at", { withTimezone: true, mode: "string" }),
  created_at: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

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

// ========== Realtime Outbox ==========
//
// Every event published via realtime.publishEvent lands here before
// being forwarded to the PubSub topic. On reconnect, clients pass the
// last `seq` they processed via the `lastEventId` handshake parameter
// and the server replays everything they missed from this table.
//
// Retention is enforced by realtime/retention-cron.ts.

export const realtimeEvents = pgTable("realtime_events", {
  id: text("id").primaryKey(),
  // Monotonically increasing cursor, used as the resume anchor. Shared
  // across all users — simpler than per-user counters and the values
  // never leak between users anyway (queries are always user-scoped).
  seq: bigserial("seq", { mode: "number" }).notNull().unique(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  type: text("type").notNull(),
  resource_id: text("resource_id").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  version: integer("version").notNull().default(1),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ========== Social Feed ==========
//
// Activity timeline for album participants. Every feed-worthy action
// (a photo added to a shared album, an album being shared, a like, a
// comment) fans out into one `feed_items` row per recipient — the
// recipient is always the viewer, the actor is the user who performed
// the action. Fan-out is intentional so per-user state (seen_at) is
// cheap to maintain.
//
// Retention: none. Per product decision the feed is kept forever so
// users can scroll back through every shared moment.

export const feedItemKindEnum = pgEnum("feed_item_kind", [
  "photo_added",
  "album_shared",
  "photo_favorited",
  "photo_commented",
  "album_left",
]);

export const feedItems = pgTable("feed_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  actor_user_id: integer("actor_user_id")
    .references(() => users.id, { onDelete: "set null" }),
  kind: feedItemKindEnum("kind").notNull(),
  album_id: integer("album_id").references(() => albums.id, { onDelete: "cascade" }),
  photo_id: integer("photo_id").references(() => photos.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  seen_at: timestamp("seen_at", { mode: "string", withTimezone: true }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ========== Photo Comments ==========
//
// Audience for a comment is everyone with access to the photo — owner
// plus every user the photo has been shared to via an album (see
// getUsersWithPhotoAccess in photo.service.ts). Comments are
// individual rows; edit/delete is the author's own prerogative (plus
// photo owner can moderate — enforced in the service layer, not the
// DB).
//
// Note: the original "like" concept has been consolidated into the
// existing favorite curation state (`photo_curation.status =
// 'favorite'`). Migration 0041 drops the former `photo_likes` table.

// ========== Web Push Subscriptions ==========
//
// Each row is one browser subscription produced by the Push API. A
// single user can have many rows (multiple devices / browsers). The
// endpoint is globally unique so resubscribing from the same browser
// refreshes the same row via ON CONFLICT.

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Full PushSubscription.endpoint URL (browser-specific). Used as a
  // natural dedup key.
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  user_agent: text("user_agent"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
  last_used_at: timestamp("last_used_at", { mode: "string", withTimezone: true }),
});

export const photoComments = pgTable("photo_comments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  photo_id: integer("photo_id")
    .notNull()
    .references(() => photos.id, { onDelete: "cascade" }),
  // Author: exactly one of user_id or guest_id is set (CHECK constraint
  // photo_comments_author_chk, migration 0043).
  user_id: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  guest_id: integer("guest_id").references(() => guests.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
  edited_at: timestamp("edited_at", { mode: "string", withTimezone: true }),
});

// ========== Shared Album Guests ==========
//
// Recipients of a public album link who don't have an account. The
// email is the natural global key: the same person is recognized across
// multiple albums / multiple share-links, so comments and digest mails
// can be consolidated even when one person has accessed several links.

export const guests = pgTable("guests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  display_name: text("display_name").notNull(),
  // Set to a random token during registration, cleared to NULL on verify.
  verify_token: text("verify_token").unique(),
  verified_at: timestamp("verified_at", { mode: "string", withTimezone: true }),
  // Stable token for one-click unsubscribe links in outgoing mails.
  unsubscribe_token: text("unsubscribe_token").notNull().unique(),
  notify_opt_in: boolean("notify_opt_in").notNull().default(true),
  last_seen_at: timestamp("last_seen_at", { mode: "string", withTimezone: true }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Which public share-links a guest has been through. Lets the fan-out
// find all guests who can see a given album via any active link, and
// deduplicates a guest who has used several links for the same album.
export const guestLinkAccess = pgTable(
  "guest_link_access",
  {
    guest_id: integer("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    public_link_id: integer("public_link_id")
      .notNull()
      .references(() => albumPublicLinks.id, { onDelete: "cascade" }),
    first_seen_at: timestamp("first_seen_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    last_seen_at: timestamp("last_seen_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guest_id, table.public_link_id] })]
);

// Cookie-backed guest session. `id` is the opaque token placed in the
// HttpOnly share-cookie on the browser.
export const guestSessions = pgTable("guest_sessions", {
  id: text("id").primaryKey(),
  guest_id: integer("guest_id")
    .notNull()
    .references(() => guests.id, { onDelete: "cascade" }),
  // The public link this session was bootstrapped from. Used to credit
  // guest_link_access on first landing and for attribution.
  public_link_id: integer("public_link_id")
    .notNull()
    .references(() => albumPublicLinks.id, { onDelete: "cascade" }),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
  expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
});

// Per-browser Web Push subscriptions for guests. Mirrors pushSubscriptions
// but keyed on guest_id instead of user_id.
export const guestPushSubscriptions = pgTable("guest_push_subscriptions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  guest_id: integer("guest_id")
    .notNull()
    .references(() => guests.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  user_agent: text("user_agent"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
  last_used_at: timestamp("last_used_at", { mode: "string", withTimezone: true }),
});

// Pending notifications queue for guests. One row per (guest, event).
// `delivered_at` is set when the digest cron has sent the mail; Web
// Push is best-effort and doesn't gate delivery.
export const guestNotifications = pgTable("guest_notifications", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  guest_id: integer("guest_id")
    .notNull()
    .references(() => guests.id, { onDelete: "cascade" }),
  album_id: integer("album_id")
    .notNull()
    .references(() => albums.id, { onDelete: "cascade" }),
  // 'photo_added' | 'comment_added'
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
  delivered_at: timestamp("delivered_at", { mode: "string", withTimezone: true }),
});


// ========== Finance Module ==========
//
// Greenfield finance module (no legacy port). Classification uses flat
// multi-label tags — no category tree, no rule engine. Credentials are
// stored AES-GCM-encrypted (see finance/encryption.ts), never in plain
// text. The TAN flow is stateful in finance_tan_session (no in-memory
// singleton). See docs/finance-data-model.md.

export const financeAccountLevelEnum = pgEnum("finance_account_level", [
  "read",
  "write",
]);

export const financeTagSourceEnum = pgEnum("finance_tag_source", [
  "user",
  "ai",
]);

export const financeAccountKindEnum = pgEnum("finance_account_kind", [
  "giro",
  "tagesgeld",
  "festgeld",
  "kredit",
  "depot",
  "bausparen",
  "kreditkarte",
  "bargeld",
  "sonstige",
]);

// ---------- Stammdaten ----------

export const financeCurrency = pgTable("finance_currency", {
  code: text("code").primaryKey(), // ISO 4217, e.g. "EUR", "USD"
  symbol: text("symbol").notNull(),
  decimals: integer("decimals").notNull().default(2),
});

export const financeAccountType = pgTable("finance_account_type", {
  id: serial("id").primaryKey(),
  kind: financeAccountKindEnum("kind").notNull().unique(),
  label: text("label").notNull(),
});

export const financeTimespan = pgTable("finance_timespan", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  offset_days: integer("offset_days"),
  offset_months: integer("offset_months"),
});

// ---------- Bankkontakte ----------
//
// sync_times is an array of cron-like slots, e.g.
//   [{ weekdays: [1,2,3,4,5], time: "06:25", tz: "Europe/Berlin" }]
// The sync cron evaluates each slot against `now()` in the declared tz,
// so DST transitions Just Work without a separate UTC cache column.

export interface FinanceSyncSlot {
  weekdays: number[]; // 0 = Sunday … 6 = Saturday
  time: string;       // "HH:MM"
  tz: string;         // IANA time zone, e.g. "Europe/Berlin"
}

export const financeBankcontact = pgTable("finance_bankcontact", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  blz: text("blz").notNull(),
  login: text("login").notNull(),
  server_url: text("server_url").notNull(),
  tan_method: text("tan_method"),
  credentials_encrypted: text("credentials_encrypted"), // AES-GCM blob, base64
  // Last bank-advertised list of TAN methods, cached here so the UI's
  // "TAN-Verfahren"-picker has a populated select box after a page
  // reload without issuing a fresh FinTS dialog on every view open.
  // Refreshed by probeTanMethods; not authoritative — the bank can
  // change its offerings between probes.
  available_tan_methods: jsonb("available_tan_methods")
    .$type<{ id: number; name: string; isDecoupled: boolean }[]>(),
  // Persisted lib-fints bankingInformation (BPD + UPD + the bank-
  // assigned `systemId`) from the last successful FinTS dialog.
  // Reusing it via `FinTSConfig.fromBankingInformation` lets the bank
  // recognise the client across syncs and skip the TAN under PSD2's
  // 90-day rule. Cleared whenever credentials change so a stale
  // session doesn't haunt the next dialog. Untyped here so the file
  // stays ignorant of lib-fints' internal shape — fints-client casts
  // before handing it to FinTSConfig.
  banking_information: jsonb("banking_information").$type<Record<string, unknown>>(),
  sync_times: jsonb("sync_times")
    .notNull()
    .default(sql`'[]'::jsonb`)
    .$type<FinanceSyncSlot[]>(),
  last_sync_at: timestamp("last_sync_at", { mode: "string", withTimezone: true }),
  last_sync_status: text("last_sync_status"),
  created_at: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const financeAccount = pgTable(
  "finance_account",
  {
    id: serial("id").primaryKey(),
    // Nullable: null = manual account (not linked to a bank). On
    // bankcontact-delete we SET NULL (unlink) rather than cascading,
    // so bookings survive if the bank connection is removed.
    bankcontact_id: integer("bankcontact_id").references(
      () => financeBankcontact.id,
      { onDelete: "set null" },
    ),
    // lib-fints' accountNumber for the linked bank-side account, used
    // by the statement-fetch path to match bank snapshots to fk-encore
    // accounts. NULL for manual accounts.
    fints_account_number: text("fints_account_number"),
    type_id: integer("type_id")
      .notNull()
      .references(() => financeAccountType.id, { onDelete: "restrict" }),
    currency_code: text("currency_code")
      .notNull()
      .references(() => financeCurrency.code, { onDelete: "restrict" }),
    iban: text("iban").unique(),
    account_number: text("account_number").notNull(),
    label: text("label").notNull(),
    // Non-null marks the account as closed: sync ignores it and the
    // manual booking endpoint refuses inserts. Stored as a timestamp
    // (rather than a boolean) so the UI can show *when* it happened
    // without a separate audit table.
    closed_at: timestamp("closed_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("finance_account_unique_bank_link").on(
      table.bankcontact_id,
      table.fints_account_number,
      table.type_id,
    ),
  ],
);

// ---------- ACL ----------
//
// Replaces the two legacy Finanzkraft roles Fk_AccountReader /
// Fk_AccountWriter with a row-level access list. fk-encore's role matrix
// (admin / user / photo user / …) stays untouched.

export const financeAccountAccess = pgTable(
  "finance_account_access",
  {
    account_id: integer("account_id")
      .notNull()
      .references(() => financeAccount.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    level: financeAccountLevelEnum("level").notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.account_id, table.user_id] })]
);

// ---------- Transaktionen + Salden ----------
//
// dedupe_hash = SHA-256 over (booking_date, value_date, amount, currency,
// purpose, counterparty_iban). When the bank provides a stable fints_id
// the importer prefers that for duplicate detection; the hash is the
// fallback for manual bookings and imports where fints_id is missing.

export const financeTransaction = pgTable(
  "finance_transaction",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    account_id: integer("account_id")
      .notNull()
      .references(() => financeAccount.id, { onDelete: "restrict" }),
    booking_date: timestamp("booking_date", { mode: "string" }).notNull(),
    value_date: timestamp("value_date", { mode: "string" }),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency_code: text("currency_code")
      .notNull()
      .references(() => financeCurrency.code, { onDelete: "restrict" }),
    purpose: text("purpose"),
    counterparty: text("counterparty"),
    counterparty_iban: text("counterparty_iban"),
    counterparty_bic: text("counterparty_bic"),
    counterparty_bank_id: text("counterparty_bank_id"),
    /** SEPA End-to-End reference (EREF). */
    end_to_end_ref: text("end_to_end_ref"),
    /** SEPA Mandate reference (MREF) for direct debits. */
    mandate_ref: text("mandate_ref"),
    /** SEPA Creditor identifier (CRED / CI). */
    creditor_id: text("creditor_id"),
    /** Bank-side reference (REF) — internal booking number, not E2E. */
    bank_ref: text("bank_ref"),
    /** Abweichender Auftraggeber (ABWA): the actual payer when
     *  different from the account-holder of the debiting account. */
    originator_name: text("originator_name"),
    /** Abweichender Zahlungsempfänger (ABWE): final beneficiary when
     *  different from the receiver-account holder. */
    recipient_name: text("recipient_name"),
    /** ISO Bank Transaction Code — Domain (MT940: funds-code char;
     *  CAMT: BkTxCd/Domn/Cd or credit/debit indicator). */
    funds_code: text("funds_code"),
    /** ISO Bank Transaction Code — Family (MT940: GVC / Geschäftsvorfall-
     *  Code e.g. "NTRF", "RCDT", "ICDT"; CAMT: BkTxCd/Domn/Fmly/Cd).
     *  Formerly stored as gv_code; renamed for consistency with the
     *  flanking ISO BTC columns. */
    transaction_type: text("transaction_type"),
    /** ISO Bank Transaction Code — SubFamily (MT940: sub-field 61 code;
     *  CAMT: BkTxCd/Domn/Fmly/SubFmlyCd). */
    transaction_code: text("transaction_code"),
    /** MT940 entry text ("Lastschrift", "Gutschrift", "Überweisung", …). */
    entry_text: text("entry_text"),
    /** Primanota number — bank-internal posting batch id. */
    prima_nota_no: text("prima_nota_no"),
    /** When the booking was settled in a different currency than the
     *  account, `original_amount` + `original_currency_code` carry the
     *  pre-conversion booking and `exchange_rate` records the rate
     *  applied. All three null for plain same-currency bookings. */
    original_amount: numeric("original_amount", { precision: 14, scale: 2 }),
    original_currency_code: text("original_currency_code"),
    exchange_rate: numeric("exchange_rate", { precision: 12, scale: 6 }),
    notice: text("notice"),
    dedupe_hash: text("dedupe_hash").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("finance_transaction_dedupe_unique").on(
      table.account_id,
      table.dedupe_hash,
    ),
    index("finance_transaction_account_booking_idx").on(
      table.account_id,
      table.booking_date,
    ),
  ]
);

export const financeAccountBalance = pgTable(
  "finance_account_balance",
  {
    account_id: integer("account_id")
      .notNull()
      .references(() => financeAccount.id, { onDelete: "cascade" }),
    as_of: timestamp("as_of", { mode: "string", withTimezone: true }).notNull(),
    balance: numeric("balance", { precision: 14, scale: 2 }).notNull(),
    source: text("source").notNull(), // "fints" | "manual" | "import"
  },
  (table) => [primaryKey({ columns: [table.account_id, table.as_of] })]
);

// ---------- Depot Holdings ----------

export const financeAccountHolding = pgTable(
  "finance_account_holding",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    account_id: integer("account_id")
      .notNull()
      .references(() => financeAccount.id, { onDelete: "cascade" }),
    as_of: timestamp("as_of", { mode: "string" }).notNull(),
    isin: text("isin"),
    wkn: text("wkn"),
    name: text("name"),
    amount: numeric("amount", { precision: 20, scale: 8 }),
    price: numeric("price", { precision: 20, scale: 6 }),
    value: numeric("value", { precision: 18, scale: 2 }),
    currency: text("currency"),
    acquisition_date: timestamp("acquisition_date", { mode: "string" }),
    acquisition_price: numeric("acquisition_price", { precision: 20, scale: 6 }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("finance_account_holding_account_asof_idx").on(
      table.account_id,
      table.as_of,
    ),
  ]
);

// ---------- Tags ----------
//
// Same tag name can exist once as source='user' and once as source='ai'
// (the uniqueIndex is over the pair). Promotion = delete the 'ai' row
// and upsert the 'user' row. `confidence` is only meaningful for AI
// rows and stays NULL for user tags.

export const financeTag = pgTable(
  "finance_tag",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    source: financeTagSourceEnum("source").notNull().default("user"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("finance_tag_name_source_unique").on(table.name, table.source),
  ]
);

export const financeTagTransaction = pgTable(
  "finance_tag_transaction",
  {
    tag_id: integer("tag_id")
      .notNull()
      .references(() => financeTag.id, { onDelete: "cascade" }),
    transaction_id: integer("transaction_id")
      .notNull()
      .references(() => financeTransaction.id, { onDelete: "cascade" }),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tag_id, table.transaction_id] }),
    index("finance_tag_transaction_transaction_idx").on(table.transaction_id),
  ]
);

// ---------- TAN-Sessions + System-Preferences ----------

export const financeTanSession = pgTable(
  "finance_tan_session",
  {
    tan_reference: uuid("tan_reference").primaryKey(),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bankcontact_id: integer("bankcontact_id")
      .notNull()
      .references(() => financeBankcontact.id, { onDelete: "cascade" }),
    banking_information: jsonb("banking_information")
      .notNull()
      .$type<Record<string, unknown>>(),
    challenge: text("challenge").notNull(),
    /**
     * photoTAN / Flicker-TAN matrix from the bank's last challenge,
     * if any. Persisted (rather than just held in-memory) so the
     * dialog survives a page reload — the user has to scan the
     * matrix on a separate device, and that takes a moment.
     */
    tan_photo_mime: text("tan_photo_mime"),
    tan_photo_base64: text("tan_photo_base64"),
    tan_media_name: text("tan_media_name"),
    /**
     * What kind of FinTS dialog this session resumes:
     *   "sync"       — initial synchronize() / synchronizeWithTan
     *   "statements" — getAccountStatements / …WithTan, mid-fetch
     * Drives the branch in tan-sessions.complete.
     */
    kind: text("kind").notNull().default("sync").$type<"sync" | "statements">(),
    /**
     * Mid-fetch resume state for kind="statements": which bank
     * accountNumber the dialog was waiting on, and which others are
     * still queued behind it. After the user submits the TAN we
     * continue the loop from there.
     */
    fetch_context: jsonb("fetch_context").$type<{
      currentAccountNumber: string;
      remainingAccountNumbers: string[];
      linkedAccountNumbers: string[];
    } | null>(),
    expires_at: timestamp("expires_at", { mode: "string", withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("finance_tan_session_expires_idx").on(table.expires_at),
  ]
);

export const financeSystemPref = pgTable("finance_system_pref", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().$type<unknown>(),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------- Per-user overview-page configuration ----------
//
// One JSONB blob per (user_id, key). The default key is "overview" and
// holds the user's groupings on the finance overview landing page —
// section names + account ids in display order. Surfaced as an opaque
// JSON document so adding more sections / fields later does not need a
// schema change. The shape is enforced at the API boundary in
// finance/overview.ts.

export interface FinanceOverviewSection {
  /** Display name, e.g. "Täglich", "Sparen". */
  name: string;
  /** Ordered list of finance_account ids that belong to this section. */
  account_ids: number[];
}

export interface FinanceOverviewConfig {
  sections: FinanceOverviewSection[];
}

export const financeUserPref = pgTable(
  "finance_user_pref",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull().$type<unknown>(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.key] })],
);

export const documentsUserPref = pgTable(
  "documents_user_pref",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull().$type<unknown>(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.key] })],
);

// ========== Finance Tag Queue ==========

export const financeTagQueue = pgTable(
  "finance_tag_queue",
  {
    id: serial("id").primaryKey(),
    transaction_id: integer("transaction_id")
      .notNull()
      .references(() => financeTransaction.id, { onDelete: "cascade" }),
    user_id: integer("user_id")
      .references(() => users.id, { onDelete: "set null" }),
    status: scanStatusEnum("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(2),
    attempts: integer("attempts").notNull().default(0),
    error_msg: text("error_msg"),
    enqueued_at: timestamp("enqueued_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    started_at: timestamp("started_at", { mode: "string", withTimezone: true }),
    finished_at: timestamp("finished_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    index("idx_finance_tag_queue_pickup").on(table.priority, table.enqueued_at),
    index("idx_finance_tag_queue_status").on(table.status),
  ]
);

// ========== Finance anomaly detection ==========

export const financeRecurringMandate = pgTable(
  "finance_recurring_mandate",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    account_id: integer("account_id")
      .notNull()
      .references(() => financeAccount.id, { onDelete: "cascade" }),
    mandate_ref: text("mandate_ref"),
    creditor_id: text("creditor_id"),
    counterparty_iban: text("counterparty_iban"),
    counterparty: text("counterparty"),
    typical_amount: numeric("typical_amount", { precision: 12, scale: 2 }),
    typical_interval_days: integer("typical_interval_days"),
    transaction_count: integer("transaction_count").notNull().default(0),
    first_seen: text("first_seen"),
    last_seen: text("last_seen"),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export const financeAnomaly = pgTable(
  "finance_anomaly",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    account_id: integer("account_id")
      .notNull()
      .references(() => financeAccount.id, { onDelete: "cascade" }),
    transaction_id: bigserial("transaction_id", { mode: "number" })
      .references(() => financeTransaction.id, { onDelete: "set null" }),
    mandate_id: bigserial("mandate_id", { mode: "number" })
      .references(() => financeRecurringMandate.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    score: numeric("score", { precision: 5, scale: 4 }).notNull().default("1.0"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    acknowledged_at: timestamp("acknowledged_at", { mode: "string", withTimezone: true }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_finance_anomaly_unread").on(table.account_id, table.created_at),
  ]
);

// ---------- AI-tag block list ----------
// Records (account, counterparty, tag) tuples that the user has rejected
// from the AI suggestion list. The suggester consults this table before
// persisting new suggestions, so a once-rejected tag does not keep
// re-appearing on similar transactions of the same counterparty.
export const financeTagBlocklist = pgTable(
  "finance_tag_blocklist",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    account_id: integer("account_id")
      .notNull()
      .references(() => financeAccount.id, { onDelete: "cascade" }),
    /** Lowercased + trimmed counterparty; empty string for cash transactions. */
    counterparty_norm: text("counterparty_norm").notNull(),
    tag_name: text("tag_name").notNull(),
    created_by_user_id: integer("created_by_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    created_at: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("finance_tag_blocklist_unique")
      .on(table.account_id, table.counterparty_norm, table.tag_name),
    index("idx_finance_tag_blocklist_lookup")
      .on(table.account_id, table.counterparty_norm),
  ]
);

// ========== Scheduled job state (lib/local-cron.ts) ==========

// ========== AI Model Slot Queue (ai-queue service) ==========

export const aiModelSlot = pgTable(
  "ai_model_slot",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    model_name: text("model_name").notNull(),
    priority: integer("priority").notNull().default(2),
    requester: text("requester").notNull(),
    status: text("status").notNull().default("waiting"),
    enqueued_at: timestamp("enqueued_at", { mode: "string", withTimezone: true })
      .notNull()
      .defaultNow(),
    activated_at: timestamp("activated_at", { mode: "string", withTimezone: true }),
  },
  (table) => [
    index("idx_model_slot_dequeue")
      .on(table.model_name, table.status, table.priority, table.enqueued_at),
  ]
);

// ========== Scheduled job state (lib/local-cron.ts) ==========

export const scheduledJobState = pgTable("scheduled_job_state", {
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  last_run_at: timestamp("last_run_at", { mode: "string", withTimezone: true }),
  last_status: text("last_status"),
  last_duration_ms: integer("last_duration_ms"),
  last_error: text("last_error"),
  run_count: integer("run_count").notNull().default(0),
  error_count: integer("error_count").notNull().default(0),
  updated_at: timestamp("updated_at", { mode: "string", withTimezone: true })
    .notNull()
    .defaultNow(),
});
