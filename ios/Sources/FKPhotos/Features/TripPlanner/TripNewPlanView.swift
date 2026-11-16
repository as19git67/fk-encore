import SwiftUI

/// A new trip (reise-planen-und-unterwegs, "Ablauf 1"; review B2): the
/// sheet "Neuer Aufenthalt" straight away, the same sheet the itinerary
/// opens for every further stay.
///
/// Only the first stay is asked: where, when, how long, how you get
/// about there and where the night is. The name is not asked — the
/// itinerary, which opens next, suggests one. Further stays, the
/// journeys and home are added there, exactly as they are changed later.
struct TripNewPlanView: View {
    @State private var model = TripNewPlanViewModel()
    /// The chain the sheet edits: one stay, nothing picked yet.
    @State private var start: (draft: TripItineraryDraft, stayId: TripItineraryItem.ID) = {
        var draft = TripItineraryDraft(startDate: nil, hasHome: false, items: [])
        let id = draft.insertStay(after: nil)
        return (draft, id)
    }()

    /// Handed the new plan's id, so the caller can open it.
    let onCreated: (Int) -> Void

    var body: some View {
        TripStaySheet(draft: start.draft, stayId: start.stayId, purpose: .new) { draft in
            guard let id = await model.create(from: draft, stayId: start.stayId) else {
                return model.errorMessage ?? "Die Reise ließ sich nicht anlegen."
            }
            onCreated(id)
            return nil
        }
    }
}
