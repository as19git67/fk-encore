import Foundation

@Observable
final class PersonsViewModel {
    var persons: [PersonWithFaceCount] = []
    var isLoading = false
    var errorMessage: String?

    @MainActor
    func loadPersons() async {
        isLoading = true
        errorMessage = nil

        do {
            let response: ListPersonsResponse = try await APIClient.shared.get("/persons")
            persons = response.persons
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    @MainActor
    func renamePerson(id: Int, name: String) async {
        struct Body: Codable { let name: String }
        do {
            let _: Person = try await APIClient.shared.put("/persons/\(id)", body: Body(name: name))
            await loadPersons()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
