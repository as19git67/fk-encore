import SwiftUI

/// A new trip (reise-planen-und-unterwegs, "Ablauf 1"): the empty
/// itinerary with its plus, and "Neuer Aufenthalt" behind it.
///
/// Only the first stay is asked: where, from when, how long, how you
/// get about there and whether anything is booked. The name is not
/// asked — the itinerary, which opens next, suggests one. Further
/// stays, the journeys and home are added there, exactly as they are
/// changed later.
struct TripNewPlanView: View {
    @State private var model = TripNewPlanViewModel()
    @Environment(\.dismiss) private var dismiss
    @State private var confirmCancel = false
    /// "Neuer Aufenthalt", opened by the plus (mock "Ablauf 1").
    @State private var addingStay = false

    /// Handed the new plan's id, so the caller can open it.
    let onCreated: (Int) -> Void

    /// The empty itinerary: the trip has no stay, no date and no name
    /// yet, and the plus is the way in (reise-planen-und-unterwegs,
    /// "Ablauf 1"). The name is not asked: the itinerary suggests one
    /// once there is a stay.
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("noch ohne Datum")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .listRowSeparator(.hidden)

                Button {
                    addingStay = true
                } label: {
                    HStack(spacing: 12) {
                        // Centred on the text: the timeline's gutter sits
                        // its node at the top of a taller row.
                        Image(systemName: "plus.circle")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .frame(width: 24)
                            .accessibilityHidden(true)
                        Text("Aufenthalt hinzufügen")
                            .font(.headline)
                            .foregroundStyle(.tint)
                        Spacer()
                    }
                    .frame(minHeight: 56)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .listRowSeparator(.hidden)
            } footer: {
                Text("Ist Zuhause gesetzt, bietet der Reiseverlauf danach auch die Anreise an.")
            }
        }
        .listStyle(.plain)
        .navigationTitle("Neue Reise")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
        }
        .sheet(isPresented: $addingStay) {
            NavigationStack {
                stayForm
            }
        }
    }

    /// "Neuer Aufenthalt": Wo, Von, Wie lange, Bis, Vor Ort, Übernachtung.
    private var stayForm: some View {
        Form {
            placeSection
            lengthSection
            Section {
                Picker("Vor Ort", selection: $model.draft.stay.mode) {
                    ForEach(TripTransportMode.forPlaces, id: \.self) { mode in
                        Label(mode.label, systemImage: mode.systemImage).tag(mode)
                    }
                }
            }
            lodgingSection
            if !model.draft.isPlannable {
                Section {
                    EmptyView()
                } footer: {
                    // Why "Hinzufügen" is grey — said, not left to be guessed.
                    Label("Einen Ort aus der Suche antippen, dann lässt er sich hinzufügen.",
                          systemImage: "info.circle")
                }
            }
        }
        .navigationTitle("Neuer Aufenthalt")
        .plannerErrorBanner(model.errorMessage, dismiss: { model.errorMessage = nil })
        .navigationBarTitleDisplayMode(.inline)
        // A filled form is not thrown away by a swipe or a mis-tap.
        .interactiveDismissDisabled(model.isDirty)
        .confirmationDialog("Eingaben verwerfen?", isPresented: $confirmCancel,
                            titleVisibility: .visible) {
            Button("Verwerfen", role: .destructive) { addingStay = false }
            Button("Weiter bearbeiten", role: .cancel) {}
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") {
                    if model.isDirty { confirmCancel = true } else { addingStay = false }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task {
                        if let id = await model.create() {
                            addingStay = false
                            onCreated(id)
                            dismiss()
                        }
                    }
                } label: {
                    if model.isCreating {
                        ProgressView()
                    } else {
                        Text("Hinzufügen")
                    }
                }
                .disabled(!model.draft.isPlannable || model.isCreating)
            }
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
        } header: {
            Text("Wo?")
        } footer: {
            Text("Ein Ort oder gleich die Unterkunft. Hier fängt jeder Tag an und hört auf.")
        }
    }

    /// Nothing booked yet (§4.2).
    ///
    /// The concept has always allowed an anchor that is a zone rather
    /// than an address — "höchstens fünf Stationen vom Hauptplatz" —
    /// and the endpoint has always taken it. It simply had nowhere to
    /// be said. Saying it keeps the plan from claiming a precision it
    /// does not have.
    private var lodgingSection: some View {
        Section {
            Toggle("Noch nichts gebucht", isOn: $model.draft.stay.anchorIsApproximate)
        } header: {
            Text("Übernachtung")
        } footer: {
            Text(model.draft.stay.anchorIsApproximate
                 ? "Ohne Unterkunft ist die Mitte des Orts der Ausgangspunkt, und die App sucht "
                    + "im Umkreis von 15 km."
                 : "Die Unterkunft ist der Ort oben. Steht noch nichts fest, hier einschalten.")
        }
    }

    // MARK: - How long

    private var lengthSection: some View {
        Section {
            Toggle("Von: Datum steht fest", isOn: $model.draft.isDated)
            if model.draft.isDated {
                DatePicker("Von", selection: $model.draft.startDate, displayedComponents: .date)
            }
            Stepper(value: $model.draft.days,
                    in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                LabeledContent("Wie lange?", value: TripItineraryText.stayLength(days: model.draft.days))
            }
            if model.draft.isDated {
                LabeledContent("Bis") {
                    Text(lastDay.formatted(.dateTime.weekday(.abbreviated).day().month(.twoDigits).year()))
                        .foregroundStyle(.secondary)
                }
            }
        } footer: {
            Text("Das „Von“ ist der Beginn der Reise; „Bis“ ist gerechnet. Ohne Datum heißen die "
                 + "Tage „Tag 1“ bis „Tag n“, ein Datum lässt sich jederzeit nachtragen.")
        }
    }

    private var lastDay: Date {
        Calendar.current.date(byAdding: .day, value: max(0, model.draft.days - 1), to: model.draft.startDate)
            ?? model.draft.startDate
    }
}
