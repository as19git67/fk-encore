import MapKit
import SwiftUI

/// Starting a trip — the screen that was missing.
///
/// The planner list said "Sag, wohin und wie lange" and then offered
/// nowhere to say it, so nothing else in the planner could be reached
/// at all. This is that place.
///
/// It is a **form first**, with the sentence as an accelerator below
/// it. That order is on purpose: the language model runs on the user's
/// own box and is regularly cold or unavailable, and a screen that can
/// only be used when a model answers is a screen that sometimes cannot
/// be used. What the sentence does is fill the same fields in, visibly,
/// so a misread sentence is a correction rather than a wrong trip
/// (§8.3).
struct TripNewPlanView: View {
    @State private var model = TripNewPlanViewModel()
    @Environment(\.dismiss) private var dismiss

    /// Handed the new plan's id, so the caller can open it.
    let onCreated: (Int) -> Void

    var body: some View {
        Form {
            placeSection
            routeSection
            lengthSection
            styleSection
            sentenceSection
            if let errorMessage = model.errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Neue Reise")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
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
                TextField("Stadt (optional)", text: $model.draft.legs[0].title)
                    .textInputAutocapitalization(.words)
                anchorZoneRows(for: 0)
            }
        } header: {
            Text("Unterkunft")
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
            Stepper(value: $model.draft.legs[index].anchorRadiusM, in: 300...10_000, step: 250) {
                Text("Ungefähr im Umkreis von \(model.draft.legs[index].anchorRadiusM) m")
            }
            Text("Der Planer rechnet mit der Mitte und zeigt die Unterkunft nicht als Adresse an.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Further cities

    /// The rest of the route (§4.2).
    ///
    /// Kept below the first city rather than turning the screen into a
    /// list of equals: most trips have one city, and a screen that asks
    /// "how many cities?" first makes the common case pay for the rare
    /// one. Adding the second one is one tap away, and from then on the
    /// two read alike.
    private var routeSection: some View {
        Section {
            // Addressed by identity, never by index. A row bound to
            // `legs[2]` keeps that index after the list shrinks, and
            // SwiftUI evaluates a pushed destination once more on the
            // way out — which is a crash rather than a stale screen.
            ForEach(model.draft.legs.dropFirst()) { leg in
                NavigationLink {
                    TripDraftLegView(
                        leg: model.binding(for: leg.id),
                        position: model.position(of: leg.id) ?? 1,
                        previousName: model.legBefore(leg.id)?.place?.name,
                    )
                } label: {
                    legRow(leg, position: model.position(of: leg.id) ?? 1)
                }
            }
            .onDelete { offsets in
                // These index the *displayed* rows, which start at the
                // second city — so offset 0 is `legs[1]`.
                model.removeLegs(displayedAt: offsets)
            }

            Button {
                model.addLeg()
            } label: {
                Label("Noch eine Stadt", systemImage: "plus.circle")
            }
            .disabled(model.draft.legs.count >= TripNewPlanDraft.maxLegs)
        } header: {
            Text("Weiter nach")
        } footer: {
            Text("Jede Stadt hat ihren eigenen Ausgangspunkt, ihre eigene Länge und ihr "
                 + "eigenes Verkehrsmittel. Die Fahrt dazwischen kürzt beide Tage: der "
                 + "Abreisetag hat keinen Abend, der Ankunftstag keinen Vormittag.")
        }
    }

    private func legRow(_ leg: TripDraftLeg, position: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(leg.place?.name ?? "Stadt \(position + 1) — noch offen")
                .foregroundStyle(leg.place == nil ? .secondary : .primary)
            HStack(spacing: 6) {
                Text(leg.days == 1 ? "1 Tag" : "\(leg.days) Tage")
                Text("·")
                Label(leg.mode.label, systemImage: leg.mode.systemImage)
                    .labelStyle(.titleAndIcon)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - How long

    private var lengthSection: some View {
        Section("Wie lange?") {
            Stepper(value: $model.draft.days,
                    in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                Text(model.draft.days == 1 ? "1 Tag" : "\(model.draft.days) Tage")
            }
            TextField("Name der Reise (optional)", text: $model.draft.title)
            Toggle("Termin steht fest", isOn: $model.draft.isDated)
            if model.draft.isDated {
                DatePicker("Erster Tag", selection: $model.draft.startDate,
                           displayedComponents: .date)
            }
            arrivalRows(for: 0)
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

    private var styleSection: some View {
        Section {
            Picker("Tempo", selection: $model.draft.pace) {
                ForEach(TripPace.allCases, id: \.self) { pace in
                    Text(pace.label).tag(pace)
                }
            }
            Picker("Unterwegs", selection: $model.draft.mode) {
                ForEach(TripTransportMode.allCases, id: \.self) { mode in
                    Label(mode.label, systemImage: mode.systemImage).tag(mode)
                }
            }
            Text(model.draft.mode.hint)
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle("Mit Kind", isOn: $model.draft.withChildren)
            Toggle("Schlecht zu Fuß", isOn: $model.draft.limitedMobility)
        } header: {
            Text("Wie?")
        } footer: {
            Text("Verkehrsmittel, Tempo und Begleitung bestimmen, wie viel an einem Tag "
                 + "Platz hat. Alles davon lässt sich später in den Einstellungen ändern.")
        }
    }

    // MARK: - The sentence

    private var sentenceSection: some View {
        Section {
            TextField("„Vier Tage Lissabon, mit Kind, eher gemütlich“",
                      text: $model.sentence, axis: .vertical)
                .lineLimit(2...4)
            Button {
                Task { await model.interpretSentence() }
            } label: {
                if model.isInterpreting {
                    HStack { ProgressView(); Text("Wird gelesen…") }
                } else {
                    Label("Satz übernehmen", systemImage: "text.magnifyingglass")
                }
            }
            .disabled(model.sentence.trimmingCharacters(in: .whitespaces).isEmpty
                      || model.isInterpreting)

            if let unavailable = model.interpretUnavailable {
                Text("Der Satz konnte nicht gelesen werden: \(unavailable)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            // Everything the model proposed and the server would not
            // take. Shown, never swallowed — a silently reduced plan is
            // worse than a visible misunderstanding.
            ForEach(model.rejected, id: \.self) { note in
                Label(note, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Oder in einem Satz")
        } footer: {
            Text("Der Satz füllt die Felder oben aus — den Ort bestätigst du auf der Karte.")
        }
    }
}
