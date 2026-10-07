import SwiftUI
import UIKit

// MARK: - Drag-to-select support

struct PhotoFramePreference: PreferenceKey {
    static var defaultValue: [Int: CGRect] = [:]
    static func reduce(value: inout [Int: CGRect], nextValue: () -> [Int: CGRect]) {
        value.merge(nextValue()) { $1 }
    }
}

extension View {
    func reportPhotoFrame(id: Int, space: String) -> some View {
        background(GeometryReader { geo in
            Color.clear.preference(key: PhotoFramePreference.self,
                                   value: [id: geo.frame(in: .named(space))])
        })
    }

    /// Paint a selection by swiping across the grid, as in Photos.
    ///
    /// `startsSelecting` is asked once, with the point a swipe starts at:
    /// true to select along the way, false to deselect — Photos deselects
    /// when the swipe starts on a photo that is already selected
    /// (`DragToSelect.strokeSelects`). `onPoint` then gets every finger
    /// position in `space`, with that decision, until the finger lifts.
    func dragToSelect(
        isActive: Bool,
        in space: String,
        startsSelecting: @escaping (CGPoint) -> Bool,
        onPoint: @escaping (CGPoint, Bool) -> Void
    ) -> some View {
        gesture(DragToSelectRecognizer(
            isActive: isActive,
            space: space,
            startsSelecting: startsSelecting,
            onPoint: onPoint
        ))
    }
}

/// The geometry behind swipe-to-select, kept free of UIKit so it can be tested.
///
/// Apple documents no API for the one-finger swipe-to-select Photos uses
/// (UIKit's own multiple-selection interaction is a *two*-finger pan on a
/// `UICollectionView`, and these grids are SwiftUI). The behaviour is
/// rebuilt here from what Photos does:
///
/// - a swipe that starts **sideways** selects; one that starts up or down
///   scrolls, so the grid stays scrollable in selection mode;
/// - once selecting, the finger may go any way, the grid holds still, and
///   the back-swipe of the navigation stack waits for the gesture to fail;
/// - near the top or bottom edge the grid scrolls by itself, faster the
///   closer the finger gets, and the selection follows;
/// - a swipe that starts on a selected photo deselects everything it
///   crosses instead, so a slip can be undone the way it was made.
enum DragToSelect {
    /// The item whose frame contains `point`, if any.
    static func item<ID: Hashable>(at point: CGPoint, in frames: [ID: CGRect]) -> ID? {
        frames.first { $0.value.contains(point) }?.key
    }

    /// Whether a swipe starting at `point` selects (true) or deselects
    /// (false): it deselects only when it starts on a photo that is already
    /// selected. Starting between photos selects.
    static func strokeSelects<ID: Hashable>(
        startingAt point: CGPoint, frames: [ID: CGRect], selected: Set<ID>
    ) -> Bool {
        guard let start = item(at: point, in: frames) else { return true }
        return !selected.contains(start)
    }

    /// Select or deselect every item under `point`. One direction per swipe
    /// on purpose: a finger wobbling back over a photo it already painted
    /// cannot flip it back.
    static func paint<ID: Hashable>(
        _ selected: inout Set<ID>, at point: CGPoint, frames: [ID: CGRect], selecting: Bool
    ) {
        for (id, frame) in frames where frame.contains(point) {
            if selecting {
                selected.insert(id)
            } else {
                selected.remove(id)
            }
        }
    }

    /// How far into the visible area, from either edge, autoscroll begins.
    static let autoscrollEdge: CGFloat = 80
    /// Points per second at the very edge.
    static let maxAutoscrollSpeed: CGFloat = 900

    /// Whether a pan with this velocity starts a selection rather than a
    /// scroll: clearly more sideways than up or down.
    static func startsSelection(velocity: CGPoint) -> Bool {
        let dx = abs(velocity.x)
        let dy = abs(velocity.y)
        return dx > 0 && dx > dy
    }

    /// Autoscroll speed for a finger `fingerY` points below the top of a
    /// visible area `visibleHeight` tall: negative scrolls up, positive down,
    /// zero away from the edges. Ramps linearly from nothing at the edge band
    /// to `maxAutoscrollSpeed` at the edge itself (or past it).
    static func autoscrollSpeed(fingerY: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        guard visibleHeight > 0 else { return 0 }
        let edge = min(autoscrollEdge, visibleHeight / 3)
        guard edge > 0 else { return 0 }
        if fingerY < edge {
            let depth = min(1, (edge - fingerY) / edge)
            return -maxAutoscrollSpeed * depth
        }
        let bottom = visibleHeight - edge
        if fingerY > bottom {
            let depth = min(1, (fingerY - bottom) / edge)
            return maxAutoscrollSpeed * depth
        }
        return 0
    }

