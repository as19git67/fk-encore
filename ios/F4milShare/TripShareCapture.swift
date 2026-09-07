import MapKit
import SwiftUI
import UniformTypeIdentifiers

/// The share extension's picker + analysis flow (§9.2).
///
/// The user selects a trip in the share sheet and the find goes straight
/// into that trip's pool — no inbox detour, no "open the app first".
///
/// For Apple Maps shares the coordinates are already in the payload, so
/// the API round trip is skipped and a synthetic proposal is shown. For
/// URLs and selected text the backend analyses the content and returns
/// one or more proposals, which the user confirms in `ShareProposalsView`.
struct TripShareCaptureView: View {
    let extensionContext: NSExtensionContext
    let itemProviders: [NSItemProvider]

    @State private var payload: TripSharePayload?
    /// Coordinates extracted from the payload URL (Apple Maps, Google Maps).
    @State private var coordinate: (lat: Double, lon: Double, name: String?)?
    @State private var isReading = true
    @State private var readError: String?

    // Picker state
    @State private var plans: [SharePlanSummary] = []
    @State private var isLoadingPlans = false
    @State private var plansError: String?
    @State private var selectedPlanId: Int?
    @State private var titleText = ""
    @State private var noteText = ""
    @State private var dwellMinutes: Int = 45

