import Foundation
import Observation

/// Live status of the currently running sync / upload pipeline.
///
/// The user-facing settings view subscribes to this so the "Jetzt
/// synchronisieren" affordance can describe what the app is actually doing —
/// scanning the library, hashing assets, checking the server, uploading. The
/// previous UI showed only a spinner, leaving the user staring at it for
/// minutes during the first sync of a large library.
@Observable @MainActor
final class SyncProgress {
    static let shared = SyncProgress()

    enum Step: Equatable {
        case idle
        case waitingForNetwork
        case drainingQueue(remaining: Int)
        case scanningLibrary
        case hashingBatch(done: Int, total: Int)
        case checkingServer(batchSize: Int)
        case uploadingBatch(done: Int, total: Int)
        case finishing
    }

    private(set) var step: Step = .idle

    /// Total photo count discovered for the current run. -1 means "unknown".
    private(set) var totalAssets: Int = -1

    /// Human-readable label rendered next to the sync button.
    var label: String {
        switch step {
        case .idle:                                   return ""
        case .waitingForNetwork:                      return "Warte auf Netzwerk"
        case .drainingQueue(let n) where n > 0:       return "Warteschlange wird abgearbeitet (\(n))"
        case .drainingQueue:                          return "Warteschlange leeren"
        case .scanningLibrary:                        return "Mediathek wird durchsucht"
        case .hashingBatch(let d, let t):             return "Fotos analysieren (\(d) / \(t))"
        case .checkingServer(let n):                  return "Server-Abgleich (\(n) Fotos)"
        case .uploadingBatch(let d, let t):           return "Hochladen (\(d) / \(t))"
        case .finishing:                              return "Abschluss"
        }
    }

    /// True while *any* sync activity is running. The settings view disables the
    /// manual trigger button while this is set so the user can't kick off a
    /// second concurrent run.
    var isActive: Bool {
        step != .idle
    }

    func update(_ newStep: Step) {
        step = newStep
    }

    func reset() {
        step = .idle
        totalAssets = -1
    }

    func setTotalAssets(_ count: Int) {
        totalAssets = count
    }
}
