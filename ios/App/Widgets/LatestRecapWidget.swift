import FKPhotosLib
import SwiftUI
import WidgetKit

/// "Neuester Rückblick" (#764): whichever recap the recap list itself
/// would lead with — the newest undismissed one, or failing that the
/// newest of any kind. Same rule the App Intent "Rückblick zeigen"
/// (#766) uses, so the two answer the same question the same way.
struct LatestRecapWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetKinds.latestRecap, provider: LatestRecapProvider()) { entry in
            LatestRecapWidgetView(entry: entry)
        }
        .configurationDisplayName("Neuester Rückblick")
        .description("Öffnet den Rückblick, den die App zuletzt gezeigt hat.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct LatestRecapEntry: TimelineEntry {
    let date: Date
    let snapshot: LatestRecapSnapshot?
    /// The recap's cover, if the app has stored one for this widget.
    let image: UIImage?

    init(date: Date, snapshot: LatestRecapSnapshot?) {
        self.date = date
        self.snapshot = snapshot
        image = WidgetImageStore.shared.image(named: snapshot?.imageFile)
    }
}

struct LatestRecapProvider: TimelineProvider {
    func placeholder(in context: Context) -> LatestRecapEntry {
        LatestRecapEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (LatestRecapEntry) -> Void) {
        completion(LatestRecapEntry(date: Date(), snapshot: WidgetSnapshotStore.loadLatestRecap()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LatestRecapEntry>) -> Void) {
        let entry = LatestRecapEntry(date: Date(), snapshot: WidgetSnapshotStore.loadLatestRecap())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(6 * 3_600))))
    }
}

struct LatestRecapWidgetView: View {
    let entry: LatestRecapEntry

    var body: some View {
        let hasImage = entry.image != nil
        WidgetPhotoCard(caption: "Rückblick", systemImage: "sparkles", image: entry.image) {
            if let snapshot = entry.snapshot {
                Text(snapshot.title).font(.headline).lineLimit(2).widgetTextShadow(hasImage)
                if let subtitle = snapshot.subtitle {
                    Text(subtitle).font(.caption).lineLimit(1)
                        .foregroundStyle(hasImage ? AnyShapeStyle(.white.opacity(0.85)) : AnyShapeStyle(.secondary))
                        .widgetTextShadow(hasImage)
                }
            } else {
                Text("Noch kein Rückblick").font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .widgetURL(entry.snapshot.map { AppDeepLink.url(for: .recap(id: $0.recapId)) } ?? AppDeepLink.url(for: .recaps))
    }
}
