import QuickLook
import SwiftUI

/// The paperwork a trip runs on (§3.4).
///
/// The documents are already in the house — OCR'd, classified,
/// searchable. What this screen adds is the sentence §8.2 asks for:
/// *„Ich habe eine Hotelbuchung für diesen Zeitraum gefunden — als
/// Basis nehmen?"* Nothing is taken over silently; every suggestion
/// carries the reason it was made, and somebody taps.
///
/// A document the traveller may read opens as its PDF and nothing else
/// — from the phone when the trip is kept for the road, so the ticket is
/// there at the gate without a network (Anton, 16.11.). The trip is
/// shared, the paperwork is not: a participant who may not read it sees
/// only that one is attached, and has no PDF to open.
///
/// What this screen deliberately does not do is write a fixpoint out of
/// a read time: a departure that
/// OCR misread by an hour would be exactly the mistake §8.6 says is
/// found too late. The times are shown next to the line they were read
/// from, and the fixpoint stays the organiser's own call (§4.4).
struct TripDocumentsView: View {
    let planId: Int

    @State private var attached: [TripDocument] = []
    @State private var suggestions: [TripDocumentSuggestion] = []
    @State private var isLoading = true
    @State private var busyId: Int?
    @State private var errorMessage: String?
    /// Set when the list is the one kept with the trip, because the
    /// server could not be reached.
    @State private var offlineSince: Date?
    /// The PDF open in place.
    @State private var opened: TripDocumentPDF?

