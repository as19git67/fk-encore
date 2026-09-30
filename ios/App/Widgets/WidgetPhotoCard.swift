import SwiftUI
import WidgetKit

/// The one look every widget here has: a caption line on top, one or
/// two lines of text below, and — when the app has stored a photo for
/// it (`WidgetImageStore`) — that photo filling the widget behind a
/// gradient that keeps the text readable. Without a photo it is the
/// plain card it was before.
struct WidgetPhotoCard<Content: View>: View {
    let caption: String
    let systemImage: String
    let image: UIImage?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(caption, systemImage: systemImage)
                .font(.caption)
                .foregroundStyle(image == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.white.opacity(0.85)))
            // On a photo the text sits at the bottom, where the gradient
            // is darkest; on the plain card it stays at the top as before.
            if image != nil { Spacer(minLength: 0) }
            content()
            if image == nil { Spacer(minLength: 0) }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(image == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.white))
        .containerBackground(for: .widget) {
            if let image {
                ZStack {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                    LinearGradient(
                        colors: [.black.opacity(0.55), .black.opacity(0.05), .black.opacity(0.65)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
            } else {
                Color.clear
            }
        }
    }
}

/// Text on a photo needs a shadow where the gradient is thin;
/// on the plain card it needs none.
struct WidgetTextShadow: ViewModifier {
    let hasImage: Bool

    func body(content: Content) -> some View {
        content.shadow(color: .black.opacity(hasImage ? 0.6 : 0), radius: 2, y: 1)
    }
}

extension View {
    func widgetTextShadow(_ hasImage: Bool) -> some View {
        modifier(WidgetTextShadow(hasImage: hasImage))
    }
}
