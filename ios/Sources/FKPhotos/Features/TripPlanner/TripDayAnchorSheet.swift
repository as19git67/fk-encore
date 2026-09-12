import SwiftUI

/// Sending one day of the trip somewhere else (§4.5).
///
/// The case this exists for is the commonest holiday there is and could
/// not be said at all until now:
///
/// > Three days in an Airbnb in San Gimignano. One day out to Pisa, one
/// > to Florence. The rest of the time in San Gimignano.
///
/// One leg — the quarters never move, there is no transfer day, the
/// luggage stays put — and only the day goes elsewhere. Modelling it as
/// three legs would promise three hotels and three pools nothing slips
/// between, which is the opposite of what anybody means by it.
struct TripDayAnchorSheet: View {
    let dayLabel: String
    /// What the day says today, so the sheet can offer to undo it.
    let current: TripDayAnchor?
    let onSave: (TripPlace?) async -> Void

    @State private var finder = TripPlaceFinderModel()
    @State private var place: TripPlace?
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let place {
                        HStack {
                            Label(place.name, systemImage: "mappin.circle.fill").lineLimit(2)
                            Spacer()
                            Button("Ändern") { self.place = nil }
                                .buttonStyle(.borderless)
                                .font(.footnote)
                        }
                    } else {
                        TripPlaceFinderRows(model: finder, picked: nil) { picked in
                            place = picked
                        }
                    }
                } header: {
                    Text(dayLabel)
                } footer: {
                    // What it *does*, not that it is possible. The day
                    // is planned around this place and the drive is
                    // taken off its blocks — that is the whole point,
                    // and it is why the day gets shorter.
                    Text("Der Tag wird um diesen Ort herum geplant, statt um die Unterkunft. "
                         + "Hin- und Rückfahrt gehen von den Blöcken dieses Tages ab — eine "
                         + "Stunde hin und eine zurück heißt: sechs Stunden statt acht.")
                }

                if let current {
                    Section {
                        Button(role: .destructive) {
                            saving = true
                            Task {
                                await onSave(nil)
                                saving = false
                                dismiss()
                            }
                        } label: {
                            Label("Tagesziel entfernen", systemImage: "house")
                        }
                        .disabled(saving)
                    } footer: {
                        Text("Der Tag findet dann wieder rund um die Unterkunft statt. "
                             + "Bisher: \(current.summary).")
                    }
                }
            }
            .navigationTitle("Tagesziel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        saving = true
                        Task {
                            await onSave(place)
                            saving = false
                            dismiss()
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Sichern") }
                    }
                    .disabled(saving || place == nil)
                }
            }
        }
    }
}
