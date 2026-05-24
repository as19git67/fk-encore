// ========== User Types ==========

export interface User {
  id: number;
  email: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface UserRow extends User {
  password_hash: string;
}

export interface CreateUserRequest {
  email: string;
  name: string;
  password: string;
}

export interface UpdateUserRequest {
  id: number;
  email?: string;
  name?: string;
  password?: string;
}

export interface UserWithRoles extends User {
  roles: Role[];
}

// ========== Permission Types ==========

export interface Permission {
  id: number;
  key: string;
  description: string;
}

export interface RoleWithPermissions extends Role {
  permissions: Permission[];
}

export interface AssignPermissionRequest {
  roleId: number;
  permissionId: number;
}

export interface RolePermissionsResponse {
  roleId: number;
  permissions: Permission[];
}

export interface UserWithRolesAndPermissions extends User {
  roles: Role[];
  permissions: string[];
}

// ========== Auth Types ==========

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}


export interface RequestPasswordResetRequest {
  email: string;
}

export interface RequestPasswordResetResponse {
  success: boolean;
  message: string;
}

export interface ResetPasswordRequest {
  token: string;
  new_password: string;
}

export interface ResetPasswordResponse {
  success: boolean;
  message: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: UserWithRolesAndPermissions;
  token: string;
  refreshToken: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  token: string;
  refreshToken: string;
  user: UserWithRolesAndPermissions;
}

export interface LogoutResponse {
  success: boolean;
  message: string;
}

// ========== Passkey Types ==========

export interface PasskeyRow {
  credential_id: string;
  user_id: number;
  public_key: string;
  counter: number;
  device_type: string;
  backed_up: number;
  transports: string;
  name: string;
  created_at: string;
}

export interface PasskeyInfo {
  credential_id: string;
  name: string;
  device_type: string;
  backed_up: boolean;
  created_at: string;
}

// WebAuthn protocol types (used in passkey registration/authentication flows)

export interface WebAuthnRp {
  name: string;
  id?: string;
}

export interface WebAuthnUser {
  id: string;
  name: string;
  displayName: string;
}

export interface WebAuthnPubKeyParam {
  type: string;
  alg: number;
}

export interface WebAuthnCredentialDescriptor {
  id: string;
  type: string;
  transports?: string[];
}

export interface WebAuthnAuthenticatorSelection {
  authenticatorAttachment?: string;
  requireResidentKey?: boolean;
  residentKey?: string;
  userVerification?: string;
}

export interface WebAuthnRegistrationOptions {
  rp: WebAuthnRp;
  user: WebAuthnUser;
  challenge: string;
  pubKeyCredParams: WebAuthnPubKeyParam[];
  timeout?: number;
  excludeCredentials?: WebAuthnCredentialDescriptor[];
  authenticatorSelection?: WebAuthnAuthenticatorSelection;
  attestation?: string;
  hints?: string[];
  attestationFormats?: string[];
}

export interface WebAuthnAuthenticationOptions {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: WebAuthnCredentialDescriptor[];
  userVerification?: string;
  hints?: string[];
}

export interface WebAuthnRegistrationCredentialResponse {
  clientDataJSON: string;
  attestationObject: string;
  authenticatorData?: string;
  transports?: string[];
  publicKeyAlgorithm?: number;
  publicKey?: string;
}

export interface WebAuthnClientExtensionResults {
  appid?: boolean;
  credProps?: { rk?: boolean };
}

export interface WebAuthnRegistrationCredential {
  id: string;
  rawId: string;
  response: WebAuthnRegistrationCredentialResponse;
  authenticatorAttachment?: string;
  clientExtensionResults: WebAuthnClientExtensionResults;
  type: string;
}

export interface WebAuthnAuthenticationCredentialResponse {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string;
}

export interface WebAuthnAuthenticationCredential {
  id: string;
  rawId: string;
  response: WebAuthnAuthenticationCredentialResponse;
  authenticatorAttachment?: string;
  clientExtensionResults: WebAuthnClientExtensionResults;
  type: string;
}

export interface PasskeyRegistrationOptionsResponse {
  challengeId: string;
  options: WebAuthnRegistrationOptions;
}

export interface PasskeyRegistrationVerifyRequest {
  challengeId: string;
  credential: WebAuthnRegistrationCredential;
  name?: string;
}

