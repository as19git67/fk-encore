import SwiftUI

/// „Die zehn schönsten Cafés in Lissabon", read inside the app
/// (§9.2 case 2, §9.3, §20).
///
/// The commonest shape real research takes, and until now the one that
/// needed the most detours: open Safari, share the page, pick a trip.
/// The pipeline behind it has been complete since the share extension
/// landed — fetch, strip to text, let the model name the places,
/// resolve each name against the region — and it hung off a trip, which
/// is the one thing somebody reading such an article in March does not
/// have.
///
/// The screen shows what a share shows, because the answer is the same
/// answer: each place with **the sentence from the article that put it
/// on the list**. A proposal nobody can check is a proposal nobody
/// should accept — the model names places, the quote is what makes the
/// naming arguable (§9.3).
///
/// Three kinds of proposal, and they are not alike:
///
///   - resolved — one tap and it is in the collection;
///   - ambiguous — several places of that name, so pick one first;
///   - unplaceable — the region does not know it. That one is *not*
///     added: a collection entry needs a coordinate to be findable
///     again, and inventing one would be worse than saying so.
@Observable @MainActor
final class TripArticleReadModel {
    var link = ""
    var pastedText = ""
    private(set) var proposals: [TripShareProposal] = []
    /// What the server refused, in its own words. Shown, never swallowed.
    private(set) var rejected: [String] = []
    private(set) var isReading = false
    private(set) var addingId: String?
    /// Which option was picked for an ambiguous name, by proposal id.
    var chosen: [String: TripShareProposal.Option] = [:]
    /// Which proposals have been collected in this session.
    private(set) var collected: Set<String> = []
    var errorMessage: String?
    var lastAddition: String?
    private(set) var hasRead = false

    let area: TripExploreArea
    let ownerId: Int?

    init(area: TripExploreArea, ownerId: Int?) {
        self.area = area
        self.ownerId = ownerId
    }

    var canRead: Bool {
        !link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pastedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func read() async {
        guard canRead else { return }
        isReading = true
        defer { isReading = false }

        struct Body: Encodable {
            struct Position: Encodable { let lat: Double; let lon: Double }
            let position: Position
            let url: String?
            let text: String?
        }
        let trimmedLink = link.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedText = pastedText.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let response: TripAnalyseShareResponse = try await APIClient.shared.post(
                "/trip-planner/explore/article",
                body: Body(
                    position: .init(lat: area.lat, lon: area.lon),
                    url: trimmedLink.isEmpty ? nil : trimmedLink,
                    text: trimmedText.isEmpty ? nil : trimmedText,
                ),
            )
            proposals = response.proposals
            rejected = response.rejected
            collected = []
            chosen = [:]
            errorMessage = nil
            hasRead = true
        } catch {
            // The server's own sentence, when it sent one: no maps for
            // this area, no model to ask, no text on the page. Each is
            // a different thing to do next, and one wording for all
            // three would hide that.
            if case let APIError.httpError(_, message) = error,
               let message, !message.isEmpty {
                errorMessage = message
            } else {
                errorMessage = "Die Seite lie\u{00DF} sich nicht auswerten."
            }
        }
    }

    /// Where this proposal would go, given what has been chosen for it.
    ///
    /// The rule itself sits on the proposal, where a test can reach it:
    /// this class is `@MainActor`, and anything decided here would be
    /// actor-isolated and unreachable from one.
    func coordinate(of proposal: TripShareProposal) -> TripShareProposal.Coordinate? {
        proposal.placement(chosen: chosen[proposal.id])
    }

    func isCollected(_ proposal: TripShareProposal) -> Bool { collected.contains(proposal.id) }

    /// Whether this one has to be asked how long you stay.
    func needsADuration(_ proposal: TripShareProposal) -> Bool {
        proposal.needsADuration(chosen: chosen[proposal.id])
    }

    /// Put one into the collection, with the article as its provenance.
    ///
    /// The link travels with it (§9.2): weeks later „warum steht das auf
    /// der Liste?" is answered by the page it came from, and the quote
    /// is what somebody read.
    /// - Parameter dwellMinutes: only for a place with no OSM entry
    ///   behind it. Where there is one, this is omitted so the server
    ///   uses the category's own figure — sending a default here would
    ///   quietly turn every museum into three quarters of an hour.
    func collect(_ proposal: TripShareProposal, dwellMinutes: Int?) async {
        guard let target = coordinate(of: proposal) else { return }
        addingId = proposal.id
        defer { addingId = nil }

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let ownerId: Int?
            let name: String?
            let note: String?
            let sourceUrl: String?
            let dwellMinutes: Int?
        }
        let source = link.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let response: TripIdeaAddResponse = try await APIClient.shared.post(
                "/trip-planner/ideas",
                body: Body(
                    lat: target.lat,
                    lon: target.lon,
                    ownerId: ownerId,
                    name: chosen[proposal.id]?.name ?? proposal.name,
                    note: proposal.quote,
                    sourceUrl: source.isEmpty ? nil : source,
                    dwellMinutes: dwellMinutes,
                ),
            )
            lastAddition = response.sentence
            errorMessage = nil
            collected.insert(proposal.id)
        } catch {
            errorMessage = "Das lie\u{00DF} sich nicht merken."
        }
    }
}

