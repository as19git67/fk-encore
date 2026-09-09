import SwiftUI

/// The shape of a day, as something you can change (§4.1).
///
/// The four-part day is a **default**, not an enumeration: "jeder
/// einzelne lässt sich umbenennen, teilen, zusammenlegen oder
/// streichen". Until this screen there was no way to say any of it
/// after a trip was created, so a family that never stops for a
/// sit-down lunch carried a ninety-minute meal block through a
/// fortnight.
///
/// The whole day is sent at once rather than one edit at a time,
/// because a day *is* the ordered list — and because a sequence of
/// per-block saves would leave moments in between where the day makes
/// no sense.
struct TripDayShapeView: View {
    let planId: Int
    /// Called after a successful save, so the day screen reloads.
    let onSaved: () -> Void

    @State private var blocks: [Block] = []
    @State private var loaded = false
    @State private var saving = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    /// One block on the way in or out. `id` is empty for a block
    /// somebody just added — the server makes one from the name, and
    /// that keeps a rename from silently detaching everything that
    /// pointed at the old id.
    struct Block: Codable, Identifiable, Hashable {
        var id: String
        var label: String
        var kind: String
        var baseBudgetMinutes: Int

        var isMeal: Bool { kind == "meal" }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach($blocks) { $block in
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("Name des Blocks", text: $block.label)

                            // Both controls get an explicit width of
                            // their own: a Stepper and a Toggle each
                            // claim the full row by default, and side
                            // by side in one column the switch ran into
                            // the minus.
                            HStack {
                                Text("Dauer")
                                Spacer(minLength: 12)
                                Text(TripClock.duration(block.baseBudgetMinutes))
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                                Stepper("", value: $block.baseBudgetMinutes,
                                        in: 15...600, step: 15)
                                    .labelsHidden()
                            }

                            Toggle(isOn: Binding(
                                get: { block.isMeal },
                                set: { block.kind = $0 ? "meal" : "spots" },
                            )) {
                                // What the switch decides, not what it
                                // results in: the planner either fills
                                // this block with spots or keeps it
                                // free (§10.3).
                                VStack(alignment: .leading, spacing: 1) {
                                    Text("Pause — der Planer füllt sie nicht")
                                    Text("Hält nur Zeit frei. Unterwegs steht hier "
                                         + "„Essen in der Nähe“ statt Stopps.")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .onDelete { blocks.remove(atOffsets: $0) }
                    .onMove { blocks.move(fromOffsets: $0, toOffset: $1) }

                    Button {
                        blocks.append(Block(id: "", label: "", kind: "spots",
                                            baseBudgetMinutes: 120))
                    } label: {
                        Label("Block hinzufügen", systemImage: "plus")
                    }
                } header: {
                    Text("Der Tag")
                } footer: {
                    // What it is and what it is not: a frame, not a
                    // timetable (§4.1).
                    Text("Blöcke sind Etiketten mit einer Dauer, keine Uhrzeiten. Eine Pause "
                         + "bleibt leer: der Planer sucht kein Lokal aus (§10.3), das entscheidet "
                         + "ihr vor Ort.\n\nSpeichern plant die Tage neu.")
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Tagesablauf")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) { EditButton() }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if saving { ProgressView() } else { Text("Sichern") }
                    }
                    .disabled(saving || blocks.isEmpty)
                }
            }
            .task {
                guard !loaded else { return }
                loaded = true
                await load()
            }
        }
    }

    private func load() async {
        struct Response: Decodable {
            let blocks: [Block]
            let isDefault: Bool
        }
        do {
            let response: Response = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/blocks")
            blocks = response.blocks
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func save() async {
        struct Body: Encodable { let blocks: [Block] }
        struct Response: Decodable { let plan: TripPlan }
        saving = true
        defer { saving = false }
        do {
            let _: Response = try await APIClient.shared.patch(
                "/trip-planner/plans/\(planId)/blocks",
                body: Body(blocks: blocks.map { block in
                    Block(id: block.id,
                          label: block.label.trimmingCharacters(in: .whitespacesAndNewlines),
                          kind: block.kind,
                          baseBudgetMinutes: block.baseBudgetMinutes)
                }))
            onSaved()
            dismiss()
        } catch {
            // The server's refusals are sentences somebody can act on
            // ("mindestens ein Block muss Spots aufnehmen"), so they are
            // shown as they come.
            errorMessage = error.localizedDescription
        }
    }
}
