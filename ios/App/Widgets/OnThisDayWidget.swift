import FKPhotosLib
import SwiftUI
import WidgetKit

/// "An diesem Tag" (#764) — whatever `WidgetSnapshotStore` last wrote,
/// which is only ever set while an undismissed `on_this_day` recap
/// exists (`WidgetSnapshotStore.updateFromRecaps`). A day without one
/// says so plainly rather than repeating an old memory.
struct OnThisDayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetKinds.onThisDay, provider: OnThisDayProvider()) { entry in
            OnThisDayWidgetView(entry: entry)
        }
        .configurationDisplayName("An diesem Tag")
        .description("Die neueste Erinnerung, die der Rückblick für heute gefunden hat.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct OnThisDayEntry: TimelineEntry {
    let date: Date
    let snapshot: OnThisDaySnapshot?
    /// The recap's cover, if the app has stored one for this widget.
    let image: UIImage?

    init(date: Date, snapshot: OnThisDaySnapshot?) {
        self.date = date
        self.snapshot = snapshot
        image = WidgetImageStore.shared.image(named: snapshot?.imageFile)
    }
}

struct OnThisDayProvider: TimelineProvider {
    func placeholder(in context: Context) -> OnThisDayEntry {
        OnThisDayEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (OnThisDayEntry) -> Void) {
        completion(OnThisDayEntry(date: Date(), snapshot: WidgetSnapshotStore.loadOnThisDay()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OnThisDayEntry>) -> Void) {
        let entry = OnThisDayEntry(date: Date(), snapshot: WidgetSnapshotStore.loadOnThisDay())
        // A fallback only: `WidgetSnapshotStore.updateFromRecaps` reloads
        // this widget the moment the app itself learns of a change, so
        // this policy only matters if the app has not been opened in a
        // while.
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(6 * 3_600))))
    }
}

struct OnThisDayWidgetView: View {
    let entry: OnThisDayEntry

    var body: some View {
        let hasImage = entry.image != nil
        WidgetPhotoCard(caption: "An diesem Tag", systemImage: "calendar", image: entry.image) {
            if let snapshot = entry.snapshot {
                Text(snapshot.title).font(.headline).lineLimit(2).widgetTextShadow(hasImage)
                if let subtitle = snapshot.subtitle {
                    Text(subtitle).font(.caption).lineLimit(1)
                        .foregroundStyle(hasImage ? AnyShapeStyle(.white.opacity(0.85)) : AnyShapeStyle(.secondary))
                        .widgetTextShadow(hasImage)
                }
            } else {
                Text("Heute noch keine Erinnerung").font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .widgetURL(entry.snapshot.map { AppDeepLink.url(for: .recap(id: $0.recapId)) } ?? AppDeepLink.url(for: .recaps))
    }
}
