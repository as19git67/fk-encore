import SwiftUI
import UniformTypeIdentifiers

/// The share extension's half of "einen Fund in den Vorrat" (§9.2).
///
/// Deliberately the smallest thing that works: read what was shared,
/// put it in the App Group, say so. Everything that needs judgement —
/// which trip, which leg, which of three cafés of that name, and
/// whether the pin is really where you meant — happens in the app,
/// where the screen for it lives and where the API client already is.
///
/// An extension runs under a tight memory limit and cannot reliably
/// open its host app, so the alternative would be building the whole
/// confirmation flow a second time in here. That is how two versions of
/// one feature start drifting apart.
struct TripShareCaptureView: View {
    let extensionContext: NSExtensionContext
    let itemProviders: [NSItemProvider]

    @State private var payload: TripSharePayload?
    @State private var isReading = true
    @State private var isDone = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isReading {
                    ProgressView("Wird gelesen…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if isDone {
                    done
                } else if let errorMessage {
                    ContentUnavailableView("Nichts zu übernehmen", systemImage: "link.badge.plus",
                                           description: Text(errorMessage))
                } else {
                    preview
                }
            }
            .navigationTitle("Für die Urlaubsplanung")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { close() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Merken") { save() }
                        .disabled(payload == nil || isDone)
                }
            }
        }
        .task { await read() }
    }

    private var preview: some View {
        Form {
            Section {
                if let title = payload?.title, !title.isEmpty {
                    Text(title).font(.headline)
                }
                if let url = payload?.url {
                    Text(url).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
                if let text = payload?.text, !text.isEmpty {
                    Text(text).font(.footnote).lineLimit(6)
                }
            } footer: {
                // Saying where it went matters: nothing has been added
                // to any trip yet, and a message implying otherwise
                // would be a small lie the traveller finds out later.
                Text("Wird gemerkt und in F4mil unter „Urlaubsplanung“ zum Übernehmen angeboten.")
            }
        }
    }

    private var done: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)
            Text("Gemerkt").font(.headline)
            Text("In F4mil unter „Urlaubsplanung“ bestätigen.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Read the attachments, preferring a URL over the text around it.
    ///
    /// Safari shares both: the page's URL and, sometimes, a selection.
    /// Both are useful and both are kept — the URL is where the find
    /// came from (its provenance, §9.2), and the text saves the server
    /// from having to fetch the page at all.
    private func read() async {
        defer { isReading = false }
        var url: String?
        var text: String?

        for provider in itemProviders {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier), url == nil {
                if let loadedURL = await loadItem(provider, UTType.url.identifier) as? URL {
                    url = loadedURL.absoluteString
                }
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                let loaded = await loadItem(provider, UTType.plainText.identifier)
                text = text ?? (loaded as? String)
            }
        }
        // A shared "URL" often arrives as text — from a chat app, say.
        if url == nil, let text, let firstURL = firstURL(in: text) {
            url = firstURL
        }
        // A "selection" that is only the link again tells the server
        // nothing and would show the same string twice.
        if let shared = text, let link = url,
           shared.trimmingCharacters(in: .whitespacesAndNewlines) == link {
            text = nil
        }

        let candidate = TripSharePayload(url: url, text: text, title: nil, capturedAt: Date())
        if candidate.isEmpty {
            errorMessage = "Hier war weder ein Link noch Text dabei."
            return
        }
        payload = candidate
    }

    private func loadItem(_ provider: NSItemProvider, _ typeIdentifier: String) async -> Any? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier) { item, _ in
                continuation.resume(returning: item)
            }
        }
    }

    private func firstURL(in text: String) -> String? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return detector.firstMatch(in: text, range: range)?.url?.absoluteString
    }

    private func save() {
        guard let payload else { return }
        guard let defaults = UserDefaults(suiteName: TripSharePayload.appGroupID) else {
            errorMessage = "Der geteilte Speicher ist nicht erreichbar."
            return
        }
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            defaults.set(try encoder.encode(payload), forKey: TripSharePayload.defaultsKey)
            isDone = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { close() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func close() {
        extensionContext.completeRequest(returningItems: nil)
    }
}

/// What kind of share this is.
///
/// Photos keep the flow they have had all along; a link or a piece of
/// text is a find for the planner. Deciding by what the providers
/// carry, rather than by asking, keeps the common case — sharing
/// photos — exactly as fast as it was.
enum ShareKind {
    case photos
    case tripFind

    static func of(_ providers: [NSItemProvider]) -> ShareKind {
        let hasImage = providers.contains {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        if hasImage { return .photos }
        let hasLinkOrText = providers.contains {
            $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
                || $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
        }
        return hasLinkOrText ? .tripFind : .photos
    }
}