    /// A content offset moved by `delta`, kept inside the scrollable range.
    static func clampedOffset(
        current: CGFloat, delta: CGFloat, minOffset: CGFloat, maxOffset: CGFloat
    ) -> CGFloat {
        min(max(current + delta, minOffset), max(minOffset, maxOffset))
    }
}

/// Swipe-to-select as a UIKit pan recognizer — see `DragToSelect` for the
/// rules.
///
/// A SwiftUI drag gesture kept the grid's scroll view from panning at all
/// (#1209), and the hold-then-drag recognizer that replaced it lost to the
/// scroll view and the back-swipe as soon as the finger moved. A pan
/// recognizer can be told the two things that matter: begin only on a
/// sideways start (`gestureRecognizerShouldBegin`), and make the scroll
/// view's pan and the navigation pop wait for it to fail
/// (`shouldBeRequiredToFailBy`) — so whichever starts, the other stays out.
struct DragToSelectRecognizer: UIGestureRecognizerRepresentable {
    let isActive: Bool
    let space: String
    let startsSelecting: (CGPoint) -> Bool
    let onPoint: (CGPoint, Bool) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let recognizer = UIPanGestureRecognizer()
        recognizer.maximumNumberOfTouches = 1
        recognizer.delegate = context.coordinator
        recognizer.isEnabled = isActive
        context.coordinator.onPoint = onPoint
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        recognizer.isEnabled = isActive
        context.coordinator.onPoint = onPoint
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        switch recognizer.state {
        case .began:
            let point = context.converter.location(in: .named(space))
            context.coordinator.selecting = startsSelecting(point)
            context.coordinator.track(point: point, recognizer: recognizer)
        case .changed:
            context.coordinator.track(
                point: context.converter.location(in: .named(space)),
                recognizer: recognizer
            )
        default:
            context.coordinator.stop()
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onPoint: ((CGPoint, Bool) -> Void)?
        /// What this swipe does, decided where it started.
        var selecting = true
        /// The finger in the grid's coordinate space, moved along with the
        /// content while autoscrolling so the selection keeps up.
        private var lastPoint: CGPoint?
        private weak var scrollView: UIScrollView?
        private var displayLink: CADisplayLink?
        private var speed: CGFloat = 0

        // MARK: Deciding who wins

        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return true }
            return DragToSelect.startsSelection(velocity: pan.velocity(in: pan.view))
        }

        /// The scroll view's pan and the navigation back-swipe wait for this
        /// recognizer to fail. It fails at once on an up-or-down start, so
        /// scrolling is not held up; on a sideways start it wins, and neither
        /// the grid nor the page moves under the finger.
        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldBeRequiredToFailBy other: UIGestureRecognizer
        ) -> Bool {
            if other.view is UIScrollView { return true }
            if other is UIScreenEdgePanGestureRecognizer { return true }
            guard let navigation = navigationController(of: recognizer.view) else { return false }
            if other === navigation.interactivePopGestureRecognizer { return true }
            if #available(iOS 26.0, *), other === navigation.interactiveContentPopGestureRecognizer {
                return true
            }
            return false
        }

        // MARK: Tracking and autoscroll

        func track(point: CGPoint, recognizer: UIPanGestureRecognizer) {
            lastPoint = point
            onPoint?(point, selecting)
            if scrollView == nil {
                scrollView = enclosingScrollView(for: recognizer)
            }
            guard let scrollView else { return }
            let inset = scrollView.adjustedContentInset
            let fingerY = recognizer.location(in: scrollView).y - scrollView.contentOffset.y - inset.top
            let visibleHeight = scrollView.bounds.height - inset.top - inset.bottom
            speed = DragToSelect.autoscrollSpeed(fingerY: fingerY, visibleHeight: visibleHeight)
            if speed == 0 {
                stopAutoscroll()
            } else if displayLink == nil {
                let link = CADisplayLink(target: self, selector: #selector(step(_:)))
                link.add(to: .main, forMode: .common)
                displayLink = link
            }
        }

        func stop() {
            stopAutoscroll()
            lastPoint = nil
            scrollView = nil
        }

        private func stopAutoscroll() {
            displayLink?.invalidate()
            displayLink = nil
            speed = 0
        }

        @objc private func step(_ link: CADisplayLink) {
            guard let scrollView, let point = lastPoint, speed != 0 else { return }
            let elapsed = CGFloat(link.targetTimestamp - link.timestamp)
            let inset = scrollView.adjustedContentInset
            let current = scrollView.contentOffset.y
            let next = DragToSelect.clampedOffset(
                current: current,
                delta: speed * elapsed,
                minOffset: -inset.top,
                maxOffset: scrollView.contentSize.height - scrollView.bounds.height + inset.bottom
            )
            let delta = next - current
            guard delta != 0 else { return }
            scrollView.contentOffset.y = next
            // The content moved under a still finger: the finger now points
            // `delta` further along the grid.
            let moved = CGPoint(x: point.x, y: point.y + delta)
            lastPoint = moved
            onPoint?(moved, selecting)
        }

        // MARK: Finding the views

        /// The grid's scroll view: the nearest one around the view under the
        /// finger — SwiftUI may host the recognizer above the scroll view, so
        /// its own ancestors are only the fallback.
        private func enclosingScrollView(for recognizer: UIGestureRecognizer) -> UIScrollView? {
            if let view = recognizer.view,
               let found = firstScrollView(from: view.hitTest(recognizer.location(in: view), with: nil)) {
                return found
            }
            return firstScrollView(from: recognizer.view)
        }

        private func firstScrollView(from view: UIView?) -> UIScrollView? {
            var current = view
            while let candidate = current {
                if let scroll = candidate as? UIScrollView { return scroll }
                current = candidate.superview
            }
            return nil
        }

        private func navigationController(of view: UIView?) -> UINavigationController? {
            var responder: UIResponder? = view
            while let current = responder {
                if let controller = current as? UIViewController {
                    return controller.navigationController
                        ?? (controller as? UINavigationController)
                }
                responder = current.next
            }
            return nil
        }
    }
}

