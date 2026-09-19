import SwiftUI

/// "Einen Tag dorthin einplanen?" (§4.6)
///
/// Four days booked in a town of seven thousand. The pool does not
/// carry them — and everybody you ask says you are an hour from the
/// city. A planner that keeps quiet about that is not restrained, it
/// is useless.
///
/// And yet sixty kilometres are a decision about a day, not a side
/// effect of a search, so this screen is the same shape as the evening
/// light (§7.3): **a sentence until somebody taps.** Accepting sets
/// the day's anchor (§4.5) and the trip is re-planned around it;
/// refusing is remembered, so the question is asked once and not every
/// time the screen opens (§6.4).
///
/// Three things the screen is careful about:
///
///   - **It shows the arithmetic**, not just the conclusion. "Zwei
///     eurer vier Tage werden vom Vorrat getragen" is checkable; "wir
///     empfehlen" is not (§10.7).
///   - **One destination, not five.** Five would be a decision handed
///     back dressed as a hint (§20.2). If this one is wrong, "nein
///     danke" brings the next.
///   - **The drive is an estimate** and says so. Without a routing
///     engine an hour may be ninety minutes (§12), and the traveller
///     is the one who knows the road.
struct TripDayTripView: View {
    let planId: Int
    let legIndex: Int
    var onPlanChanged: (() -> Void)?

    @State private var answer: TripDayTripAnswer?
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var accepted = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading && answer == nil {
                Section { ProgressView() }
            }

            if let suggestion = answer?.suggestion, !accepted {
                suggestionSection(suggestion)
                reasoningSection()
            }

            if accepted {
                Section {
                    Label("Als Tagesausflug eingeplant", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                } footer: {
                    Text("Der Tag wird von dort aus geplant, und Hin- und Rückweg gehen von "
                         + "seinen Blöcken ab.")
                }
            }

            if !isLoading, answer?.suggestion == nil, !accepted {
                nothingSection()
            }
        }
        .navigationTitle("Tagesausflug")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(errorMessage, retry: { await load() }, dismiss: { errorMessage = nil })
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func suggestionSection(_ suggestion: TripDayTripSuggestion) -> some View {
        Section {
            Text(suggestion.sentence).font(.callout)

            Label(suggestion.target.costSummary, systemImage: "car")
                .font(.footnote)
                .foregroundStyle(.secondary)

            // What is there, by name: the suggestion has to be
            // arguable, and a count alone is not (§10.7).
            if !suggestion.target.examples.isEmpty {
                Text("Dort zum Beispiel: " + suggestion.target.examples.joined(separator: ", "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Button {
                Task { await accept(suggestion) }
            } label: {
                HStack {
                    Text("Tag \(suggestion.dayIndex + 1) dorthin einplanen")
                    Spacer()
                    if isWorking { ProgressView() }
                }
            }
            .disabled(isWorking)

            Button("Nein danke", role: .cancel) {
                Task { await dismissIt(suggestion) }
            }
            .disabled(isWorking)
        } header: {
            Label(suggestion.target.name, systemImage: suggestion.target.symbolName)
        } footer: {
            Text("Die Fahrzeit ist geschätzt — ohne Routenplaner kann eine Stunde auch "
                 + "neunzig Minuten sein. „Nein danke“ wird gemerkt und nicht noch einmal "
                 + "gefragt.")
        }
    }

    /// The measurement, in the open. Somebody who disagrees with the
    /// suggestion should be able to see which number they disagree with.
    @ViewBuilder
    private func reasoningSection() -> some View {
        if let answer, answer.dayMinutes > 0 {
            Section("Warum das hier steht") {
                LabeledContent("Nicht verplante Zeit",
                               value: TripClock.duration(answer.emptyMinutes))
                LabeledContent("Noch im Vorrat",
                               value: TripClock.duration(answer.poolMinutes))
                LabeledContent("Bliebe trotzdem leer",
                               value: TripClock.duration(answer.uncoveredMinutes))
            }
        }
    }

    @ViewBuilder
    private func nothingSection() -> some View {
        Section {
            Text(answer?.note
                 ?? "Für diese Etappe gibt es gerade nichts vorzuschlagen.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } footer: {
            // The commonest case by far, and it deserves saying: a leg
            // that carries its own days is not missing anything.
            Text(answer?.undersupplied == true
                 ? "Der Vorrat trägt die Tage nicht — es liegt nur nichts in Reichweite, "
                   + "was einen ganzen Tag füllen würde."
                 : "Der Vorrat dieser Etappe trägt ihre Tage. Ein Ausflug wäre hier eine "
                   + "Antwort auf eine Frage, die niemand gestellt hat.")
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            // Through an explicit non-optional local, the way every
            // other screen here does it: assigning straight into the
            // optional would let the generic infer an Optional as the
            // decoded type.
            let loaded: TripDayTripAnswer = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/day-trip",
                query: ["legIndex": String(legIndex)],
            )
            answer = loaded
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func accept(_ suggestion: TripDayTripSuggestion) async {
        isWorking = true
        defer { isWorking = false }
        do {
            // The destination is looked up again on the server rather
            // than read out of this request: where a day happens
            // decides which pool it is built from (§4.5).
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/day-trip",
                body: TripAcceptDayTripRequest(
                    legIndex: legIndex,
                    key: suggestion.target.key,
                ),
            )
            accepted = true
            onPlanChanged?()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func dismissIt(_ suggestion: TripDayTripSuggestion) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let _: TripDismissDayTripResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/day-trip/dismiss",
                body: TripDismissDayTripRequest(
                    legIndex: legIndex,
                    key: suggestion.target.key,
                    name: suggestion.target.name,
                ),
            )
            // Straight on to the next one, if there is a next one: a
            // "no" is about this place, not about the question.
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}