    // Save
    @State private var isSaving = false
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            Group {
                if isReading || (isLoadingPlans && plans.isEmpty) {
                    ProgressView(isReading ? "Wird gelesen\u{2026}" : "L\u{00E4}dt Reisen\u{2026}")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = readError {
                    ContentUnavailableView(
                        "Nichts zu \u{00FC}bernehmen", systemImage: "link.badge.plus",
                        description: Text(error))
                } else {
                    pickerForm
                }
            }
            .navigationTitle("Ort \u{00FC}bernehmen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { close() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text("Speichern") }
                    }
                    .disabled(selectedPlanId == nil || isSaving || isLoadingPlans)
                }
            }

        }
        .task {
            await read()
            await loadPlans()
        }
    }

    // MARK: - Picker form

    private var pickerForm: some View {
        Form {
            // Source preview
            if let url = payload?.url {
                Section("Quelle") {
                    if let title = payload?.title, !title.isEmpty {
                        Text(title).font(.subheadline).fontWeight(.medium)
                    }
                    Text(url).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            } else if let text = payload?.text {
                Section("Quelle") {
                    Text(text).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
            }

            Section {
                TextField("Titel", text: $titleText)
                TextField("Notiz", text: $noteText, axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("Zum Ort")
            } footer: {
                Text("Der Titel wird zum Namen im Vorrat. Die Notiz bleibt beim Eintrag.")
            }

            Section {
                Stepper(value: $dwellMinutes, in: 5...480, step: 5) {
                    Text("Aufenthalt: \(dwellMinutes) Min.")
                }
            } header: {
                Text("Aufenthaltsdauer")
            } footer: {
                Text("Wie lange ihr voraussichtlich bleibt \u{2014} kann sp\u{00E4}ter noch angepasst werden.")
            }

            Section("Reise") {
                if isLoadingPlans {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("L\u{00E4}dt Reisen\u{2026}").foregroundStyle(.secondary)
                    }
                } else if let error = plansError {
                    Text(error).font(.footnote).foregroundStyle(.red)
                    Button("Erneut versuchen") { Task { await loadPlans() } }
                } else if plans.isEmpty {
                    Text("Noch keine Reise angelegt.")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(plans) { plan in
                        Button {
                            selectedPlanId = plan.id
                        } label: {
                            HStack {
                                Text(plan.displayTitle).foregroundStyle(.primary)
                                Spacer()
                                if selectedPlanId == plan.id {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
            }

            if let error = saveError {
                Section {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
        }
    }

    // MARK: - Reading

    /// Read the attachments.
    ///
    /// The page reading comes first and wins outright when it is there
    /// (§9.3 stage 1). Safari runs `TripSharePageReading.js` inside the
    /// page the reader is looking at and hands back its visible text,
    /// which beats anything the server can fetch afterwards: the
    /// browser has already dealt with the JavaScript, the cookie
    /// banner, the login and the bot block. Everything below is the
    /// fallback for a share that carries no page — a link out of a chat
    /// app, a piece of text off a screenshot.
    ///
    /// Both a URL and text are kept when both arrive: the URL is where
    /// the find came from (its provenance, §9.2), the text is what the
    /// server would otherwise have to go and get.
    private func read() async {
        defer { isReading = false }

        if let fromPage = await readOpenPage() {
            payload = fromPage
            return
        }

        // When sharing a named place from Apple Maps the share sheet
        // includes an MKMapItem — the fastest and most reliable source of
        // coordinates, requiring no network call.
        if let fromMap = await readMapItem() {
            payload = fromMap
            if let url = fromMap.url {
                coordinate = Self.extractCoordinate(from: url)
                titleText = fromMap.title ?? coordinate?.name ?? ""
            }
            return
        }

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
            readError = "Hier war weder ein Link noch Text dabei."
            return
        }
        payload = candidate

        if let urlString = url, let coord = Self.extractCoordinate(from: urlString) {
            coordinate = coord
            titleText = coord.name ?? ""
        }
    }

    /// Pull `ll=lat,lon&q=name` out of a maps.apple.com or similar URL.
    private static func extractCoordinate(
        from urlString: String
    ) -> (lat: Double, lon: Double, name: String?)? {
        guard let url = URL(string: urlString),
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        var params: [String: String] = [:]
        for item in items { if let v = item.value { params[item.name] = v } }
        guard let ll = params["ll"] else { return nil }
        let parts = ll.split(separator: ",")
        guard parts.count >= 2,
              let lat = Double(parts[0].trimmingCharacters(in: .whitespaces)),
              let lon = Double(parts[1].trimmingCharacters(in: .whitespaces)),
              (-90...90).contains(lat), (-180...180).contains(lon)
        else { return nil }
        let name = params["q"].map { $0.replacingOccurrences(of: "+", with: " ") }
        return (lat, lon, name)
    }

    // MARK: - Loading plans

    private func loadPlans() async {
        isLoadingPlans = true
        defer { isLoadingPlans = false }
        do {
            plans = try await ShareExtensionAPI.fetchPlans()
            if plans.count == 1 { selectedPlanId = plans.first?.id }
        } catch {
            plansError = error.localizedDescription
        }
    }

    // MARK: - Save

    private func save() async {
        guard let planId = selectedPlanId else { return }
        saveError = nil
        isSaving = true
        defer { isSaving = false }
        let title = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let coord = coordinate {
                _ = try await ShareExtensionAPI.addFind(
                    planId: planId, lat: coord.lat, lon: coord.lon,
                    name: title.isEmpty ? coord.name : title,
                    note: note.isEmpty ? nil : note,
                    sourceUrl: payload?.url,
                    legIndex: nil,
                    dwellMinutes: dwellMinutes)
            } else {
                let response = try await ShareExtensionAPI.analyzeShare(
                    planId: planId, url: payload?.url, text: payload?.text)
                var added = 0
                for proposal in response.proposals where proposal.canAdd {
                    let pos = proposal.options.first.map {
                        ShareProposal.Coordinate(lat: $0.lat, lon: $0.lon)
                    } ?? proposal.position
                    guard let pos else { continue }
                    let name = title.isEmpty ? proposal.name : (added == 0 ? title : proposal.name)
                    _ = try await ShareExtensionAPI.addFind(
                        planId: planId, lat: pos.lat, lon: pos.lon,
                        name: name, note: note.isEmpty ? nil : note,
                        sourceUrl: response.sourceUrl,
                        legIndex: proposal.options.first?.legIndex ?? proposal.legIndex,
                        dwellMinutes: proposal.needsDuration ? dwellMinutes : nil)
                    added += 1
                }
                if added == 0 {
                    saveError = "Kein Ort gefunden, der \u{00FC}bernommen werden konnte."
                    return
                }
            }
            close()
        } catch {
            saveError = error.localizedDescription
        }
    }

    // MARK: - Reading helpers

    /// Extract a place from an MKMapItem provided by Apple Maps.
    ///
    /// When the user shares a named place from the Maps app, the share
    /// sheet puts an MKMapItem in the attachment list alongside the
    /// short-link URL. Loading it here gives us precise coordinates and
    /// the canonical place name without any network round trip. The
    /// result is encoded as a standard maps.apple.com/?ll= URL so the
    /// coordinate extractor handles it without further network calls.
    private func readMapItem() async -> TripSharePayload? {
        for provider in itemProviders where provider.canLoadObject(ofClass: MKMapItem.self) {
            let mapItem: MKMapItem? = await withCheckedContinuation { continuation in
                provider.loadObject(ofClass: MKMapItem.self) { item, _ in
                    continuation.resume(returning: item as? MKMapItem)
                }
            }
            guard let mapItem else { continue }
            let coord = mapItem.placemark.coordinate
            // Guard against the 0,0 sentinel that means "no coordinate".
            guard abs(coord.latitude) > 0.0001 || abs(coord.longitude) > 0.0001 else { continue }
            let name = mapItem.name ?? mapItem.placemark.name ?? ""
            var parts = URLComponents()
            parts.scheme = "https"
            parts.host = "maps.apple.com"
            parts.path = "/"
            parts.queryItems = [
                URLQueryItem(name: "ll", value: "\(coord.latitude),\(coord.longitude)"),
                name.isEmpty ? nil : URLQueryItem(name: "q", value: name),
            ].compactMap { $0 }
            guard let url = parts.url else { continue }
            return TripSharePayload(url: url.absoluteString, text: nil,
                                    title: name.isEmpty ? nil : name, capturedAt: Date())
        }
        return nil
    }

    /// The result of the page-reading script, if Safari ran one.
    ///
    /// It arrives as a property list under a well-known key rather than
    /// as its own attachment, which is why this cannot simply ask for a
    /// text item and be done.
    private func readOpenPage() async -> TripSharePayload? {
        let type = UTType.propertyList.identifier
        for provider in itemProviders where provider.hasItemConformingToTypeIdentifier(type) {
            guard let item = await loadItem(provider, type) as? [String: Any],
                  let results = item[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]
            else { continue }
            if let payload = TripSharePayload(javaScriptResults: results) { return payload }
        }
        return nil
    }

    private func loadItem(_ provider: NSItemProvider, _ typeIdentifier: String) async -> Any? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier) { item, _ in
                continuation.resume(returning: item)
            }
        }
    }

    private func firstURL(in text: String) -> String? {
        guard let detector = try? NSDataDetector(
            types: NSTextCheckingResult.CheckingType.link.rawValue)
        else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return detector.firstMatch(in: text, range: range)?.url?.absoluteString
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
                // A page Safari has already read for us (§9.3 stage 1)
                // arrives as a property list and nothing else.
                || $0.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier)
                // Apple Maps includes an MKMapItem alongside the short URL.
                || $0.canLoadObject(ofClass: MKMapItem.self)
        }
        return hasLinkOrText ? .tripFind : .photos
    }
}