// MARK: - Selection state

/// Multi-select state for a photo grid: which photos are picked, and whether
/// the grid is in selection mode at all.
///
/// A value type so it drops straight into `@State` (same as `AlbumViewFilter`)
/// and so the transition rules — long-press enters selection, deselecting the
/// last photo leaves it again — are unit-testable without a view.
struct PhotoSelection: Equatable, Sendable {
    private(set) var isSelecting = false
    private(set) var ids: Set<Int> = []

    var count: Int { ids.count }
    var isEmpty: Bool { ids.isEmpty }

    func contains(_ id: Int) -> Bool { ids.contains(id) }

    /// Enter selection mode with nothing picked yet — the toolbar entry point.
    mutating func enter() {
        isSelecting = true
        ids = []
    }

    /// Enter selection mode with one photo already picked — the long-press
    /// entry point, where tapping the photo that started it would otherwise
    /// select nothing.
    mutating func begin(with id: Int) {
        isSelecting = true
        ids = [id]
    }

    mutating func cancel() {
        isSelecting = false
        ids = []
    }

    /// Toggle one photo. Deselecting the last one leaves selection mode, so the
    /// grid never sits in an empty selection the user has to cancel by hand.
    mutating func toggle(_ id: Int) {
        if ids.contains(id) {
            ids.remove(id)
            if ids.isEmpty { isSelecting = false }
        } else {
            ids.insert(id)
        }
    }

    /// Drag-to-select: add every photo whose frame contains `point`.
    ///
    /// Additive on purpose — a drag across the grid extends the selection and
    /// never clears it, so a wobbling finger cannot undo what it just picked.
    mutating func paintItems(at point: CGPoint, frames: [Int: CGRect], selecting: Bool) {
        DragToSelect.paint(&ids, at: point, frames: frames, selecting: selecting)
    }

    /// Whether a swipe starting at `point` selects or, starting on a
    /// selected photo, deselects — see `DragToSelect.strokeSelects`.
    func strokeSelects(startingAt point: CGPoint, frames: [Int: CGRect]) -> Bool {
        DragToSelect.strokeSelects(startingAt: point, frames: frames, selected: ids)
    }

    mutating func selectItems(at point: CGPoint, frames: [Int: CGRect]) {
        for (id, frame) in frames where frame.contains(point) {
            ids.insert(id)
        }
    }

    /// Navigation title while selecting, e.g. "3 ausgewählt".
    var title: String { "\(count) ausgewählt" }
}

// MARK: - Selection order

/// The order photos were picked in, which a `Set` of ids forgets.
///
/// A collage fills its cells in this order, as on the web (whose selection is
/// an insertion-ordered `Set`): the first photo tapped goes into the first —
/// often the biggest — cell. Grids keep their `Set` for membership and fold
/// every change into an ordered list with `reconciled`.
enum SelectionOrder {
    /// `order` brought up to date with `ids`: photos no longer selected drop
    /// out, the ones that stay keep their place, and newly selected ones go
    /// on the end. Several arriving at once — a drag across the grid — are
    /// appended in grid order; an id the grid does not show comes last, by
    /// id, so the result never depends on hashing.
    static func reconciled(_ order: [Int], with ids: Set<Int>, gridOrder: [Int]) -> [Int] {
        var seen = Set<Int>()
        var result = order.filter { ids.contains($0) && seen.insert($0).inserted }
        result += gridOrder.filter { ids.contains($0) && seen.insert($0).inserted }
        result += ids.subtracting(seen).sorted()
        return result
    }