    var body: some View {
        List {
            if isLoading && attached.isEmpty && suggestions.isEmpty {
                Section { ProgressView() }
            }

            if !attached.isEmpty {
                Section {
                    ForEach(attached) { document in
                        row(for: document)
                    }
                } header: {
                    Text("An dieser Reise")
                } footer: {
                    Text("Gelesene Zeiten sind Vorschläge, keine festen Zeiten — eine falsch "
                         + "erkannte Abfahrt fällt sonst erst am Bahnsteig auf.")
                }
            }

            if !suggestions.isEmpty {
                Section {
                    ForEach(suggestions) { suggestion in
                        suggestionRow(for: suggestion)
                    }
                } header: {
                    Text("Sieht nach dieser Reise aus")
                } footer: {
                    Text("Vorgeschlagen, nicht übernommen. Jeder Vorschlag sagt, woran er "
                         + "diese Reise erkannt hat.")
                }
            }

            if !isLoading && attached.isEmpty && suggestions.isEmpty {
                Section {
                    Text("Hier ist noch nichts. Sobald eine Buchung oder ein Ticket im "
                         + "Dokumentenbestand liegt und diese Reise erwähnt, taucht es auf.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let offlineSince {
                TripOfflineBar(since: offlineSince) { Task { await load() } }
            }
        }
        .sheet(item: $opened) { pdf in
            TripDocumentPDFSheet(pdf: pdf)
        }
        .navigationTitle("Dokumente")
        .plannerErrorBanner(errorMessage, retry: { await load() }, dismiss: { errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func row(for document: TripDocument) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                if document.readable {
                    Button {
                        opened = TripDocumentPDF(planId: planId, document: document)
                    } label: {
                        Label(document.displayTitle, systemImage: document.symbolName)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityHint("Öffnet das PDF")
                } else {
                    Label(document.displayTitle, systemImage: document.symbolName)
                        .foregroundStyle(.secondary)
                }
                if document.readable, TripOfflineStore.shared.storedDocument(document.documentId) != nil {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Für unterwegs geladen")
                }
                Spacer()
                if offlineSince == nil {
                    Button(role: .destructive) {
                        Task { await detach(document) }
                    } label: {
                        if busyId == document.documentId {
                            ProgressView()
                        } else {
                            Image(systemName: "minus.circle")
                        }
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Von der Reise lösen")
                }
            }
            if let subtitle = document.subtitle {
                Text(subtitle).font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(document.hints) { hint in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: hint.symbolName).foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(hint.label) \(hint.clock)").font(.footnote)
                        Text(hint.evidence)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func suggestionRow(for suggestion: TripDocumentSuggestion) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Label(suggestion.title ?? "Dokument", systemImage: suggestion.symbolName)
                Text(suggestion.reasons.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await attach(suggestion) }
            } label: {
                if busyId == suggestion.documentId {
                    ProgressView()
                } else {
                    Image(systemName: "plus.circle")
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let linked: TripDocumentsResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/documents")
            let offered: TripDocumentSuggestionsResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/documents/suggestions")
            attached = linked.documents
            suggestions = offered.suggestions
            errorMessage = nil
            offlineSince = nil
        } catch {
            // Without a network, the list kept with the trip (§3.9);
            // nothing is suggested then, suggestions need the server.
            if TripOfflineReach.meansUnreachable(error),
               let kept = TripOfflineStore.shared.load(planId: planId),
               let documents = kept.bundle.documents {
                attached = documents
                suggestions = []
                offlineSince = kept.storedAt
                errorMessage = nil
            } else {
                errorMessage = TripErrorText.describe(error)
            }
        }
    }

    private func attach(_ suggestion: TripDocumentSuggestion) async {
        busyId = suggestion.documentId
        defer { busyId = nil }
        do {
            let _: TripDocumentLinkResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/documents",
                body: TripDocumentLinkRequest(
                    documentId: suggestion.documentId, role: suggestion.role))
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func detach(_ document: TripDocument) async {
        busyId = document.documentId
        defer { busyId = nil }
        do {
            let _: TripDocumentUnlinkResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/documents/remove",
                body: TripDocumentUnlinkRequest(documentId: document.documentId))
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}

struct TripDocumentsResponse: Codable, Sendable {
    let documents: [TripDocument]
}

struct TripDocumentSuggestionsResponse: Codable, Sendable {
    let suggestions: [TripDocumentSuggestion]
}

struct TripDocumentLinkRequest: Encodable, Sendable {
    let documentId: Int
    let role: String?
}

struct TripDocumentLinkResponse: Codable, Sendable {
    let document: TripDocument
}

struct TripDocumentUnlinkRequest: Encodable, Sendable {
    let documentId: Int
}

struct TripDocumentUnlinkResponse: Codable, Sendable {
    let removed: Bool
}

struct TripDocument: Codable, Identifiable, Sendable {
    let id: Int
    let documentId: Int
    let role: String
    let note: String?
    let linkedBy: String?
    /// False when this traveller may not read the document. Then the
    /// row says a document is there and nothing about what it is.
    let readable: Bool
    let title: String?
    let sender: String?
    let docDate: String?
    let hints: [TripDocumentTimeHint]

    var displayTitle: String {
        if !readable { return "Ein Dokument von \(linkedBy ?? "jemandem")" }
        return title ?? "Dokument"
    }

    /// Who attached it and when it is dated — the trip's own knowledge,
    /// which stays readable even when the document does not.
    var subtitle: String? {
        var parts: [String] = []
        if readable, let sender { parts.append(sender) }
        if readable, let docDate { parts.append(TripDocumentWording.german(docDate)) }
        if let linkedBy { parts.append("von \(linkedBy)") }
        if !readable { parts.append("nur für den sichtbar, der es hochgeladen hat") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var symbolName: String { TripDocumentWording.symbol(for: role) }
}

struct TripDocumentSuggestion: Codable, Identifiable, Sendable {
    var id: Int { documentId }
    let documentId: Int
    let title: String?
    let sender: String?
    let docDate: String?
    let role: String
    let reasons: [String]

    var symbolName: String { TripDocumentWording.symbol(for: role) }
}

struct TripDocumentTimeHint: Codable, Identifiable, Sendable {
    var id: String { "\(label)-\(minutes)" }
    let label: String
    /// appointment | departure — the difference §4.4 insists on.
    let kind: String
    let minutes: Int
    let evidence: String

    var clock: String {
        String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }

    /// A departure is the one you do not come back from.
    var symbolName: String { kind == "departure" ? "arrow.right.to.line" : "clock" }
}

enum TripDocumentWording {
    static func symbol(for role: String) -> String {
        switch role {
        case "lodging": return "bed.double"
        case "transport": return "tram"
        case "rental": return "car"
        default: return "ticket"
        }
    }

    /// "2026-07-12" → "12.07.2026". Date-only, so no time zone is
    /// allowed anywhere near it.
    static func german(_ iso: String) -> String {
        let parts = iso.split(separator: "-")
        guard parts.count == 3 else { return iso }
        return "\(parts[2]).\(parts[1]).\(parts[0])"
    }
}

/// A document to show as its PDF.
struct TripDocumentPDF: Identifiable {
    let planId: Int
    let document: TripDocument
    var id: Int { document.documentId }
}

/// The PDF of a trip document, in place: the kept file when the trip is
/// stored for the road, otherwise fetched for this look and thrown away
/// again. Only the file — the details belong to the documents module.
struct TripDocumentPDFSheet: View {
    let pdf: TripDocumentPDF
    @State private var fileURL: URL?
    @State private var isTemporary = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let fileURL {
                    TripQuickLook(url: fileURL)
                        .ignoresSafeArea(edges: .bottom)
                } else if let failure {
                    ContentUnavailableView("PDF nicht geladen", systemImage: "doc.text",
                                           description: Text(failure))
                } else {
                    ProgressView("PDF wird geladen …")
                }
            }
            .navigationTitle(pdf.document.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
                if let fileURL {
                    ToolbarItem(placement: .topBarLeading) {
                        ShareLink(item: fileURL)
                    }
                }
            }
        }
        .task { await open() }
        .onDisappear {
            if isTemporary, let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        }
    }

    private func open() async {
        if let kept = TripOfflineStore.shared.storedDocument(pdf.document.documentId) {
            fileURL = kept
            return
        }
        do {
            let data = try await APIClient.shared.downloadData(
                "/trip-planner/plans/\(pdf.planId)/documents/\(pdf.document.documentId)/file")
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("reise-dokument-\(pdf.document.documentId)-\(UUID().uuidString)")
                .appendingPathExtension("pdf")
            try data.write(to: url, options: .atomic)
            isTemporary = true
            fileURL = url
        } catch {
            failure = TripOfflineReach.meansUnreachable(error)
                ? "Ohne Verbindung gibt es nur die PDFs von Reisen, die für unterwegs geladen sind."
                : TripErrorText.describe(error)
        }
    }
}

/// QuickLook for one file.
struct TripQuickLook: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}