export interface PasskeyAuthOptionsResponse {
  challengeId: string;
  options: WebAuthnAuthenticationOptions;
}

export interface PasskeyAuthVerifyRequest {
  challengeId: string;
  credential: WebAuthnAuthenticationCredential;
}

export interface ListPasskeysResponse {
  passkeys: PasskeyInfo[];
}

// ========== Role Types ==========

export interface Role {
  id: number;
  name: string;
  description: string;
}

export interface CreateRoleRequest {
  name: string;
  description?: string;
}

export interface UpdateRoleRequest {
  id: number;
  name?: string;
  description?: string;
}

export interface RoleWithUsers extends Role {
  users: User[];
}

// ========== User-Role Types ==========

export interface AssignRoleRequest {
  userId: number;
  roleId: number;
}

export interface UserRolesResponse {
  userId: number;
  roles: Role[];
}

// ========== Generic Responses ==========

export interface ListUsersResponse {
  users: UserWithRoles[];
}

export interface ListRolesResponse {
  roles: RoleWithPermissions[];
}

export interface ListPermissionsResponse {
  permissions: Permission[];
}

export interface DeleteResponse {
  success: boolean;
  message: string;
}

// ========== Photo Types ==========

export interface Photo {
  id: number;
  user_id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  hash?: string;
  taken_at?: string;
  created_at: string;
  /**
   * Server-side timestamp bumped by a DB trigger on every photo or curation
   * update. Used by clients to detect when a cached photo entry has changed
   * on the server (issue #303, #335).
   */
  updated_at?: string;
  latitude?: number;
  longitude?: number;
  location_name?: string;
  location_city?: string;
  location_country?: string;
  location_short?: string;
  ai_quality_score?: number;
  ai_quality_details?: Record<string, number>;
  auto_crop?: { x: number; y: number };
  description?: string;
  /** IPTC Keywords / XMP dc:subject — user-facing tags imported from the file. */
  keywords?: string[];
}

export interface FaceBBox { x: number; y: number; width: number; height: number; }

export interface Face {
  id: number;
  user_id: number;
  photo_id: number;
  bbox: FaceBBox; // relativ (0..1)
  embedding: number[]; // Float32-Werte
  person_id?: number;
  quality?: number;
  ignored: boolean;
  created_at: string;
  photo?: {
    id: number;
    user_id: number;
    filename: string;
    original_name: string;
    taken_at?: string;
    created_at: string;
  };
}

export interface Person {
  id: number;
  user_id: number;
  name: string;
  cover_face_id?: number;
  cover_filename?: string;
  cover_bbox?: FaceBBox;
  created_at: string;
  updated_at: string;
}

export interface ListPersonsResponse {
  persons: (Person & {
    faceCount: number;
    oldest_photo_at?: string;
    newest_photo_at?: string;
  })[];
  enableLocalFaces: boolean;
}
export interface PersonDetails extends Person { faces: Face[] }

export interface AssignFaceRequest { faceId: number; personId: number }
export interface MergePersonsRequest { sourceIds: number[]; targetId: number }

export interface Album {
  id: number;
  user_id: number;
  name: string;
  description?: string;
  event_name?: string;
  cover_photo_id?: number;
  cover_filename?: string;
  display_mode: "grid" | "map";
  newest_photo_at?: string;
  oldest_photo_at?: string;
  photo_count: number;
  is_shared: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Access level of the current caller relative to this album.
   * "owner" for the owner, otherwise the participant's access_level.
   * Undefined if the album is returned without an authenticated context.
   */
  my_access_level?: "owner" | AlbumAccessLevel;
}

export interface AlbumWithPhotos extends Album {
  photos: AlbumPhotoWithMeta[];
  settings?: AlbumUserSettings;
  role: "owner" | "admin" | "contributor" | "viewer";
}

export interface AlbumPhotoWithMeta extends PhotoWithCuration {
  added_by_user_id?: number;
  added_at: string;
  curation_stats?: PhotoCurationStats;
}

export type AlbumAccessLevel = "read" | "write" | "write_share";

export interface AlbumShare {
  album_id: number;
  user_id: number;
  access_level: AlbumAccessLevel;
  /** User who created this share. NULL for shares predating the invited_by
   *  migration — treated as invited by the album owner. */
  invited_by_user_id?: number | null;
}

// ── View Config for Album Views ──────────────────────────────────────────────

