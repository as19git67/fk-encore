import SwiftUI

/// A new trip (§4.2, §25): only what it needs to exist.
///
/// A name, the first place, how long and from when, how it gets about.
/// Everything else — further legs and journeys, who comes along, the
/// pace, what counts — is done afterwards exactly as it is changed
/// later: in the leg strip and the trip's settings. The form once asked
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
            // place, how long, how it gets about. Further legs,
            // journeys, who comes, what counts — all of that is done
            // afterwards exactly as it is changed later, in the leg
            // strip and the trip's settings.
            nameSection
            placeSection
            lengthSection
            modeSection
            if !model.draft.isPlannable {
                Section {
                    EmptyView()
                } footer: {
                    // Why "Planen" is grey — said, not left to be guessed.
                    Label("Für jede Stadt einen Ort aus der Suche antippen, dann lässt sich planen.",
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
            Text("Ohne Namen heißt die Reise nach ihren Städten.")
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
                TextField("Name der Stadt (optional)", text: $model.draft.legs[0].title)
                    .textInputAutocapitalization(.words)
                anchorZoneRows(for: 0)
            }
        } header: {
            Text("Wo? Die Unterkunft der ersten Stadt")
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
    private func anchorZoneRows(for index: Int) -> some View {
        Toggle("Noch nichts gebucht", isOn: $model.draft.legs[index].anchorIsApproximate)
        if model.draft.legs[index].anchorIsApproximate {
            TripRadiusPicker(metres: $model.draft.legs[index].anchorRadiusM)
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
                Text(model.draft.legs.count > 1
                     ? "Erste Stadt: \(model.draft.days == 1 ? "1 Tag" : "\(model.draft.days) Tage")"
                     : (model.draft.days == 1 ? "1 Tag" : "\(model.draft.days) Tage"))
            }
            Toggle("Termin steht fest", isOn: $model.draft.isDated)
            if model.draft.isDated {
                DatePicker("Erster Tag", selection: $model.draft.startDate,
                           displayedComponents: .date)
            }
            arrivalRows(for: 0)
        } header: {
            Text("Wie lange?")
        } footer: {
            if model.draft.legs.count > 1 {
                // The stepper above is the first city's; the trip is the
                // sum, and nothing said so.
                Text("Insgesamt \(model.draft.totalDays) Tage über \(model.draft.legs.count) Städte. "
                     + "Die Länge jeder weiteren Stadt steht bei der Stadt.")
            }
        }
    }

    /// When the group actually gets there (§4.2).
    ///
    /// Without it day one gets a full Vormittag for a city the group
    /// reaches at two in the afternoon — the planner cannot know, and
    /// what it plans instead is a morning nobody has. Independent of
    /// when the room is ready: arriving and checking in are two
    /// different times, and this is the one the day is built on.
    @ViewBuilder
    private func arrivalRows(for index: Int) -> some View {
        Toggle("Ankunft ist bekannt", isOn: Binding(
            get: { model.draft.legs[index].arriveAt != nil },
            set: { on in
                model.draft.legs[index].arriveAt = on
                    ? (model.draft.legs[index].arriveAt ?? Self.defaultArrival)
                    : nil
            },
        ))
        if let arrival = model.draft.legs[index].arriveAt {
            DatePicker("Ankunft am ersten Tag", selection: Binding(
                get: { arrival },
                set: { model.draft.legs[index].arriveAt = $0 },
            ), displayedComponents: .hourAndMinute)
        }
    }

    private static var defaultArrival: Date {
        Calendar.current.date(bySettingHour: 14, minute: 0, second: 0, of: Date()) ?? Date()
    }

    // MARK: - How

    private var modeSection: some View {
        Section {
            TripTransportModePicker(mode: $model.draft.mode)
        } header: {
            Text("Wie unterwegs?")
        } footer: {
            Text("Gilt für diese Stadt; jede weitere kann ihr eigenes Verkehrsmittel haben. "
                 + "Tempo, Begleitung und wonach gesucht wird stehen danach in den Einstellungen "
                 + "der Reise.")
        }
    }
}
