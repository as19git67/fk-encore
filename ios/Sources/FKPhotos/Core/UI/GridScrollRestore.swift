import SwiftUI

/// Coming back to a photo grid where you left it.
///
/// Tap a photo in an album, swipe a few further in the viewer, go back —
/// and the grid was at the top again. Two separate things lost your
/// place, and only one of them is in this file:
///
///   - **The grid blanked itself while reloading.** Returning from a
///     push re-runs the screen's `.task`, and a body that reads
///     `if isLoading { ProgressView() }` swaps the whole grid for a
///     spinner for the length of that request. A scroll view with no
///     content has no offset to keep, so the grid came back at the top —
///     and a pull-to-refresh did the same thing. The fix for that is the
///     `&& photos.isEmpty` guard each of those screens now carries: a
///     reload that still has something to show leaves it on screen.
///   - **The viewer moved on.** Even with the grid intact, the photo you
///     come back from is rarely the one you tapped — you swiped twenty
///     further. That half is here.
///
/// Three screens had each grown their own copy of the second half, down
/// to the same magic number. This is that copy, once.
enum GridScroll {
    /// How long to wait before scrolling back.
    ///
    /// Long enough for the pop animation to finish: a `scrollTo` issued
    /// into a view that is still sliding in lands nowhere, and the grid
    /// then sits wherever it happened to be.
    static let settleDelay: Duration = .milliseconds(400)

    /// Which item to come back to, given where the viewer ended up.
    ///
    /// The index is clamped rather than trusted. Deleting a photo from
    /// the viewer shortens the list under it, so the index the viewer
    /// last reported can be one past the end — and an empty list has
    /// nothing to come back to at all.
    static func target<Item: Identifiable>(index: Int, in items: [Item]) -> Item.ID? {
        guard !items.isEmpty else { return nil }
        return items[min(max(0, index), items.count - 1)].id
    }
}

extension View {
    /// Scroll the grid to `target` whenever one is set, then clear it.
    ///
    /// Goes on the `ScrollView` inside a `ScrollViewReader`; the grid's
    /// items have to carry `.id(…)` for the proxy to find them.
    func scrollsBack<ID: Hashable>(
        to target: Binding<ID?>,
        in proxy: ScrollViewProxy
    ) -> some View {
        onChange(of: target.wrappedValue) { _, id in
            guard let id else { return }
            withAnimation { proxy.scrollTo(id, anchor: .center) }
            target.wrappedValue = nil
        }
    }

    /// Aim the grid at the photo the viewer ended on, once it closes.
    ///
    /// `lastSeen` is read when the viewer closes rather than passed in,
    /// because by then the list may be shorter than it was when it
    /// opened — somebody deleted a photo from inside it.
    func remembersGridPosition<Nav: Equatable, ID: Hashable>(
        whenClosing nav: Nav?,
        target: Binding<ID?>,
        lastSeen: @escaping () -> ID?
    ) -> some View {
        onChange(of: nav) { _, value in
            guard value == nil, let id = lastSeen() else { return }
            Task { @MainActor in
                try? await Task.sleep(for: GridScroll.settleDelay)
                target.wrappedValue = id
            }
        }
    }
}
