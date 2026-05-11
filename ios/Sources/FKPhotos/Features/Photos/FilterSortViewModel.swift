import Foundation

/// Manages filter and sort state with draft/applied semantics.
/// The menu edits `draft*`; only apply() writes to `applied*`.
@Observable
final class FilterSortViewModel {
    // Applied state — what the grid uses to load data
    var appliedFilter = PhotoFilter()
    var appliedSort   = PhotoSortState()

    // Incremented on every apply/reset so views can use .task(id: applyToken)
    // for reliable reload triggering regardless of what changed.
    private(set) var applyToken = 0

    // Draft state — what the menu edits
    var draftFilter   = PhotoFilter()
    var draftSort     = PhotoSortState()

    var isMenuPresented = false

    private let persistenceKey: String?

    init(persistenceKey: String? = nil) {
        self.persistenceKey = persistenceKey
        if let key = persistenceKey {
            load(key: key)
        }
    }

    /// Total number of active criteria (filter + non-default sort).
    var activeCount: Int {
        appliedFilter.activeCount + (appliedSort.isDefault ? 0 : 1)
    }

    /// Open the menu and copy applied → draft.
    func openMenu() {
        draftFilter = appliedFilter
        draftSort   = appliedSort
        isMenuPresented = true
    }

    /// Apply draft → applied and close menu.
    func apply() {
        appliedFilter = draftFilter
        appliedSort   = draftSort
        isMenuPresented = false
        applyToken += 1
        persist()
    }

    /// Reset everything immediately, apply, and close menu.
    func resetAll() {
        appliedFilter = .empty
        appliedSort   = .default
        draftFilter   = .empty
        draftSort     = .default
        isMenuPresented = false
        applyToken += 1
        persist()
    }

    /// Sort a locally-loaded array according to the applied sort.
    func sorted(_ photos: [PhotoWithCuration]) -> [PhotoWithCuration] {
        guard !appliedSort.isDefault else { return photos }
        return photos.sorted(by: appliedSort.comparator)
    }

    // MARK: - Persistence

    private struct Snapshot: Codable {
        var filter: PhotoFilter
        var sort: PhotoSortState
    }

    private func persist() {
        guard let key = persistenceKey else { return }
        if let data = try? JSONEncoder().encode(Snapshot(filter: appliedFilter, sort: appliedSort)) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private func load(key: String) {
        guard let data = UserDefaults.standard.data(forKey: key),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
        appliedFilter = snapshot.filter
        appliedSort   = snapshot.sort
        draftFilter   = snapshot.filter
        draftSort     = snapshot.sort
    }
}
