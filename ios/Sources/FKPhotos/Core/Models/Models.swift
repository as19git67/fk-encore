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
    /// ISO-8601 instant the access token expires. Optional so decoding still
    /// succeeds against an older server that doesn't send it yet.
    let expiresAt: String?
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
    let my_access_level: String?

    var hasWriteAccess: Bool {
        switch my_access_level {
        case "owner", "write", "write_share": return true
        default: return false
        }
    }
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

// MARK: - Album With Photos (download sync)

/// Anonymized curation counters for one photo inside a *shared* album
/// ("3 von 5 mögen es"). The server only attaches them when the album has more
/// than one participant — see `docs/album-photo-views.md`.
///
/// `hide_count` / `member_count` are optional purely for decode resilience: a
/// server predating them would otherwise fail the whole album payload, which
/// also carries the download sync. Read them through `hideCount` /
/// `memberCount`, which fall back to 0.
struct PhotoCurationStats: Codable, Sendable, Equatable {
    let fav_count: Int
    let hide_count: Int?
    let member_count: Int?

    var favCount: Int { fav_count }
    var hideCount: Int { hide_count ?? 0 }
    var memberCount: Int { member_count ?? 0 }

    /// True once at least one participant expressed an opinion — the gate for
    /// showing badges at all, so untouched photos stay visually quiet.
    var hasSignal: Bool { favCount > 0 || hideCount > 0 }

    init(fav_count: Int, hide_count: Int? = nil, member_count: Int? = nil) {
        self.fav_count = fav_count
        self.hide_count = hide_count
        self.member_count = member_count
    }
}

struct AlbumPhotoWithMeta: Codable, Identifiable, Sendable {
    let id: Int
    let user_id: Int
    let filename: String
    let original_name: String
    let mime_type: String
    let size: Int
    /// Full/state hash: changes on ANY sync-relevant edit (favorite, caption,
    /// date). Do NOT use this to decide whether pixels changed — use
    /// `image_data_hash` for that (otherwise metadata edits trigger a needless
    /// re-download + delete of the local asset).
    let hash: String?
    /// SHA-256 of the decoded pixel data — stable across metadata edits. Used by
    /// the download sync to detect a real pixel change. Optional: legacy rows
    /// may carry NULL.
    let image_data_hash: String?
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

/// One photo row of `GET /albums/:id` as the album detail grid needs it: the
/// regular photo payload plus the anonymized consensus counters that only
/// shared albums carry (issue #760).
///
/// Decoded through the *same* container as `PhotoWithCuration` rather than
/// re-listing its two dozen fields — the server sends one flat object, and
/// mirroring that here keeps the two models from drifting apart.
struct AlbumPhotoRow: Codable, Identifiable, Sendable {
    let photo: PhotoWithCuration
    let curation_stats: PhotoCurationStats?

    var id: Int { photo.id }

    private enum CodingKeys: String, CodingKey {
        case curation_stats
    }

    init(from decoder: Decoder) throws {
        photo = try PhotoWithCuration(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        curation_stats = try container.decodeIfPresent(PhotoCurationStats.self, forKey: .curation_stats)
    }

    func encode(to encoder: Encoder) throws {
        try photo.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(curation_stats, forKey: .curation_stats)
    }
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
    let access_level: String // "read" | "write" | "write_share"
    /// Who created this share. `nil` for shares that predate the field — the
    /// backend treats those as owner-created, so delegates can't revoke them.
    let invited_by_user_id: Int?
    let user_name: String
    let user_email: String

    var id: Int { user_id }
}

/// Access levels an album can be shared with — mirrors the web share dialog.
enum AlbumAccessLevel: String, CaseIterable, Identifiable, Sendable {
    case read
    case write
    case writeShare = "write_share"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .read:       return "Nur lesen"
        case .write:      return "Bearbeiten"
        case .writeShare: return "Bearbeiten + Teilen"
        }
    }

    /// Compact form for the share list rows.
    var shortLabel: String {
        switch self {
        case .read:       return "Nur lesen"
        case .write:      return "Bearbeiten"
        case .writeShare: return "Bearb. + Teilen"
        }
    }
}

/// Candidate for an album share — from `/albums/:id/shareable-users`, which is
/// open to owners and write_share delegates (unlike the admin-only `/users`).
struct ShareableUser: Codable, Identifiable, Sendable {
    let id: Int
    let name: String
    let email: String
}

struct GetAlbumShareableUsersResponse: Codable, Sendable {
    let users: [ShareableUser]
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
