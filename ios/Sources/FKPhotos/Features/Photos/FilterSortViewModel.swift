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
    }

    /// Reset everything immediately, apply, and close menu.
    func resetAll() {
        appliedFilter = .empty
        appliedSort   = .default
        draftFilter   = .empty
        draftSort     = .default
        isMenuPresented = false
        applyToken += 1
    }

    /// Sort a locally-loaded array according to the applied sort.
    func sorted(_ photos: [PhotoWithCuration]) -> [PhotoWithCuration] {
        guard !appliedSort.isDefault else { return photos }
        return photos.sorted(by: appliedSort.comparator)
    }
}