export type ActiveView = "all" | "favorites" | "consensus" | "others-favorites" | "custom";

export interface ViewConfig {
  /** Which hidden photos to filter out */
  hideFilter: "none" | "mine" | "consensus";
  /** Minimum number of users who hid a photo for consensus hide */
  hideConsensusMin?: number;
  /** Which favorites filter to apply */
  favFilter: "all" | "mine" | "any" | "consensus" | "others-not-mine";
  /** Minimum number of users who favorited for consensus favorites */
  favConsensusMin?: number;
}

/** Anonymized curation statistics for a photo within a shared album */
export interface PhotoCurationStats {
  /** Number of album participants who favorited this photo */
  fav_count: number;
  /** Number of album participants who hid this photo */
  hide_count: number;
  /** Total number of album participants (owner + shared users) */
  member_count: number;
}

export interface AlbumUserSettings {
  album_id: number;
  user_id: number;
  hide_mode: "mine" | "all";
  active_view: ActiveView;
  view_config?: ViewConfig | null;
  cover_photo_id?: number;
}

export interface UpdateAlbumUserSettingsRequest {
  albumId: number;
  hideMode?: "mine" | "all";
  activeView?: ActiveView;
  viewConfig?: ViewConfig | null;
  coverPhotoId?: number | null;
}

export interface CreateAlbumRequest {
  name: string;
  description?: string;
  displayMode?: "grid" | "map";
}

export interface UpdateAlbumRequest {
  id: number;
  name?: string;
  description?: string;
  coverPhotoId?: number | null;
  displayMode?: "grid" | "map";
}

export interface AddPhotoToAlbumRequest {
  albumId: number;
  photoId: number;
}

export interface BatchAlbumPhotosRequest {
  albumIds: number[];
  photoIds: number[];
  action: "add" | "remove";
}

export interface PhotoAlbumsResponse {
  photoId: number;
  albumIds: number[];
}

export interface ListPhotoAlbumsResponse {
  results: PhotoAlbumsResponse[];
}

export interface PhotoLocationAlbum {
  id: number;
  name: string;
}

export interface PhotoLocationPerson {
  id: number;
  name: string;
}

/**
 * Jump-destinations for a single photo: used by the "Show photo in…" menu.
 * Returned by GET /photos/:id/locations.
 */
export interface PhotoLocationsResponse {
  photoId: number;
  albums: PhotoLocationAlbum[];
  persons: PhotoLocationPerson[];
  hasGps: boolean;
}

export interface ShareAlbumRequest {
  albumId: number;
  userId: number;
  accessLevel: AlbumAccessLevel;
}

export interface AlbumShareWithUser extends AlbumShare {
  user_name: string;
  user_email: string;
}

export interface GetAlbumSharesResponse {
  shares: AlbumShareWithUser[];
  publicLink?: AlbumPublicLink;
}

export interface ShareableUser {
  id: number;
  name: string;
  email: string;
}

export interface GetAlbumShareableUsersResponse {
  users: ShareableUser[];
}

export interface AlbumPublicLink {
  id: number;
  album_id: number;
  token: string;
  created_by_user_id: number;
  created_at: string;
  expires_at?: string;
}

export interface CreateAlbumPublicLinkRequest {
  albumId: number;
  expiresIn?: "7d" | "30d" | "90d";
}

export interface PublicAlbumResponse {
  id: number;
  name: string;
  description?: string;
  display_mode: "grid" | "map";
  cover_filename?: string;
  newest_photo_at?: string;
  oldest_photo_at?: string;
  photo_count: number;
  photos: PublicAlbumPhoto[];
}

export interface PublicAlbumPhoto {
  id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  taken_at?: string;
  created_at: string;
  latitude?: number;
  longitude?: number;
  location_name?: string;
  location_city?: string;
  location_country?: string;
  ai_quality_score?: number;
  auto_crop?: { x: number; y: number };
  description?: string;
  /** Photo is a cover of a similarity group curated by the album owner. */
  is_highlight?: boolean;
  /** Album owner has hidden this photo in their curation. */
  is_hidden?: boolean;
}

export interface RemoveAlbumShareRequest {
  albumId: number;
  userId: number;
}

export interface ListAlbumsResponse {
  albums: Album[];
}

export type CurationStatus = "visible" | "hidden" | "favorite";

