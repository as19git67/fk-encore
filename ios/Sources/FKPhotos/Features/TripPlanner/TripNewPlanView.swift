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
    @State private var confirmCancel = false
    /// The draft city about to be deleted (display offsets, see
    /// `removeLegs`). A filled-in city is not deleted by one swipe.
    @State private var removingOffsets: IndexSet?

    /// Handed the new plan's id, so the caller can open it.
    let onCreated: (Int) -> Void

    var body: some View {
        Form {
            nameSection
            placeSection
            routeSection
            lengthSection
            styleSection
            interestsSection
            sentenceSection
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
        .task { await model.loadInterests() }
        // A filled form is not thrown away by a swipe or a mis-tap.
        .interactiveDismissDisabled(model.isDirty)
        .confirmationDialog("Eingaben verwerfen?", isPresented: $confirmCancel,
                            titleVisibility: .visible) {
            Button("Verwerfen", role: .destructive) { dismiss() }
            Button("Weiter bearbeiten", role: .cancel) {}
        }
        .alert("Stadt entfernen?", isPresented: Binding(
            get: { removingOffsets != nil }, set: { if !$0 { removingOffsets = nil } })) {
            Button("Entfernen", role: .destructive) {
                if let offsets = removingOffsets { model.removeLegs(displayedAt: offsets) }
                removingOffsets = nil
            }
            Button("Abbrechen", role: .cancel) { removingOffsets = nil }
        } message: {
            Text("Ort, Länge und Zeiten dieser Stadt gehen verloren.")
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
                // second city — so offset 0 is `legs[1]`. Asked first
                // when the row already holds a place.
                let displayed = Array(model.draft.legs.dropFirst())
                let holdsSomething = offsets.contains {
                    displayed.indices.contains($0) && displayed[$0].place != nil
                }
                if holdsSomething { removingOffsets = offsets } else { model.removeLegs(displayedAt: offsets) }
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
            Text("Gilt für die ganze Reise; jede weitere Stadt kann ihr eigenes Verkehrsmittel "
                 + "haben. Verkehrsmittel, Tempo und Begleitung bestimmen, wie viel an einem Tag "
                 + "Platz hat. Alles davon lässt sich später in den Einstellungen ändern.")
        }
    }

    // MARK: - What counts

    /// The interests, as toggles — the same list the settings show.
    /// They used to be reachable at creation only through the sentence,
    /// which needs a model that is often asleep.
    @ViewBuilder
    private var interestsSection: some View {
        if !model.interestOptions.isEmpty {
            Section {
                ForEach(model.interestOptions) { option in
                    Toggle(option.label, isOn: Binding(
                        get: { model.draft.interests.contains(option.id) },
                        set: { on in
                            if on {
                                if !model.draft.interests.contains(option.id) {
                                    model.draft.interests.append(option.id)
                                }
                            } else {
                                model.draft.interests.removeAll { $0 == option.id }
                            }
                        },
                    ))
                }
            } header: {
                Text("Was zählt auf dieser Reise?")
            } footer: {
                Text("Angekreuztes bewertet der Planer höher — es schließt nichts aus.")
            }
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
