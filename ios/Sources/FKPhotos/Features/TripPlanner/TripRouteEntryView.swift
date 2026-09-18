import SwiftUI

/// Bringing in a route by hand (§4.7): a spot whose way is the point.
///
/// The region import knows only points, so the Ponale road, the ridge
/// path, the panoramic drive come in here — with the two things a
/// point cannot say: where it **ends**, and how long it **takes**. The
/// server refuses a route without its duration on purpose: no category
/// knows how long a way is, and the alternative is a four-hour ride
/// planned as twenty minutes.
///
/// Start and end are found the way every place in the app is found —
/// on the device, through MapKit (`TripPlaceFinderRows`): a name is not
/// a place, so nothing is saved until both ends are coordinates.
@Observable @MainActor
final class TripRouteEntryModel {
    var name = ""
    var note = ""
    var durationMinutes = 180
    /// Kilometres as typed; parsed leniently ("10", "10,5", "10.5").
    var lengthText = ""
    var ascentText = ""
    var start: TripPlace?
    var end: TripPlace?
    private(set) var isSaving = false
    private(set) var savedTo: Int?
    var errorMessage: String?

    let startFinder = TripPlaceFinderModel()
    let endFinder = TripPlaceFinderModel()

    private let planId: Int
    private let legIndex: Int?

    init(planId: Int, legIndex: Int? = nil) {
        self.planId = planId
        self.legIndex = legIndex
    }

    /// What still stands between this form and a saved route, in the
    /// order it is asked for on screen. Nil when nothing does.
    var missing: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "ein Name" }
        if start == nil { return "der Startpunkt" }
        if end == nil { return "der Endpunkt" }
        if durationMinutes <= 0 { return "die Dauer" }
        return nil
    }

    var canSave: Bool { missing == nil && !isSaving }

    /// The request as it goes out, or nil while something is missing.
    ///
    /// Internal so it can be tested: the difference between a route and
    /// a place is the `end`, and the length travels in metres while the
    /// field takes kilometres.
    func request() -> TripAddFindRequest? {
        guard let start, let end, missing == nil else { return nil }
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return TripAddFindRequest(
            lat: start.latitude,
            lon: start.longitude,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            note: trimmedNote.isEmpty ? nil : trimmedNote,
            sourceUrl: nil,
            legIndex: legIndex,
            dwellMinutes: durationMinutes,
            end: TripCoordinate(lat: end.latitude, lon: end.longitude),
            lengthM: Self.metres(fromKilometres: lengthText),
            ascentM: Self.wholeNumber(ascentText),
        )
    }

    func save() async {
        guard let body = request() else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let response: TripAddFindResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(planId)/finds",
                body: body,
            )
            savedTo = response.legIndex
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// "10", "10,5" and "10.5" are all ten-and-a-bit kilometres; anything
    /// else, including nothing, is no length rather than a wrong one.
    static func metres(fromKilometres text: String) -> Int? {
        let cleaned = text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard let km = Double(cleaned), km > 0 else { return nil }
        return Int((km * 1_000).rounded())
    }

    static func wholeNumber(_ text: String) -> Int? {
        guard let value = Int(text.trimmingCharacters(in: .whitespaces)), value >= 0 else { return nil }
        return value
    }
}

struct TripRouteEntryView: View {
    @State private var model: TripRouteEntryModel
    @Environment(\.dismiss) private var dismiss

    init(planId: Int, legIndex: Int? = nil) {
        _model = State(initialValue: TripRouteEntryModel(planId: planId, legIndex: legIndex))
    }

    var body: some View {
        Form {
            Section {
                TextField("Name der Strecke", text: $model.name)
                    .textInputAutocapitalization(.words)
                TextField("Warum lohnt sie sich? (optional)", text: $model.note, axis: .vertical)
                    .lineLimit(2...4)
            } footer: {
                Text("Eine Strecke ist ein Ort, dessen Weg das Ziel ist — ein Panoramaweg, "
                     + "eine Passstraße. Der Tag geht an ihrem Ende weiter.")
            }

            Section("Start") {
                TripPlaceFinderRows(model: model.startFinder, picked: model.start) { place in
                    model.start = place
                    model.startFinder.clearResults()
                }
            }

            Section("Ende") {
                TripPlaceFinderRows(model: model.endFinder, picked: model.end) { place in
                    model.end = place
                    model.endFinder.clearResults()
                }
            }

            Section {
                Stepper(value: $model.durationMinutes, in: 15...600, step: 15) {
                    LabeledContent("Dauer", value: TripClock.duration(model.durationMinutes))
                }
                LabeledContent("Länge") {
                    TextField("km", text: $model.lengthText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("Anstieg") {
                    TextField("Höhenmeter", text: $model.ascentText)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                }
            } footer: {
                // The one number the planner cannot look up (§4.7): a
                // way takes as long as the people on it take.
                Text("Die Dauer gilt so, wie ihr sie hier schätzt — keine Kategorie kennt "
                     + "sie. Länge und Anstieg sind Angaben für euch, kein Muss.")
            }

            if let missing = model.missing {
                Text("Es fehlt noch: \(missing).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Strecke anlegen")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Sichern") {
                    Task {
                        await model.save()
                        if model.savedTo != nil { dismiss() }
                    }
                }
                .disabled(!model.canSave)
            }
        }
        .disabled(model.isSaving)
    }
}
