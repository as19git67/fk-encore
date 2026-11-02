import SwiftUI

/// A new trip (§4.2, §25, plan "Reiseverlauf" stage 3): only what it
/// needs to exist.
///
/// A name, the first place, how long and from when. Everything else —
/// the way there, further stays and the journeys between them, how the
/// group gets about, who comes along, the pace, what counts — is done
/// afterwards exactly as it is changed later: in the itinerary, which
/// "Planen" opens next, and in the trip's settings. The form once asked
/// for all of it at once, plus a sentence a model would read; a trip
/// that could be created in four fields took a screenful, and the
/// screenful was not where anybody changed those things afterwards.
struct TripNewPlanView: View {
    @State private var model = TripNewPlanViewModel()
    @Environment(\.dismiss) private var dismiss
    @State private var confirmCancel = false

    /// Handed the new plan's id, so the caller can open it.
    let onCreated: (Int) -> Void

    var body: some View {
        Form {
            // Only what a trip needs to exist (§25): a name, the first
            // place, how long. The way there, further stays, the
            // journeys, how the group gets about — all of that is done
            // afterwards exactly as it is changed later, in the
            // itinerary this screen leads into.
            nameSection
            placeSection
            lengthSection
            if !model.draft.isPlannable {
                Section {
                    EmptyView()
                } footer: {
                    // Why "Planen" is grey — said, not left to be guessed.
                    Label("Einen Ort aus der Suche antippen, dann lässt sich planen.",
                          systemImage: "info.circle")
                }
            }
        }
        .navigationTitle("Neue Reise")
        .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        // A filled form is not thrown away by a swipe or a mis-tap.
        .interactiveDismissDisabled(model.isDirty)
        .confirmationDialog("Eingaben verwerfen?", isPresented: $confirmCancel,
                            titleVisibility: .visible) {
            Button("Verwerfen", role: .destructive) { dismiss() }
            Button("Weiter bearbeiten", role: .cancel) {}
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") {
                    if model.isDirty { confirmCancel = true } else { dismiss() }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task {
                        if let id = await model.create() {
                            onCreated(id)
                            dismiss()
                        }
                    }
                } label: {
                    if model.isCreating {
                        ProgressView()
                    } else {
                        Text("Planen")
                    }
                }
                .disabled(!model.draft.isPlannable || model.isCreating)
            }
        }
    }

    // MARK: - Name

    /// The trip's own name, first. It sat under "Wie lange?", which is
    /// not where anybody looks for it.
    private var nameSection: some View {
        Section {
            TextField("Name der Reise (optional)", text: $model.draft.title)
        } header: {
            Text("Name")
        } footer: {
            Text("Ohne Namen heißt die Reise nach ihrem ersten Aufenthalt.")
        }
    }

    // MARK: - Where

    /// Where the trip is based (§4.2).
    ///
    /// It says "Unterkunft" rather than "Wohin?" because that is what
    /// the value actually is: the hotel, the campsite, the friends'
    /// address — the point every day starts and ends at, and what the
    /// walking times are measured from. Asking for a city and planning
    /// from its centre is a different, worse trip, and the screen used
    /// to ask for one while storing the other.
    private var placeSection: some View {
        Section {
            TripPlaceFinderRows(model: model.finder, picked: model.draft.anchor) { place in
                model.pick(place)
            }
            if model.draft.anchor != nil {
                TextField("Name des Aufenthalts (optional)", text: $model.draft.stay.title)
                    .textInputAutocapitalization(.words)
                anchorZoneRows
            }
        } header: {
            Text("Wo? Die Unterkunft des ersten Aufenthalts")
        } footer: {
            Text("Hotel, Campingplatz oder Adresse — hier fängt jeder Tag an und hier endet "
                 + "er, und von hier aus werden die Wege gerechnet. Eine Stadt geht auch; "
                 + "dann plant der Planer um deren Mitte herum.")
        }
    }

    /// Nothing booked yet (§4.2).
    ///
    /// The concept has always allowed an anchor that is a zone rather
    /// than an address — "höchstens fünf Stationen vom Hauptplatz" —
    /// and the endpoint has always taken it. It simply had nowhere to
    /// be said. Saying it keeps the plan from claiming a precision it
    /// does not have.
    @ViewBuilder
    private var anchorZoneRows: some View {
        Toggle("Noch nichts gebucht", isOn: $model.draft.stay.anchorIsApproximate)
        if model.draft.stay.anchorIsApproximate {
            TripRadiusPicker(metres: $model.draft.stay.anchorRadiusM)
            Text("Der Planer rechnet mit der Mitte und zeigt die Unterkunft nicht als Adresse an.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - How long

    private var lengthSection: some View {
        Section {
            Stepper(value: $model.draft.days,
                    in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                Text(model.draft.days == 1 ? "1 Tag" : "\(model.draft.days) Tage")
            }
            Toggle("Termin steht fest", isOn: $model.draft.isDated)
            if model.draft.isDated {
                DatePicker("Erster Tag", selection: $model.draft.startDate,
                           displayedComponents: .date)
            }
        } header: {
            Text("Wie lange?")
        } footer: {
            // Where the rest is: "Planen" opens the itinerary, and the
            // arrival, the way there and how the group gets about are
            // said there, on the chain they belong to — not as a first
            // copy here and a second one later.
            Text("Nach „Planen“ öffnet sich der Reiseverlauf: dort stehen Anreise und "
                 + "Ankunft, weitere Aufenthalte und Weiterreisen und wie ihr vor Ort "
                 + "unterwegs seid. Tempo, Begleitung und wonach gesucht wird stehen in "
                 + "den Einstellungen der Reise.")
        }
    }
}
