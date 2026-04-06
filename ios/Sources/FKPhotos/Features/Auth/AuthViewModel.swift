import Foundation
import SwiftUI

@Observable
final class AuthViewModel {
    var email = ""
    var password = ""
    var name = ""
    var errorMessage: String?
    var isLoading = false

    @MainActor
    func login(authManager: AuthManager) async {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Bitte E-Mail und Passwort eingeben."
            return
        }

        isLoading = true
        errorMessage = nil

        do {
            try await authManager.login(email: email, password: password)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    @MainActor
    func register(authManager: AuthManager) async {
        guard !email.isEmpty, !password.isEmpty, !name.isEmpty else {
            errorMessage = "Bitte alle Felder ausfüllen."
            return
        }

        isLoading = true
        errorMessage = nil

        do {
            let request = RegisterRequest(email: email, name: name, password: password)
            let _: User = try await APIClient.shared.post("/users", body: request)
            // After registration, log in automatically
            try await authManager.login(email: email, password: password)
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }
}
