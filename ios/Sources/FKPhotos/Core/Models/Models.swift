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
