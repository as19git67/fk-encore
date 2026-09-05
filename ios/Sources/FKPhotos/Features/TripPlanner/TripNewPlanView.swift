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
            HStack {
                TextField("Stadt oder Ort", text: $model.placeQuery)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { model.searchPlaces() }
                if model.isSearching {
                    ProgressView()
                } else {
                    Button("Suchen") { model.searchPlaces() }
                        .buttonStyle(.borderless)
                        .disabled(model.placeQuery.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            ForEach(model.searchResults, id: \.self) { place in
                Button {
                    model.pick(place)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(place.name).foregroundStyle(.primary)
                        if let subtitle = place.subtitle {
                            Text(subtitle).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if model.searchFailed {
                Text("Die Ortssuche hat nicht geantwortet. Noch einmal versuchen?")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let anchor = model.draft.anchor {
                pickedPlace(anchor)
            }
        } header: {
            Text("Wohin?")
        } footer: {
            // Saying why the pin matters beats a plan quietly anchored
            // in the wrong Springfield.
            Text("Der Ort ist der Ausgangspunkt: von hier aus werden die Tage geplant.")
        }
    }

    private func pickedPlace(_ anchor: TripPlace) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(anchor.name, systemImage: "mappin.circle.fill")
                .font(.headline)
            Map(initialPosition: .region(MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: anchor.latitude,
                                               longitude: anchor.longitude),
                latitudinalMeters: 4_000,
                longitudinalMeters: 4_000,
            ))) {
                Marker(anchor.name, coordinate: CLLocationCoordinate2D(
                    latitude: anchor.latitude, longitude: anchor.longitude))
            }
            .frame(height: 160)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .allowsHitTesting(false)
        }
        .padding(.vertical, 4)
    }

    // MARK: - How long

    private var lengthSection: some View {
        Section("Wie lange?") {
            Stepper(value: $model.draft.days,
                    in: TripNewPlanDraft.minDays...TripNewPlanDraft.maxDays) {
                Text(model.draft.days == 1 ? "1 Tag" : "\(model.draft.days) Tage")
            }
            TextField("Name der Reise (optional)", text: $model.draft.title)
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
            Toggle("Mit Kind", isOn: $model.draft.withChildren)
            Toggle("Schlecht zu Fuß", isOn: $model.draft.limitedMobility)
        } header: {
            Text("Wie?")
        } footer: {
            Text("Tempo und Begleitung bestimmen, wie viel an einem Tag Platz hat.")
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
