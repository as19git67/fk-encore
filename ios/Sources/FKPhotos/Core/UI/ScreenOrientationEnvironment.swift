import SwiftUI

// MARK: - Screen orientation as an environment value
//
// The grid, the fullscreen viewer and the slideshow all ask which way the
// screen is turned and must get the same answer, so none of them reads a
// `GeometryReader` of its own for it (.claude/plans/orientierungs-varianten.md).
// `MainTabView` provides the value once at the root; everything below reads
// `@Environment(\.screenOrientation)`.

private struct ScreenOrientationKey: EnvironmentKey {
    static let defaultValue: ScreenOrientation = .portrait
}

extension EnvironmentValues {
    /// How the screen is held right now. Portrait where nothing provides it —
    /// the common phone case.
    var screenOrientation: ScreenOrientation {
        get { self[ScreenOrientationKey.self] }
        set { self[ScreenOrientationKey.self] = newValue }
    }
}

private struct ScreenOrientationProvider: ViewModifier {
    func body(content: Content) -> some View {
        GeometryReader { geo in
            content
                .environment(\.screenOrientation, ScreenOrientation(size: geo.size))
                .frame(width: geo.size.width, height: geo.size.height)
        }
    }
}

extension View {
    /// Measure this view and hand its orientation down as
    /// `\.screenOrientation`. Belongs on the root, once.
    func providesScreenOrientation() -> some View {
        modifier(ScreenOrientationProvider())
    }
}

/// The small badge on a grid tile whose photo also exists in the other
/// orientation. Same corner idea as the web's format badge: tapping it opens
/// the viewer straight on the other side.
struct VariantBadge: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white)
                .padding(5)
                .background(.black.opacity(0.6), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
