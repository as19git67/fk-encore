import SwiftUI

/// Putting something into the collection (§20, §9.2).
///
/// A sheet where there were two alerts, for a reason that had nothing
/// to do with looks: an alert holds text fields and nothing else, so
/// neither way in could ask **how long you stay** — and the server
/// refuses an entry it cannot give a duration to. A place OpenStreetMap
/// knows gets one from its category; a bench, a viewpoint, a bar down
/// an alley does not, and the answer was a rejected request that the
/// screen then hid behind its own empty state. "Merken" appeared to
/// work and the list stayed empty.
///
/// So the question is asked, once, in the same shape the share sheet
/// already asks it — and the note comes along, because what somebody
/// wrote next to a place is the half that decides an afternoon (§20.1).
struct TripIdeaCaptureSheet: View {
    /// What is being collected, in the title: "Das hier merken" for the
    /// spot you are standing on, the place's name for a shared link.
    let title: String
    /// One line on what will be stored — the coordinate you are on, or
    /// the link the place came from. Said before it happens.
    let explanation: String
    /// Returns whether it worked. The sheet stays open on failure, so
    /// the error is read where the tap happened rather than as a line
    /// somewhere in the list behind.
    let onSave: (_ note: String, _ dwellMinutes: Int) async -> Bool

    @State private var note = ""
    @State private var dwellMinutes = TripIdeaCaptureSheet.defaultDwellMinutes
    @State private var saving = false
    @State private var failed = false
    @Environment(\.dismiss) private var dismiss

    /// Three quarters of an hour: long enough for a café or a small
    /// museum room, short enough that nobody's afternoon is eaten by an
    /// entry they never thought about. The same figure the share sheet
    /// starts from, so the two ways in do not disagree.
    static let defaultDwellMinutes = 45

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Notiz (optional)", text: $note, axis: .vertical)
                        .lineLimit(2...4)
                } footer: {
                    Text(explanation)
                }

                Section {
                    Stepper(value: $dwellMinutes, in: 5...480, step: 5) {
                        Text("Aufenthalt: \(dwellMinutes) Min.")
                    }
                } header: {
                    Text("Aufenthaltsdauer")
                } footer: {
                    // Why it is asked rather than guessed, and what
                    // happens to the answer.
                    Text("Wie lange ihr voraussichtlich bleibt. Kennt OpenStreetMap den Ort "
                         + "nicht, ist das die einzige Angabe dazu — später planbar bleibt der "
                         + "Eintrag nur mit einer.")
                }

                if failed {
                    Section {
                        Label("Das ließ sich nicht speichern. Noch einmal versuchen?",
                              systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        saving = true
                        Task {
                            let ok = await onSave(note, dwellMinutes)
                            saving = false
                            if ok { dismiss() } else { failed = true }
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Merken") }
                    }
                    .disabled(saving)
                }
            }
        }
    }
}
