import Foundation

// MARK: - User

struct User: Codable, Identifiable, Sendable {
    let id: Int
    let email: String
    let name: String
    let created_at: String
    let updated_at: String
}

struct UserWithRoles: Codable, Identifiable, Sendable {
    let id: Int
    let email: String
    let name: String
    let created_at: String
    let updated_at: String
    let roles: [Role]
}

struct UserWithRolesAndPermissions: Codable, Identifiable, Sendable {
    let id: Int
    let email: String
    let name: String
    let created_at: String
    let updated_at: String
    let roles: [Role]
    let permissions: [String]
}

// MARK: - Auth

struct LoginRequest: Codable, Sendable {
    let email: String
    let password: String
}

struct LoginResponse: Codable, Sendable {
    let user: UserWithRolesAndPermissions
    let token: String
    let refreshToken: String
}

struct RegisterRequest: Codable, Sendable {
    let email: String
    let name: String
    let password: String
}

// MARK: - Role & Permission

struct Role: Codable, Identifiable, Sendable {
    let id: Int
    let name: String
    let description: String
}

struct Permission: Codable, Identifiable, Sendable {
    let id: Int
    let key: String
    let description: String
}

struct RoleWithPermissions: Codable, Identifiable, Sendable {
    let id: Int
    let name: String
    let description: String
    let permissions: [Permission]
}

// MARK: - Photo

struct Photo: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let filename: String
    let original_name: String
    let mime_type: String
    let size: Int
    let hash: String?
    let taken_at: String?
    let created_at: String
    let latitude: Double?
    let longitude: Double?
    let location_name: String?
    let location_city: String?
    let location_country: String?
    let ai_quality_score: Double?
    let ai_quality_details: [String: Double]?
    let auto_crop: AutoCrop?
}

struct AutoCrop: Codable, Sendable {
    let x: Double
    let y: Double
}

enum CurationStatus: String, Codable, Sendable {
    case visible
    case hidden
    case favorite
}

struct PhotoWithCuration: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let filename: String
    let original_name: String
    let mime_type: String
    let size: Int
    let hash: String?
    let taken_at: String?
    let created_at: String
    let latitude: Double?
    let longitude: Double?
    let location_name: String?
    let location_city: String?
    let location_country: String?
    let ai_quality_score: Double?
    let auto_crop: AutoCrop?
    let curation_status: CurationStatus
    let description: String?
    let keywords: [String]?
}

// MARK: - Album

struct Album: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let name: String
    let description: String?
    let cover_photo_id: Int?
    let cover_filename: String?
    let display_mode: String
    let newest_photo_at: String?
    let oldest_photo_at: String?
    let photo_count: Int
    let is_shared: Bool
    let created_at: String
    let updated_at: String
}

// MARK: - Person & Face

struct FaceBBox: Codable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Person: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let name: String
    let cover_face_id: Int?
    let cover_filename: String?
    let cover_bbox: FaceBBox?
    let created_at: String
    let updated_at: String
}

struct PersonWithFaceCount: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let name: String
    let cover_face_id: Int?
    let cover_filename: String?
    let cover_bbox: FaceBBox?
    let created_at: String
    let updated_at: String
    let faceCount: Int
}

/// Minimal photo info embedded in a Face when fetched via GET /persons/:id
struct FacePhoto: Codable, Sendable {
    let id: Int
    let user_id: Int
    let filename: String
    let original_name: String
    let taken_at: String?
    let created_at: String
}

struct Face: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let photo_id: Int
    let bbox: FaceBBox
    let person_id: Int?
    let quality: Double?
    let ignored: Bool
    let created_at: String
    /// Present when fetched via GET /persons/:id
    let photo: FacePhoto?
}

struct PersonDetailsResponse: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let name: String
    let cover_face_id: Int?
    let faces: [Face]
}

// MARK: - Landmark

struct Landmark: Codable, Identifiable, Sendable {
    let id: Int
    let photo_id: Int
    let user_id: Int
    let label: String
    let confidence: Double
    let bbox: FaceBBox
    let created_at: String?
}

// MARK: - Album With Photos (download sync)

struct PhotoCurationStats: Codable, Sendable {
    let fav_count: Int
}

struct AlbumPhotoWithMeta: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let filename: String
    let original_name: String
    let mime_type: String
    let size: Int
    let hash: String?
    let taken_at: String?
    let created_at: String
    /// Server-side timestamp; bumped by a DB trigger on every metadata or
    /// curation change. Used by the iOS download sync to detect changes
    /// without re-fetching pixel data (issue #303).
    let updated_at: String?
    let latitude: Double?
    let longitude: Double?
    let location_name: String?
    let location_city: String?
    let location_country: String?
    let ai_quality_score: Double?
    let auto_crop: AutoCrop?
    let curation_status: CurationStatus
    let description: String?
    let keywords: [String]?
    let added_by_user_id: Int?
    let added_at: String
    let curation_stats: PhotoCurationStats?
}

struct AlbumWithPhotos: Codable, Sendable {
    let id: Int
    let user_id: Int
    let name: String
    let description: String?
    let display_mode: String
    let photo_count: Int
    let is_shared: Bool
    let created_at: String
    let updated_at: String
    let photos: [AlbumPhotoWithMeta]
    let role: String
}

// MARK: - Album Sharing

struct AlbumShareWithUser: Codable, Identifiable, Sendable {
    let album_id: Int
    let user_id: Int
    let access_level: String // "read" | "write"
    let user_name: String
    let user_email: String

    var id: Int { user_id }
}

struct AlbumPublicLink: Codable, Identifiable, Sendable {
    let id: Int
    let album_id: Int
    let token: String
    let created_by_user_id: Int
    let created_at: String
    let expires_at: String?
}

struct GetAlbumSharesResponse: Codable, Sendable {
    let shares: [AlbumShareWithUser]
    let publicLink: AlbumPublicLink?
}

// MARK: - Timeline

struct TimelineMonth: Codable, Identifiable, Hashable, Sendable {
    let month: Int
    let count: Int
    let cover_filename: String?
    var id: Int { month }
}

struct TimelineYear: Codable, Identifiable, Hashable, Sendable {
    let year: Int
    let count: Int
    let cover_filename: String?
    let months: [TimelineMonth]
    var id: Int { year }
}

struct PhotoTimelineResponse: Codable, Sendable {
    let years: [TimelineYear]
}

// MARK: - API Response Wrappers

struct ListPhotosResponse: Codable, Sendable {
    let photos: [PhotoWithCuration]
}

struct ListAlbumsResponse: Codable, Sendable {
    let albums: [Album]
}

struct ListPersonsResponse: Codable, Sendable {
    let persons: [PersonWithFaceCount]
    let enableLocalFaces: Bool
}

struct ListFacesResponse: Codable, Sendable {
    let faces: [Face]
}

struct ListUsersResponse: Codable, Sendable {
    let users: [UserWithRoles]
}

struct ListRolesResponse: Codable, Sendable {
    let roles: [RoleWithPermissions]
}

struct DeleteResponse: Codable, Sendable {
    let success: Bool
    let message: String
}

struct SuccessResponse: Codable, Sendable {
    let success: Bool
    let message: String
}
