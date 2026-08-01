import Foundation

@Observable
final class AlbumShareViewModel {
    let albumId: Int

    var shares: [AlbumShareWithUser] = []
    var publicLink: AlbumPublicLink?
    var candidates: [ShareableUser] = []
    var isLoadingShares = false
    var isLoadingUsers = false
    var isSubmitting = false
    var errorMessage: String?
    var usersLoadFailed = false
    /// The caller's own access level on this album ("owner" / "write_share" / …).
    /// Decides which levels may be granted and which shares may be revoked.
    /// `nil` while unresolved.
    private(set) var myAccessLevel: String?

    /// Access level passed in by the caller (the album detail view already knows
    /// it). When `nil` it is resolved from the album list — that is the path the
    /// trip view takes, which only knows the album id.
    private let providedAccessLevel: String?
    private var currentUserId: Int?

    // Backend endpoints that return only { success: boolean }
    private struct BoolResponse: Codable { let success: Bool }

    init(albumId: Int, accessLevel: String? = nil, currentUserId: Int? = nil) {
        self.albumId = albumId
        self.providedAccessLevel = accessLevel
        self.myAccessLevel = accessLevel
        self.currentUserId = currentUserId
    }

    /// The signed-in user id, supplied by the view once the environment's
    /// `AuthManager` is available.
    func setCurrentUserId(_ id: Int?) {
        currentUserId = id
    }

    var isOwner: Bool { myAccessLevel == "owner" }

    /// Owners may grant every level. A `write_share` delegate must not escalate
    /// — the backend rejects it — so they can only hand out read/write.
    var grantableAccessLevels: [AlbumAccessLevel] {
        isOwner ? AlbumAccessLevel.allCases : [.read, .write]
    }

    /// Delegates may only revoke invitations they created themselves; shares
    /// without a recorded inviter predate the field and stay owner-managed.
    func canRemove(_ share: AlbumShareWithUser) -> Bool {
        if isOwner { return true }
        guard let currentUserId, let invitedBy = share.invited_by_user_id else { return false }
        return invitedBy == currentUserId
    }

    /// Users that can still be invited: the backend already excludes the owner,
    /// the caller and existing shares, but the local list is filtered again so a
    /// just-added share disappears without a round trip.
    var availableUsers: [ShareableUser] {
        let sharedIds = Set(shares.map(\.user_id))
        return candidates.filter { !sharedIds.contains($0.id) }
    }

    @MainActor
    func load() async {
        await resolveAccessLevel()
        await loadShares()
        await loadCandidates()
    }

    /// Resolves the caller's access level from the album list when it wasn't
    /// handed in. Failure is non-fatal: the UI then falls back to the
    /// non-owner (delegate) capabilities, and the backend stays authoritative.
    @MainActor
    private func resolveAccessLevel() async {
        guard providedAccessLevel == nil else { return }
        do {
            let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
            myAccessLevel = response.albums.first { $0.id == albumId }?.my_access_level
        } catch {
            // Keep myAccessLevel nil — sharing still works, just without the
            // owner-only options.
        }
    }

    @MainActor
    func loadShares() async {
        isLoadingShares = true
        defer { isLoadingShares = false }
        errorMessage = nil
        do {
            let response: GetAlbumSharesResponse = try await APIClient.shared.get("/albums/\(albumId)/shares")
            shares = response.shares
            publicLink = response.publicLink
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Loads invitable users from the album-scoped endpoint, which owners and
    /// `write_share` delegates may call — unlike `/users`, which needs the
    /// global `users.list` permission.
    @MainActor
    func loadCandidates() async {
        isLoadingUsers = true
        defer { isLoadingUsers = false }
        do {
            let response: GetAlbumShareableUsersResponse = try await APIClient.shared.get(
                "/albums/\(albumId)/shareable-users"
            )
            candidates = response.users
            usersLoadFailed = false
        } catch {
            usersLoadFailed = true
        }
    }

    @MainActor
    func shareWithUser(userId: Int, accessLevel: AlbumAccessLevel) async {
        struct Body: Codable {
            let albumId: Int
            let userId: Int
            let accessLevel: String
        }
        isSubmitting = true
        defer { isSubmitting = false }
        errorMessage = nil
        do {
            let _: BoolResponse = try await APIClient.shared.post(
                "/albums/share",
                body: Body(albumId: albumId, userId: userId, accessLevel: accessLevel.rawValue)
            )
            await loadShares()
            await loadCandidates()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    func removeShare(userId: Int) async {
        errorMessage = nil
        do {
            let _: BoolResponse = try await APIClient.shared.delete("/albums/\(albumId)/shares/\(userId)")
            shares.removeAll { $0.user_id == userId }
            await loadCandidates()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    func createPublicLink(expiresIn: String?) async {
        struct Body: Codable { let expiresIn: String? }
        isSubmitting = true
        defer { isSubmitting = false }
        errorMessage = nil
        do {
            let link: AlbumPublicLink = try await APIClient.shared.post(
                "/albums/\(albumId)/public-link",
                body: Body(expiresIn: expiresIn)
            )
            publicLink = link
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    func deletePublicLink() async {
        errorMessage = nil
        do {
            let _: BoolResponse = try await APIClient.shared.delete("/albums/\(albumId)/public-link")
            publicLink = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
