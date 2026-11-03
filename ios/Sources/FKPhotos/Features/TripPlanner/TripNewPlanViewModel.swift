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

    /// The interest vocabulary, from the server. Empty until loaded and
    /// silently empty on failure: the form works without the section.
    private(set) var interestOptions: [TripInterestOption] = []

    func loadInterests() async {
        struct Response: Decodable { let interests: [TripInterestOption] }
        do {
            let response: Response = try await APIClient.shared.get("/trip-planner/interests")
            interestOptions = response.interests
            // Every line on to begin with: the list is a filter, and a
            // new trip searches everything until somebody narrows it.
            if draft.interests.isEmpty {
                draft.interests = interestOptions.map(\.id)
            }
        } catch {
            interestOptions = []
        }
    }

    /// Has the selection been narrowed from "everything"?
    private var interestsNarrowed: Bool {
        !draft.interests.isEmpty && Set(draft.interests) != Set(interestOptions.map(\.id))
    }

    /// Has anything been typed or picked? Decides whether "Abbrechen"
    /// asks first.
    var isDirty: Bool {
        draft.anchor != nil
            || !draft.title.trimmingCharacters(in: .whitespaces).isEmpty
            || !sentence.trimmingCharacters(in: .whitespaces).isEmpty
            || interestsNarrowed
    }

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
            interpretUnavailable = TripErrorText.describe(error)
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
            errorMessage = TripErrorText.describe(error)
            return nil
        }
    }
}
