import AuthenticationServices
import Foundation

/// Manages Passkey (WebAuthn) authentication using ASAuthorization.
/// Phase 2 implementation — uses existing backend endpoints:
/// - POST /passkeys/register/options
/// - POST /passkeys/register/verify
/// - POST /passkeys/auth/options
/// - POST /passkeys/auth/verify
@Observable
final class PasskeyManager: NSObject, @unchecked Sendable {
    var isProcessing = false
    var errorMessage: String?

    private let relyingPartyIdentifier: String

    init(relyingPartyIdentifier: String = "localhost") {
        self.relyingPartyIdentifier = relyingPartyIdentifier
        super.init()
    }

    // MARK: - Registration

    /// Initiates passkey registration for the current user.
    @MainActor
    func register() async throws -> Bool {
        isProcessing = true
        defer { isProcessing = false }

        // Step 1: Get registration options from server
        struct Empty: Codable {}
        struct OptionsResponse: Codable {
            let challengeId: String
            let options: RegistrationOptions
        }
        struct RegistrationOptions: Codable {
            let challenge: String
            let rp: RelyingParty
            let user: UserEntity
        }
        struct RelyingParty: Codable {
            let name: String
            let id: String
        }
        struct UserEntity: Codable {
            let id: String
            let name: String
            let displayName: String
        }

        let response: OptionsResponse = try await APIClient.shared.post(
            "/passkeys/register/options",
            body: Empty()
        )

        // Phase 2: ASAuthorization flow will be implemented here
        // For now, store the challengeId for future use
        _ = response.challengeId

        return false // Not yet implemented
    }

    // MARK: - Authentication

    /// Initiates passkey authentication.
    @MainActor
    func authenticate() async throws -> LoginResponse? {
        isProcessing = true
        defer { isProcessing = false }

        // Phase 2: Will use ASAuthorizationPlatformPublicKeyCredentialProvider
        // to present the passkey selection UI
        return nil
    }
}