export interface PhotoWithCuration extends Photo {
  curation_status: CurationStatus;
}

export interface ListPhotosResponse {
  photos: PhotoWithCuration[];
}

/**
 * Lightweight photo entry for the gallery grid index.
 * Contains only the fields needed to render thumbnails and group by date —
 * heavy fields (location_*, ai_quality_details, description, hash, GPS) are
 * loaded on demand via the /photos/details endpoint.
 */
export interface PhotoIndexEntry {
  id: number;
  user_id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  taken_at?: string;
  created_at: string;
  /**
   * DB-trigger maintained timestamp. Bumped on every photo UPDATE and
   * curation change (see migration 0034). Clients use this to detect when a
   * cached photo's metadata has changed on the server without re-fetching
   * the full /photos/details payload (issue #303).
   */
  updated_at?: string;
  /**
   * SHA-256 hash of the uploaded file. Included so clients (e.g. the iOS
   * download sync) can detect when a photo's pixel data has changed on the
   * server and replace the local copy. Optional because legacy rows from
   * before the hash column was introduced may still carry NULL.
   */
  hash?: string;
  curation_status: CurationStatus;
  auto_crop?: { x: number; y: number };
}

export interface ListPhotoIndexResponse {
  photos: PhotoIndexEntry[];
  /**
   * Total number of rows matching the filter (across all pages). Only set
   * when the request supplied a `limit` — unpaged requests omit this so
   * existing clients do not pay the COUNT(*) cost.
   */
  total?: number;
}

// ─── Virtualized gallery grid (GET /gallery/grid) ─────────────────────────────
// Pre-enriched per-photo payload designed to feed a virtualized scroller. The
// shape is intentionally minimal: the client only needs what fits inside a
// thumbnail cell. Fullscreen / detail data lives behind separate endpoints
// and is fetched on demand when the user opens a single photo.

/**
 * The "best matching" similar-photo group this photo belongs to, with the
 * preference computed server-side (unreviewed groups win). NULL when the
 * photo is not in any group.
 */
export interface GalleryGridGroup {
  id: number;
  /** True when this photo is the cover_photo_id of the group. */
  is_cover: boolean;
  /** Total number of photos in the group. */
  member_count: number;
  /** True when the user has marked the group as reviewed. */
  reviewed: boolean;
  // AI auto-pick (Track I). Absent when the group has not yet been
  // scored — the marker UI then falls back to today's review-on-click
  // behaviour. ai_picked is true on photos in ai_picked_photo_ids.
  ai_picked?: boolean;
  ai_confidence?: "high" | "medium" | "low";
}

/** One cell in the virtualized gallery grid. */
export interface GalleryGridEntry {
  id: number;
  filename: string;
  curation: CurationStatus;
  /** Auto-crop hint for the thumbnail container (object-position). */
  auto_crop?: { x: number; y: number };
  /** Group info if the photo participates in a similar-photo group. */
  group?: GalleryGridGroup;
}

/**
 * Window response. The client never iterates the full library — `total`
 * drives the virtualizer's row count, `offset` locates the first returned
 * photo in the global ordering, and `photos` is the dense window.
 */
export interface GalleryGridResponse {
  total: number;
  offset: number;
  photos: GalleryGridEntry[];
}

export interface PhotoDetailsBatchResponse {
  photos: PhotoWithCuration[];
}

export interface PhotoGroup {
  id: number;
  user_id: number;
  cover_photo_id?: number;
  reviewed_at?: string;
  created_at: string;
  member_count: number;
  photo_ids: number[];
  // AI auto-pick (Track I, see migration 0075). Absent when the group
  // has not yet been scored; the gallery falls back to today's review
  // workflow in that case.
  ai_picked_photo_ids?: number[];
  ai_picked_confidence?: "high" | "medium" | "low";
  ai_picked_at?: string;
}

export interface ListGroupsResponse {
  groups: PhotoGroup[];
}

export interface FindGroupsResponse {
  groups_created: number;
  total_photos_grouped: number;
}

// ========== Landmark Types ==========

export interface LandmarkBBox { x: number; y: number; width: number; height: number; }

export interface Landmark {
  id: number;
  photo_id: number;
  user_id: number;
  label: string;
  confidence: number;
  bbox: LandmarkBBox;
  created_at?: string;
}

export interface UpdateCurationRequest {
  id: number;
  status: CurationStatus;
}
