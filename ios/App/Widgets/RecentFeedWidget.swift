import FKPhotosLib
import SwiftUI
import WidgetKit

/// "Feed" (#764): the newest activity the feed screen itself last
/// loaded. Never invented — no owner, no album, still says only what
/// is known (§15.3's rule applies here just as it does to a place with
/// no name).
struct RecentFeedWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetKinds.recentFeed, provider: RecentFeedProvider()) { entry in
            RecentFeedWidgetView(entry: entry)
        }
        .configurationDisplayName("Feed-Aktivität")
        .description("Die letzte Aktivität, die der Feed zuletzt geladen hat.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct RecentFeedEntry: TimelineEntry {
    let date: Date
    let snapshot: RecentFeedSnapshot?
}

struct RecentFeedProvider: TimelineProvider {
    func placeholder(in context: Context) -> RecentFeedEntry {
        RecentFeedEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (RecentFeedEntry) -> Void) {
        completion(RecentFeedEntry(date: Date(), snapshot: WidgetSnapshotStore.loadRecentFeed()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RecentFeedEntry>) -> Void) {
        let entry = RecentFeedEntry(date: Date(), snapshot: WidgetSnapshotStore.loadRecentFeed())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(6 * 3_600))))
    }
}

struct RecentFeedWidgetView: View {
    let entry: RecentFeedEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Feed", systemImage: "house")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let snapshot = entry.snapshot {
                Text(sentence(for: snapshot)).font(.headline)
                Text(relativeDate(snapshot.lastActivityAt)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Noch keine Aktivität").font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding()
        .widgetURL(AppDeepLink.url(for: .feed))
        .containerBackground(for: .widget) { Color.clear }
    }

    private func sentence(for snapshot: RecentFeedSnapshot) -> String {
        switch (snapshot.ownerName, snapshot.albumName) {
        case let (name?, album?): return "\(name) · \(album)"
        case let (name?, nil): return name
        case let (nil, album?): return album
        case (nil, nil): return "Neues Foto"
        }
    }

    private func relativeDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString)
                ?? ISO8601DateFormatter().date(from: isoString) else {
            return ""
        }
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .short
        return relative.localizedString(for: date, relativeTo: Date())
    }
}
