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


export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: UserWithRolesAndPermissions;
  token: string;
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

export interface PasskeyRegistrationOptionsResponse {
  challengeId: string;
  options: any;
}

export interface PasskeyRegistrationVerifyRequest {
  challengeId: string;
  credential: any;
  name?: string;
}

export interface PasskeyAuthOptionsResponse {
  challengeId: string;
  options: any;
}

export interface PasskeyAuthVerifyRequest {
  challengeId: string;
  credential: any;
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
  latitude?: number;
  longitude?: number;
  location_name?: string;
  location_city?: string;
  location_country?: string;
  ai_quality_score?: number;
  ai_quality_details?: Record<string, number>;
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
  persons: (Person & { faceCount: number })[];
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
  cover_photo_id?: number;
  cover_filename?: string;
  created_at: string;
  updated_at: string;
}

export interface AlbumWithPhotos extends Album {
  photos: AlbumPhotoWithMeta[];
  settings?: AlbumUserSettings;
  role: "owner" | "admin" | "contributor" | "viewer";
}

export interface AlbumPhotoWithMeta extends PhotoWithCuration {
  added_by_user_id?: number;
  added_at: string;
}

export interface AlbumShare {
  album_id: number;
  user_id: number;
  access_level: "read" | "write";
}

export interface AlbumUserSettings {
  album_id: number;
  user_id: number;
  hide_mode: "mine" | "all";
  active_view: "all" | "favorites" | "by_user";
  view_config?: any;
}

export interface UpdateAlbumUserSettingsRequest {
  albumId: number;
  hideMode?: "mine" | "all";
  activeView?: "all" | "favorites" | "by_user";
  viewConfig?: any;
}

export interface CreateAlbumRequest {
  name: string;
  description?: string;
}

export interface UpdateAlbumRequest {
  id: number;
  name?: string;
  description?: string;
  coverPhotoId?: number | null;
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

export interface ShareAlbumRequest {
  albumId: number;
  userId: number;
  accessLevel: "read" | "write";
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

export interface PhotoGroup {
  id: number;
  user_id: number;
  cover_photo_id?: number;
  reviewed_at?: string;
  created_at: string;
  member_count: number;
  photo_ids: number[];
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
