import Foundation
import SwiftUI

@Observable
final class AuthViewModel {
    var email = UserDefaults.standard.string(forKey: AuthManager.savedEmailKey) ?? ""
    var password = ""
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
}
