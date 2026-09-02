import Foundation
import Observation

/// Which photos the signed-in user has edited — one fetch for the whole app.
///
/// `GET /photos/transforms/mine` exists for exactly this: a grid needs to know,
/// per tile, whether to load the original file or the recipe-rendered version,
/// and asking per tile would fan out one request per thumbnail. The web keeps
/// the same single set in `useTransformedPhotosIndex`.
///
/// The set is patched in place when this app saves, adopts or resets a recipe,
/// so an edited photo changes over immediately instead of after the next cold
/// launch. Each patch also bumps that photo's **revision**, which is what makes
/// the new rendering visible: the render route answers `immutable`, and
/// `ImageCache` is disk-backed, so without a changing key both would keep
/// handing back the pixels from before the edit.
///
/// The revisions are persisted, because the caches they guard are. An edit made
/// elsewhere — the web, another phone — is not seen by this counter; the photo
/// still flips from original to rendered when it gains its *first* recipe, but a
/// second edit made on another device can be served from this device's cache
/// until it is evicted.
@MainActor
@Observable
final class TransformedPhotosIndex {
    static let shared = TransformedPhotosIndex()

    /// Nil until the first load finishes. Distinguishing „not loaded" from
    /// „nobody has edited anything" matters: the first must not be cached as
    /// the second.
    private(set) var photoIds: Set<Int>?

    /// Whose recipes these are. Rendering is per user, so the set is dropped
    /// when the user changes.
    private(set) var userId: Int?

    private var revisions: [Int: Int]
    private var loadTask: Task<Void, Never>?

    private let defaults: UserDefaults
    private static let revisionsKey = "photo-recipe-revisions"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.dictionary(forKey: Self.revisionsKey) as? [String: Int] ?? [:]
        self.revisions = Dictionary(
            uniqueKeysWithValues: stored.compactMap { key, value in
                Int(key).map { ($0, value) }
            }
        )
    }

    // MARK: - Session

    /// Point the index at a user, loading their set the first time.
    ///
    /// Called with nil on logout, which drops the set — the next user's tiles
    /// must not be routed through the previous user's recipes.
    func configure(userId: Int?) {
        guard userId != self.userId else { return }
        loadTask?.cancel()
        loadTask = nil
        self.userId = userId
        photoIds = nil
        guard userId != nil else { return }
        Task { await load() }
    }

    /// Fetch the set once. Concurrent callers share the one request.
    func load() async {
        guard userId != nil else { return }
        if let loadTask {
            await loadTask.value
            return
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let response: MyTransformsResponse = try await APIClient.shared.get(
                    "/photos/transforms/mine"
                )
                self.photoIds = Set(response.photo_ids)
            } catch {
                // Treat a failure as „nobody has edited anything": every tile
                // falls back to the original, which is worse than ideal but
                // never wrong, and a retry costs one tap elsewhere.
                self.photoIds = []
            }
        }
        loadTask = task
        await task.value
        loadTask = nil
    }

    // MARK: - Reading

    func hasRecipe(_ photoId: Int?) -> Bool {
        guard let photoId else { return false }
        return photoIds?.contains(photoId) ?? false
    }

    func revision(of photoId: Int) -> Int {
        revisions[photoId] ?? 0
    }

    /// Where to fetch one photo from, recipe included.
    func request(
        photoId: Int?,
        filename: String,
        width: Int? = nil
    ) -> PhotoImageSource.Request {
        PhotoImageSource.request(
            photoId: photoId,
            filename: filename,
            userId: userId,
            hasRecipe: hasRecipe(photoId),
            revision: photoId.map(revision(of:)) ?? 0,
            width: width
        )
    }

    // MARK: - Writing

    /// Record that this app changed a photo's recipe.
    ///
    /// The revision bump is what actually makes the change visible, so it
    /// happens whether the recipe was added, altered or removed.
    func mark(photoId: Int, hasRecipe: Bool) {
        revisions[photoId] = revision(of: photoId) + 1
        persistRevisions()

        if photoIds == nil {
            // Not loaded yet — the server is about to be the source of truth
            // anyway, so just make sure the load happens.
            Task { await load() }
            return
        }
        if hasRecipe {
            photoIds?.insert(photoId)
        } else {
            photoIds?.remove(photoId)
        }
    }

    private func persistRevisions() {
        let stored = Dictionary(
            uniqueKeysWithValues: revisions.map { (String($0.key), $0.value) }
        )
        defaults.set(stored, forKey: Self.revisionsKey)
    }
}

/// `GET /photos/transforms/mine`.
struct MyTransformsResponse: Decodable, Sendable {
    let photo_ids: [Int]
}
