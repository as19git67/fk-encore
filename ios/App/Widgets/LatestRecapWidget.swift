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
        VStack(alignment: .leading, spacing: 6) {
            Label("Rückblick", systemImage: "sparkles")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let snapshot = entry.snapshot {
                Text(snapshot.title).font(.headline)
                if let subtitle = snapshot.subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text("Noch kein Rückblick").font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding()
        .widgetURL(entry.snapshot.map { AppDeepLink.url(for: .recap(id: $0.recapId)) } ?? AppDeepLink.url(for: .recaps))
        .containerBackground(for: .widget) { Color.clear }
    }
}
