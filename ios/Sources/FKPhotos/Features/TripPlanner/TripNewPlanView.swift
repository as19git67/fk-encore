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

    private var placeSection: some View {
        Section {
            TripPlaceFinderRows(model: model.finder, picked: model.draft.anchor) { place in
                model.pick(place)
            }
        } header: {
            Text("Wohin?")
        } footer: {
            // Saying why the pin matters beats a plan quietly anchored
            // in the wrong Springfield.
            Text("Der Ort ist der Ausgangspunkt: von hier aus werden die Tage geplant.")
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
            ForEach(Array(model.draft.legs.enumerated().dropFirst()), id: \.element.id) { pair in
                NavigationLink {
                    TripDraftLegView(
                        leg: Binding(
                            get: { model.draft.legs[pair.offset] },
                            set: { model.draft.legs[pair.offset] = $0 },
                        ),
                        position: pair.offset,
                        previousName: model.draft.legs[pair.offset - 1].place?.name,
                    )
                } label: {
                    legRow(pair.element, position: pair.offset)
                }
            }
            .onDelete { offsets in
                for index in offsets.sorted(by: >) { model.removeLeg(at: index) }
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
        }
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
