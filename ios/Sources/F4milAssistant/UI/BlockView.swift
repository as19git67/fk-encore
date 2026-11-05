import SwiftUI
import UIKit

/// A result block beside an answer: the server's title, then one generic
/// row per entry, drawn from `display` and nothing else
/// (documentation/plans/assistent-ios.md, "The server says how a row reads").
struct BlockView: View {
    let block: ResultBlock
    let opener: RowOpener

    /// Rows beyond this fold behind "Alle anzeigen".
    static let fold = 8
    @State private var expanded = false

    private var shown: [ResultRow] {
        expanded ? block.rows : Array(block.rows.prefix(Self.fold))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(block.heading)
                    .font(.subheadline.weight(.semibold))
                if let total = block.total, total > block.rows.count {
                    Text("\(block.rows.count) von \(total)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let route = block.route {
                    Button("Liste", systemImage: "arrow.up.right.square") {
                        opener.open(route: route)
                    }
                    .font(.caption)
                    .labelStyle(.titleAndIcon)
                    .accessibilityLabel("In der Liste öffnen")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            if let subtitle = block.subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }
            Divider()
            if block.rows.isEmpty {
                Text("Keine Einträge")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(12)
            }
            ForEach(Array(shown.enumerated()), id: \.offset) { index, row in
                ResultRowView(row: row, kind: block.kind, opener: opener)
                if index < shown.count - 1 { Divider().padding(.leading, 12) }
            }
            if block.rows.count > Self.fold, !expanded {
                Divider()
                Button("Alle \(block.rows.count) anzeigen") { expanded = true }
                    .font(.footnote)
                    .padding(12)
            }
        }
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// One row: date, thumbnail, title and subtitle, the figure at the right
/// edge coloured by its sign. A tap opens what the row stands for.
struct ResultRowView: View {
    let row: ResultRow
    let kind: String
    let opener: RowOpener

    var body: some View {
        let display = row.display ?? RowDisplay(title: Self.fallbackTitle(row))
        Button {
            if let route = display.route { opener.open(route: route) }
        } label: {
            HStack(alignment: .center, spacing: 10) {
                if let thumbnail = display.thumbnail {
                    ThumbnailImage(thumbnail: thumbnail)
                        .frame(width: 44, height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        if let date = display.date {
                            Text(date)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        Text(display.title.isEmpty ? "—" : display.title)
                            .lineLimit(2)
                    }
                    if let subtitle = display.subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: 8)
                if let value = display.value {
                    Text(value)
                        .monospacedDigit()
                        .foregroundStyle(Self.color(for: display.tone))
                        .lineLimit(1)
                }
                if display.route != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(display.route == nil)
    }

    static func color(for tone: String?) -> Color {
        switch tone {
        case "in": return .green
        case "out": return .red
        default: return .primary
        }
    }

    /// A row stored before the server wrote displays: the first text it has.
    static func fallbackTitle(_ row: ResultRow) -> String {
        for key in ["name", "title", "description", "summary", "label"] {
            if let value = row.fields[key]?.stringValue, !value.isEmpty { return value }
        }
        return row.id.map { "#\($0)" } ?? ""
    }
}

/// The small image for a photo or a document row, loaded through the API
/// client (the files need the bearer token) and kept for the screen's life.
struct ThumbnailImage: View {
    let thumbnail: DisplayThumbnail
    @Environment(ThumbnailStore.self) private var store
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color(.secondarySystemFill)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: thumbnail.kind == "document" ? "doc.text" : "photo")
                    .foregroundStyle(.tertiary)
            }
        }
        .task(id: thumbnail) {
            image = await store.image(for: thumbnail)
        }
    }
}

/// Thumbnails already loaded, keyed by what they show. Bounded: a
/// conversation holds a few hundred rows at most.
@MainActor
@Observable
final class ThumbnailStore {
    let api: AssistantAPI
    private var images: [DisplayThumbnail: UIImage] = [:]
    private var order: [DisplayThumbnail] = []
    static let width = 160
    static let limit = 300

    init(api: AssistantAPI) {
        self.api = api
    }

    func image(for thumbnail: DisplayThumbnail) async -> UIImage? {
        if let hit = images[thumbnail] { return hit }
        guard let data = try? await api.thumbnail(thumbnail, width: Self.width),
              let image = UIImage(data: data) else { return nil }
        images[thumbnail] = image
        order.append(thumbnail)
        if order.count > Self.limit {
            images.removeValue(forKey: order.removeFirst())
        }
        return image
    }
}
