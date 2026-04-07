import Foundation

@Observable
final class AlbumShareViewModel {
    let albumId: Int

    var shares: [AlbumShareWithUser] = []
    var publicLink: AlbumPublicLink?
    var users: [UserWithRoles] = []
    var isLoadingShares = false
    var isLoadingUsers = false
    var isSubmitting = false
    var errorMessage: String?
    var usersLoadFailed = false

    // Backend endpoints that return only { success: boolean }
    private struct BoolResponse: Codable { let success: Bool }

    init(albumId: Int) {
        self.albumId = albumId
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

    @MainActor
    func loadUsers() async {
        isLoadingUsers = true
        defer { isLoadingUsers = false }
        do {
            let response: ListUsersResponse = try await APIClient.shared.get("/users")
            users = response.users
            usersLoadFailed = false
        } catch {
            usersLoadFailed = true
        }
    }

    @MainActor
    func shareWithUser(userId: Int, accessLevel: String) async {
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
                body: Body(albumId: albumId, userId: userId, accessLevel: accessLevel)
            )
            await loadShares()
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
