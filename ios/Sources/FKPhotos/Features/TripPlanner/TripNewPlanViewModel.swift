import SwiftUI

/// The "new trip" screen's state: searching for a place, reading a
/// sentence, and creating the plan.
///
/// Place search runs on the **device**, through MapKit, and that is the
/// same division of labour §9.1 sets out rather than a shortcut: Apple
/// geocodes and rates, fk-encore plans. The service says so itself —
/// `/trip-planner/interpret` returns the place *name* a sentence used
/// and no coordinates, because it has no forward geocoder and will not
/// invent one.
///
/// The sentence is an accelerator, never the way in. The form below it
/// stands on its own, so a trip can be started with the language model
/// offline — which is the normal state of a self-hosted box that has
/// not warmed a model up yet.
@Observable @MainActor
final class TripNewPlanViewModel {
    var draft = TripNewPlanDraft()

    /// The place search for the first city. Kept apart from the picked
    /// place: typing again after picking should not silently unpick.
    let finder = TripPlaceFinderModel()

    /// The sentence, and what the model made of it.
    var sentence = ""
    private(set) var isInterpreting = false
    private(set) var rejected: [String] = []
    /// Set when the model could not be reached. A state, not a fault of
    /// the request — the form still works.
    private(set) var interpretUnavailable: String?

    private(set) var isCreating = false
    var errorMessage: String?

    // MARK: - Place search

    func pick(_ place: TripPlace) {
        draft.anchor = place
        finder.query = place.name
        finder.clearResults()
    }

    /// Take the place name a sentence mentioned into the search field
    /// and look it up — the traveller still confirms which one it is.
    func searchPlaceHint() {
        guard let hint = draft.placeHint, !hint.isEmpty else { return }
        finder.lookUp(hint)
    }

    // MARK: - The legs

    /// Add a city after the ones already there (§4.2).
    ///
    /// Its length and mode start from the previous leg's rather than
    /// from the defaults: a second city on a trip you are cycling
    /// through is almost certainly also cycled.
    func addLeg() {
        let previous = draft.legs.last
        draft.legs.append(TripDraftLeg(
            days: previous?.days ?? 3,
            mode: previous?.mode ?? .foot,
            radiusM: previous?.radiusM ?? 3_000,
        ))
    }

    /// Remove cities the list offered for deletion.
    ///
    /// The offsets index the **displayed** rows, and the list shows the
    /// route from the second city on — so offset 0 is `legs[1]`. Taking
    /// them as absolute indices deleted the wrong city and silently
    /// ignored the first row, which is the sort of off-by-one that
    /// looks like the list "sometimes not working".
    ///
    /// Resolved to ids before anything is removed, because every
    /// removal moves the indices of everything after it.
    func removeLegs(displayedAt offsets: IndexSet) {
        let ids = offsets.compactMap { offset -> TripDraftLeg.ID? in
            let index = offset + 1
            return draft.legs.indices.contains(index) ? draft.legs[index].id : nil
        }
        guard !ids.isEmpty else { return }
        draft.legs.removeAll { ids.contains($0.id) }
    }

    /// A binding to one city that survives the list changing under it.
    ///
    /// SwiftUI evaluates a pushed destination once more while it is
    /// being dismissed, and a binding that subscripts by a captured
    /// index crashes there the moment the list has grown shorter. This
    /// one looks the city up by id every time and answers a throwaway
    /// value when it is gone — the screen is on its way out anyway.
    func binding(for id: TripDraftLeg.ID) -> Binding<TripDraftLeg> {
        Binding(
            get: { [weak self] in
                self?.draft.legs.first { $0.id == id } ?? TripDraftLeg()
            },
            set: { [weak self] updated in
                guard let self,
                      let index = self.draft.legs.firstIndex(where: { $0.id == id })
                else { return }
                self.draft.legs[index] = updated
            },
        )
    }

    /// Where this city currently sits in the route, or nil once it is
    /// gone. Only ever used for a label.
    func position(of id: TripDraftLeg.ID) -> Int? {
        draft.legs.firstIndex { $0.id == id }
    }

    /// The city one travels *from* to reach this one.
    func legBefore(_ id: TripDraftLeg.ID) -> TripDraftLeg? {
        guard let index = position(of: id), index > 0 else { return nil }
        return draft.legs[index - 1]
    }

    // MARK: - The sentence

    func interpretSentence() async {
        let text = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        isInterpreting = true
        interpretUnavailable = nil
        defer { isInterpreting = false }
        struct Body: Encodable { let text: String }
        do {
            let response: TripInterpretResponse =
                try await APIClient.shared.post("/trip-planner/interpret", body: Body(text: text))
            draft.apply(response.constraints)
            rejected = response.rejected
            // The place still has to be confirmed on the map: a name is
            // not a coordinate, and this screen never pretends it is.
            if draft.anchor == nil { searchPlaceHint() }
        } catch {
            interpretUnavailable = error.localizedDescription
        }
    }

    // MARK: - Creating

    /// Create the plan and answer its id, or nil when it failed.
    func create() async -> Int? {
        guard let body = draft.createRequest() else { return nil }
        isCreating = true
        defer { isCreating = false }
        do {
            let response: TripCreatePlanResponse =
                try await APIClient.shared.post("/trip-planner/plans", body: body)
            errorMessage = nil
            return response.plan.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