    /// The selected photos, in the order they were picked.
    static func photos(_ photos: [PhotoWithCuration], in order: [Int]) -> [PhotoWithCuration] {
        let byId = Dictionary(photos.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return order.compactMap { byId[$0] }
    }
}

// MARK: - Selection checkmark overlay

struct SelectionCheckmark: View {
    let isSelected: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(isSelected ? Color.accentColor : Color.black.opacity(0.3))
                .frame(width: 24, height: 24)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
            } else {
                Circle()
                    .strokeBorder(.white, lineWidth: 1.5)
                    .frame(width: 24, height: 24)
            }
        }
    }
}

// MARK: - Photo share manager

@Observable @MainActor
final class PhotoShareManager {
    var isLoading = false
    var images: [UIImage] = []
    var isPresented = false

    func share(filenames: [String]) async {
        isLoading = true
        images = []
        for filename in filenames {
            if let cached = await ImageCache.shared.image(forKey: "photo-\(filename)") {
                images.append(cached)
            } else if let data = try? await APIClient.shared.downloadData("/photos/file/\(filename)"),
                      let image = UIImage(data: data) {
                images.append(image)
            }
        }
        isLoading = false
        if !images.isEmpty {
            isPresented = true
        }
    }
}

// MARK: - iOS share sheet wrapper

struct ActivityView: UIViewControllerRepresentable {
    let images: [UIImage]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: images, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

/// The share sheet for one file on disk — a rendered collage, shared as the
/// JPEG it was encoded to rather than re-encoded from a `UIImage`.
struct FileActivityView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Add selected photos to server album

@Observable @MainActor
final class AddToAlbumManager {
    var isPresented = false
    var isAdding = false
    var resultMessage: String?
    private(set) var photoIds: [Int] = []

    func present(photoIds: Set<Int>) {
        self.photoIds = Array(photoIds)
        isPresented = true
    }

    func addToAlbum(_ albumId: Int) async {
        isAdding = true
        defer { isAdding = false }
        do {
            let _: BoolResponse = try await APIClient.shared.post(
                "/albums/photos/batch",
                body: BatchBody(albumIds: [albumId], photoIds: photoIds, action: "add")
            )
            resultMessage = "\(photoIds.count) Foto\(photoIds.count == 1 ? "" : "s") hinzugefügt"
        } catch {
            resultMessage = "Fehler: \(error.localizedDescription)"
        }
        isPresented = false
    }

    private struct BatchBody: Encodable {
        let albumIds: [Int]
        let photoIds: [Int]
        let action: String
    }
    private struct BoolResponse: Decodable { let success: Bool }
}

struct AddToAlbumPickerView: View {
    let manager: AddToAlbumManager
    @State private var albums: [Album] = []
    @State private var isLoading = true
    @State private var searchText = ""
    @Environment(\.dismiss) private var dismiss

    private var filteredAlbums: [Album] {
        let base = searchText.isEmpty
            ? albums
            : albums.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
        let pinned = AlbumPinPreferences.pinnedIds
        return base.sorted { a, b in
            let aPinned = pinned.contains(a.id)
            let bPinned = pinned.contains(b.id)
            if aPinned != bPinned { return aPinned }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                } else if albums.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Alben", systemImage: "rectangle.stack")
                    }
                } else {
                    ForEach(filteredAlbums) { album in
                        Button {
                            Task { await manager.addToAlbum(album.id) }
                        } label: {
                            HStack {
                                Text(album.name)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if AlbumPinPreferences.pinnedIds.contains(album.id) {
                                    Image(systemName: "pin.fill")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .disabled(manager.isAdding)
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Album suchen")
            .navigationTitle("\(manager.photoIds.count) Foto\(manager.photoIds.count == 1 ? "" : "s") hinzufügen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
            }
            .overlay {
                if manager.isAdding {
                    ZStack {
                        Color.black.opacity(0.3).ignoresSafeArea()
                        ProgressView("Hinzufügen…")
                            .padding()
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
            .task {
                do {
                    let response: ListAlbumsResponse = try await APIClient.shared.get("/albums")
                    albums = response.albums.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                } catch {}
                isLoading = false
            }
        }
    }
}

// MARK: - Album pin storage

enum AlbumPinPreferences {
    private static let key = "albums.pinnedIds"

    static var pinnedIds: Set<Int> {
        get {
            guard let data = UserDefaults.standard.data(forKey: key),
                  let ids = try? JSONDecoder().decode(Set<Int>.self, from: data) else { return [] }
            return ids
        }
        set {
            let data = try? JSONEncoder().encode(newValue)
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
