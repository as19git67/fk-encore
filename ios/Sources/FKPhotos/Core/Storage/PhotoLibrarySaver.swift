import Foundation
import Photos

/// Saves image bytes into the user's Photos library (camera roll).
///
/// Used by the fullscreen viewer's "save original" action (issue #762) to bring
/// a server photo back onto the device as a real library asset — deliberately
/// separate from the iOS share sheet, which only hands the bytes to another app.
enum PhotoLibrarySaver {
    enum SaveError: LocalizedError {
        case accessDenied
        case writeFailed(String)

        var errorDescription: String? {
            switch self {
            case .accessDenied:
                return "Kein Zugriff auf die Fotos-Mediathek. Bitte in den Einstellungen erlauben."
            case .writeFailed(let message):
                return message
            }
        }
    }

    /// Requests add-only authorization and writes `data` as a new photo asset,
    /// optionally stamping the original capture date and favourite flag so the
    /// saved copy matches the server's metadata.
    static func save(_ data: Data, creationDate: Date? = nil, isFavorite: Bool = false) async throws {
        let status = await requestAddOnlyAuthorization()
        guard status == .authorized || status == .limited else {
            throw SaveError.accessDenied
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHPhotoLibrary.shared().performChanges {
                let creation = PHAssetCreationRequest.forAsset()
                creation.addResource(with: .photo, data: data, options: nil)
                if let creationDate { creation.creationDate = creationDate }
                if isFavorite { creation.isFavorite = true }
            } completionHandler: { success, error in
                if success {
                    continuation.resume()
                } else {
                    continuation.resume(
                        throwing: SaveError.writeFailed(error?.localizedDescription ?? "Speichern fehlgeschlagen")
                    )
                }
            }
        }
    }

    private static func requestAddOnlyAuthorization() async -> PHAuthorizationStatus {
        await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                continuation.resume(returning: status)
            }
        }
    }
}
