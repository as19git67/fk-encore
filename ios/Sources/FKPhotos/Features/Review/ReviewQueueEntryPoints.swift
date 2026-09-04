import SwiftUI

/// The small pieces that advertise the group review: a badge for an icon and a
/// banner for the feed (#968, proposals 1 and 3).
///
/// Kept together and away from the screens that host them, because all three
/// entry points — toolbar, hub row, feed — say the same thing and should not
/// drift apart.

/// A count over an icon, drawn the way the system draws a tab badge.
///
/// `.badge()` only works on tab items and list rows, not on a toolbar button,
/// so this is the same idea by hand: a capsule meant to sit at the icon's
/// corner.
///
/// **It has to be positioned by the caller, not by an offset in here.** A
/// toolbar button under iOS 26's "Liquid Glass" is rendered inside a capsule
/// that clips to the *reported* size of its label — and `.overlay` paints
/// without changing that reported size, so an early version that pushed
/// itself outward with `.offset` got its corner clipped clean off, chopping
/// „99+" down to „9…". The fix is for the caller to reserve room with
/// `.padding` before overlaying this (padding *does* grow the reported
/// size), so the whole badge lands inside the bounds the glass capsule
/// clips to instead of bleeding past them.
struct ReviewCountBadge: View {
    let count: Int?

    var body: some View {
        if let text = ReviewQueueNotice.badgeText(count) {
            Text(text)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, text.count > 1 ? 4 : 5)
                .padding(.vertical, 1)
                .background(Color.red, in: Capsule())
                .accessibilityHidden(true)
        }
    }
}

/// „N Gruppen warten auf Review" at the top of the feed.
///
/// The feed is where people already look; a queue that only exists behind a
/// toolbar glyph is a queue nobody empties. Only drawn when something is
/// actually waiting, so the feed is not permanently a third shorter.
struct ReviewQueueBanner: View {
    let count: Int
    let onOpen: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "checklist")
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 36, height: 36)
                .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(ReviewQueueNotice.bannerTitle(count))
                    .font(.subheadline.weight(.semibold))
                Text("Ähnliche Fotos vergleichen und aussortieren")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 4)

            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Hinweis ausblenden")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground))
        .contentShape(Rectangle())
        .onTapGesture { onOpen() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ReviewQueueNotice.bannerTitle(count))
        .accessibilityAddTraits(.isButton)
    }
}