struct TripArticleReadView: View {
    @State private var model: TripArticleReadModel
    @State private var asking: TripShareProposal?
    @Environment(\.dismiss) private var dismiss

    init(area: TripExploreArea, ownerId: Int?) {
        _model = State(initialValue: TripArticleReadModel(area: area, ownerId: ownerId))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Link zum Artikel", text: $model.link)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .submitLabel(.go)
                        .onSubmit { Task { await model.read() } }
                    TextField("\u{2026} oder Text einf\u{00FC}gen", text: $model.pastedText,
                              axis: .vertical)
                        .lineLimit(3...8)
                } header: {
                    Text("Artikel")
                } footer: {
                    // Said before it happens: a page behind a login or a
                    // cookie wall is the case pasted text exists for
                    // (§9.3 stage 1).
                    Text("Gesucht wird um \(model.area.label). Wenn die Seite den Text nicht "
                         + "hergibt, hilft Einf\u{00FC}gen.")
                }

                if let message = model.lastAddition {
                    Section { Text(message).font(.footnote).foregroundStyle(.secondary) }
                }

                if !model.rejected.isEmpty {
                    Section("Nicht \u{00FC}bernommen") {
                        ForEach(model.rejected, id: \.self) { line in
                            Text(line).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }

                if !model.proposals.isEmpty {
                    Section("Gefundene Orte") {
                        ForEach(model.proposals) { proposal in
                            row(proposal)
                        }
                    }
                } else if model.hasRead && !model.isReading {
                    Section {
                        Text("In diesem Text hat das Modell keine Orte gefunden.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Artikel auslesen")
            .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fertig") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await model.read() }
                    } label: {
                        if model.isReading { ProgressView() } else { Text("Lesen") }
                    }
                    .disabled(!model.canRead || model.isReading)
                }
            }
            .sheet(item: $asking) { proposal in
                TripIdeaCaptureSheet(
                    title: proposal.name ?? "In den Vorrat",
                    explanation: "OpenStreetMap kennt diesen Ort nicht \u{2014} "
                        + "wie lange bleibt ihr?",
                ) { _, dwellMinutes in
                    await model.collect(proposal, dwellMinutes: dwellMinutes)
                    asking = nil
                    return model.errorMessage == nil
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ proposal: TripShareProposal) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(proposal.name ?? "Ohne Namen").font(.body)

            // The sentence that put it on the list. Without it nobody
            // can tell a real find from a hallucination (§9.3).
            if let quote = proposal.quote {
                Text("\u{201E}\(quote)\u{201C}")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            switch proposal.missing {
            case .whichPlace:
                choicePicker(proposal)
            case .howLong, .nothing:
                EmptyView()
            }

            if model.isCollected(proposal) {
                Label("Im Vorrat", systemImage: "lightbulb.fill")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if model.coordinate(of: proposal) != nil {
                Button {
                    // A place the map knows brings its own duration; one
                    // it does not know has none, and that is the single
                    // question §9.2 allows.
                    if model.needsADuration(proposal) {
                        asking = proposal
                    } else {
                        Task { await model.collect(proposal, dwellMinutes: nil) }
                    }
                } label: {
                    Label("In den Vorrat", systemImage: "lightbulb")
                        .font(.subheadline)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .disabled(model.addingId != nil)
            } else {
                // Not addable, and it says which of the two reasons:
                // still to be chosen, or nowhere on the map at all.
                Text(proposal.missing == .whichPlace
                     ? "Erst ausw\u{00E4}hlen, welcher gemeint ist."
                     : "In dieser Gegend nicht gefunden \u{2014} bleibt als Notiz im Artikel.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func choicePicker(_ proposal: TripShareProposal) -> some View {
        Menu {
            ForEach(proposal.options) { option in
                Button {
                    model.chosen[proposal.id] = option
                } label: {
                    Text(optionLabel(option))
                }
            }
        } label: {
            Label(model.chosen[proposal.id].map(optionLabel) ?? "Welcher ist gemeint?",
                  systemImage: "questionmark.circle")
                .font(.subheadline)
                .frame(minHeight: 44)
        }
    }

    private func optionLabel(_ option: TripShareProposal.Option) -> String {
        guard let distance = option.distanceM else { return option.name ?? "Unbenannt" }
        return "\(option.name ?? "Unbenannt") \u{00B7} \(TripDistance.text(Int(distance)))"
    }
}
