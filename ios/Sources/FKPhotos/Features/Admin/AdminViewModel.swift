import Foundation

@Observable
final class AdminViewModel {
    var users: [UserWithRoles] = []
    var roles: [RoleWithPermissions] = []
    var isLoading = false
    var errorMessage: String?

    @MainActor
    func loadUsers() async {
        isLoading = true
        do {
            let response: ListUsersResponse = try await APIClient.shared.get("/users")
            users = response.users
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    @MainActor
    func loadRoles() async {
        do {
            let response: ListRolesResponse = try await APIClient.shared.get("/roles")
            roles = response.roles
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    func deleteUser(id: Int) async {
        do {
            let _: DeleteResponse = try await APIClient.shared.delete("/users/\(id)")
            users.removeAll { $0.id == id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
