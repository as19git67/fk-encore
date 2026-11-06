import SwiftUI

/// A write action the assistant proposed (#1529; stage 4 of
/// assistent-ios.md), as `ProposalCard.vue` shows it on the web. Nothing
/// has happened yet: "Ausführen" runs it as the user, "Verwerfen" drops it.
/// Afterwards the card says what became of it and opens the result — the
/// screen the app has for it, else the PDF with the share sheet.
///
/// A letter shows what will go out; its text is edited on the web (the card
/// says so while a gap is left, and "Ausführen" waits). A collage shows its
/// photos and caption; a text document its text.
struct ProposalCardView: View {
    let proposal: Proposal
    let store: ConversationStore
    let opener: RowOpener
    /// The conversation's id, for "Im Web bearbeiten" on a letter with gaps.
    let conversationId: Int?

    @State private var current: Proposal
    @State private var busy: Action?
    @State private var requestError: String?

    enum Action { case execute, discard }

    init(proposal: Proposal, store: ConversationStore, opener: RowOpener, conversationId: Int?) {
        self.proposal = proposal
        self.store = store
        self.opener = opener
        self.conversationId = conversationId
        _current = State(initialValue: proposal)
    }

    private var gaps: [String] { current.letterGaps }
    private var error: String? { requestError ?? current.error }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                // Once it ran, the result says what became of it; the proposal's own line may name gaps that are filled by now.
                if !(current.isExecuted && current.result_summary != nil) {
                    Text(current.summary)
                        .strikethrough(current.isDiscarded)
                        .foregroundStyle(current.isDiscarded ? .secondary : .primary)
                }
                if let letter = current.letter, current.isPending {
                    LetterPreview(letter: letter, gaps: gaps)
                }
                if let document = current.text_document, current.isPending {
                    TextDocumentPreviewView(document: document)
                }
                if let continuation = current.continuation, current.isPending {
                    Label("Nach dem Ausführen mache ich weiter: \(continuation)", systemImage: "arrow.right")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if current.isExecuted, let result = current.result_summary {
                    Label(result, systemImage: "checkmark")
                        .font(.footnote)
                        .foregroundStyle(.green)
                }
                if let collage = current.collage, !current.isDiscarded {
                    CollagePreviewView(collage: collage)
                }
                if current.isExecuted {
                    resultActions
                }
                if let error, !current.isExecuted || requestError != nil {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(12)
            if current.isPending {
                Divider()
                footer
            }
        }
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(current.isPending ? Color.accentColor : Color.clear, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Vorschlag")
        // The server's copy replaces what the card holds, as on the web.
        .onChange(of: proposal) { _, next in current = next }
    }

    private var header: some View {
        HStack {
            Label("Vorschlag", systemImage: "bolt")
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text(current.statusLabel)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(statusColor.opacity(0.15), in: Capsule())
                .foregroundStyle(statusColor)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var statusColor: Color {
        switch current.status {
        case "pending": return .accentColor
        case "executing": return .orange
        case "executed": return .green
        default: return .secondary
        }
    }

    /// One row, one look: open what the card created, show its PDF, draft a mail.
    @ViewBuilder
    private var resultActions: some View {
        let mail = mailtoURL
        if current.result_route != nil || current.result_download != nil || mail != nil {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { resultButtons(mail: mail) }
                VStack(alignment: .leading, spacing: 8) { resultButtons(mail: mail) }
            }
        }
    }

    @ViewBuilder
    private func resultButtons(mail: URL?) -> some View {
        if let route = current.result_route {
            Button("Ansehen", systemImage: "arrow.right") { opener.open(route: route) }
                .buttonStyle(.bordered)
        }
        if let path = current.result_download {
            Button("PDF ansehen", systemImage: "doc.richtext") {
                opener.openDownload(path: path, title: current.letter?.subject ?? "PDF")
            }
            .buttonStyle(.bordered)
        }
        if let mail {
            Link(destination: mail) {
                Label("Als E-Mail-Entwurf", systemImage: "envelope")
            }
            .buttonStyle(.bordered)
        }
    }

    /// The confirmed letter as a mail draft; the PDF has to be attached by hand.
    private var mailtoURL: URL? {
        guard current.isExecuted, let letter = current.letter else { return nil }
        var components = URLComponents()
        components.scheme = "mailto"
        components.path = ""
        components.queryItems = [
            URLQueryItem(name: "subject", value: letter.subject),
            URLQueryItem(name: "body", value: letter.body),
        ]
        return components.url
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !gaps.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Label(
                        gaps.count == 1
                            ? "Erst die Lücke ausfüllen, dann geht „Ausführen“. Der Brief wird auf der Web-Seite bearbeitet."
                            : "Erst die \(gaps.count) Lücken ausfüllen, dann geht „Ausführen“. Der Brief wird auf der Web-Seite bearbeitet.",
                        systemImage: "info.circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    if let conversationId {
                        Spacer(minLength: 0)
                        Button("Im Web") { opener.open(route: "/assistent?c=\(conversationId)") }
                            .font(.footnote)
                            .accessibilityLabel("Brief auf der Web-Seite bearbeiten")
                    }
                }
            }
            HStack {
                Spacer()
                Button("Verwerfen") { decide(.discard) }
                    .buttonStyle(.bordered)
                    .disabled(busy != nil)
                Button(error == nil ? "Ausführen" : "Erneut ausführen", systemImage: "play") { decide(.execute) }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy != nil || !gaps.isEmpty)
            }
            .overlay(alignment: .leading) {
                if busy != nil { ProgressView().controlSize(.small) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func decide(_ action: Action) {
        guard busy == nil else { return }
        busy = action
        requestError = nil
        Task { @MainActor in
            defer { busy = nil }
            do {
                switch action {
                case .execute: current = try await store.execute(current)
                case .discard: current = try await store.discard(current)
                }
            } catch {
                requestError = error.localizedDescription
            }
        }
    }
}

/// The letter as it will go out: sender, recipient, subject and text; a gap
/// (`[[…]]`) is highlighted so the reader sees what the web has to fill in.
private struct LetterPreview: View {
    let letter: LetterDraft
    let gaps: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            field("Von", letter.sender)
            field("An", letter.recipient)
            field("Betreff", letter.subject)
            Divider()
            Text(Self.highlighted(letter.body))
                .font(.footnote)
                .textSelection(.enabled)
            if !letter.attachments.isEmpty {
                Label(
                    letter.attachments.count == 1 ? "1 Anlage: \(letter.attachments[0].title)" : "\(letter.attachments.count) Anlagen",
                    systemImage: "paperclip"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let photos = letter.photos, !photos.isEmpty {
                Label(photos.count == 1 ? "1 Foto als Seite hinter dem Brief" : "\(photos.count) Fotos als Seiten hinter dem Brief", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel("Brief: \(letter.subject)")
    }

    private func field(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
            Text(Self.highlighted(value))
        }
        .font(.footnote)
    }

    /// Gaps in orange, the rest as written.
    static func highlighted(_ text: String) -> AttributedString {
        var out = AttributedString(text)
        var search = text.startIndex
        while let open = text.range(of: "[[", range: search..<text.endIndex),
              let close = text.range(of: "]]", range: open.upperBound..<text.endIndex) {
            if let lower = AttributedString.Index(open.lowerBound, within: out),
               let upper = AttributedString.Index(close.upperBound, within: out) {
                out[lower..<upper].foregroundColor = .orange
                out[lower..<upper].font = .footnote.weight(.semibold)
            }
            search = close.upperBound
        }
        return out
    }
}

/// The text a proposed document would get, readable before "Ausführen".
private struct TextDocumentPreviewView: View {
    let document: TextDocumentPreview

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(document.title).font(.footnote.weight(.semibold))
            ScrollView {
                MarkdownText(document.markdown)
                    .font(.footnote)
            }
            .frame(maxHeight: 240)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel("Text von „\(document.title)“")
    }
}

/// The collage's photos in cell order with the caption under them; once
/// rendered, the photo it became. The web lets the user change layout and
/// caption on the card; the phone shows them.
private struct CollagePreviewView: View {
    let collage: CollagePreview

    private let columns = [GridItem(.adaptive(minimum: 64), spacing: 4)]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let result = collage.result {
                ThumbnailImage(thumbnail: result.thumbnail)
                    .frame(maxWidth: .infinity)
                    .frame(height: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("Fertige Collage")
            } else {
                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(collage.photos, id: \.id) { photo in
                        ThumbnailImage(thumbnail: photo.thumbnail)
                            .frame(height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }
                .accessibilityLabel("\(collage.photos.count) Fotos, Layout \(collage.layout)")
            }
            if !collage.text.isEmpty {
                Text("„\(collage.text)“")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let album = collage.album_name {
                Label("Im Album „\(album)“", systemImage: "rectangle.stack")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
