import SwiftUI

/// A transient, non-blocking status message shown as an overlay banner.
///
/// Unlike an `alert`, a toast does not steal focus or require a tap to dismiss —
/// it slides in, lingers briefly and slides out on its own. Used for lightweight
/// action feedback (e.g. "saved to library") where a modal alert would be
/// disproportionately intrusive.
struct ToastMessage: Equatable {
    enum Style: Equatable {
        case success
        case error
        case info
    }

    let text: String
    var style: Style = .info

    static func success(_ text: String) -> ToastMessage { ToastMessage(text: text, style: .success) }
    static func error(_ text: String) -> ToastMessage { ToastMessage(text: text, style: .error) }
    static func info(_ text: String) -> ToastMessage { ToastMessage(text: text, style: .info) }
}

extension View {
    /// Presents a toast banner over this view whenever `message` is non-nil. The
    /// toast auto-dismisses after `duration`, can be tapped to dismiss early, and
    /// resets its timer if a new message replaces the current one. Binding is set
    /// back to nil on dismissal so the caller's state stays in sync.
    func toast(_ message: Binding<ToastMessage?>, duration: TimeInterval = 2.5) -> some View {
        modifier(ToastModifier(message: message, duration: duration))
    }
}

private struct ToastModifier: ViewModifier {
    @Binding var message: ToastMessage?
    let duration: TimeInterval
    @State private var dismissTask: Task<Void, Never>?

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let message {
                    ToastBanner(message: message)
                        .padding(.horizontal, 24)
                        .padding(.bottom, 24)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .onTapGesture { dismiss() }
                }
            }
            .animation(.spring(duration: 0.35), value: message)
            .onChange(of: message) { _, newValue in
                dismissTask?.cancel()
                guard newValue != nil else { return }
                dismissTask = Task {
                    try? await Task.sleep(for: .seconds(duration))
                    if !Task.isCancelled {
                        message = nil
                    }
                }
            }
    }

    private func dismiss() {
        dismissTask?.cancel()
        message = nil
    }
}

private struct ToastBanner: View {
    let message: ToastMessage

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .foregroundStyle(iconColor)
            Text(message.text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08))
        )
        .shadow(color: .black.opacity(0.15), radius: 8, y: 4)
        .accessibilityElement(children: .combine)
    }

    private var iconName: String {
        switch message.style {
        case .success: return "checkmark.circle.fill"
        case .error:   return "exclamationmark.triangle.fill"
        case .info:    return "info.circle.fill"
        }
    }

    private var iconColor: Color {
        switch message.style {
        case .success: return .green
        case .error:   return .red
        case .info:    return .accentColor
        }
    }
}
