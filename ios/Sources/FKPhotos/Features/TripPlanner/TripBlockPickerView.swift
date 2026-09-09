import SwiftUI

/// "Which block?" — the one screen that answers it (§8.4).
///
/// Shared by the pool (placing a candidate), the day plan and
/// "Unterwegs" (moving a planned stop), because these were three
/// different gestures for one decision: the pool offered a picker, the
/// day plan offered nothing, and the list offered a menu that included
/// the block the stop was already in.
///
/// Both questions — which day, which block — are asked out loud,
/// because both have a consequence: the block is what gets a budget
/// spent on it, and only a day that has actually been planned can take
/// a spot at all.
///
/// It shows what each block has left rather than refusing a full one:
/// an overfull block is shown in red and still accepts the drop — the
/// traveller put it there deliberately, and a red block says more than
/// a rejected gesture (§8.4).
struct TripBlockPickerView: View {
    let title: String
    let leg: TripLeg?
    /// Where the spot is now, so its own block is not offered back to
    /// it. Nil when it is nowhere yet — a candidate from the pool.
    let current: (dayIndex: Int, blockId: String)?
    let choose: (String, Int) async -> Void

    @State private var isWorking = false
    @Environment(\.dismiss) private var dismiss

    init(
        title: String,
        leg: TripLeg?,
        current: (dayIndex: Int, blockId: String)? = nil,
        choose: @escaping (String, Int) async -> Void,
    ) {
        self.title = title
        self.leg = leg
        self.current = current
        self.choose = choose
    }

    var body: some View {
        List {
            ForEach(leg?.days ?? []) { day in
                Section {
                    if !day.detailed {
                        // A day at trip resolution has a frame and no
                        // stops (§4.3) — said out loud rather than
                        // left off the list, so the day is not simply
                        // missing.
                        Text("Dieser Tag ist noch nicht ausgeplant.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        let targets = TripBlockTargets.ofDay(day.dayIndex, in: leg, excluding: current)
                        if targets.isEmpty {
                            Text(current?.dayIndex == day.dayIndex
                                 ? "Hier steht der Spot schon."
                                 : "Kein Block, in den ein Spot passt.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(targets) { target in
                            Button {
                                isWorking = true
                                Task {
                                    await choose(target.blockId, target.dayIndex)
                                    isWorking = false
                                }
                            } label: {
                                HStack {
                                    Text(target.label)
                                    Spacer()
                                    Text(target.isOverfull
                                         ? TripClock.duration(-target.freeMinutes) + " zu viel"
                                         : TripClock.duration(target.freeMinutes) + " frei")
                                        .font(.caption)
                                        .foregroundStyle(target.isOverfull ? .red : .secondary)
                                }
                            }
                            .disabled(isWorking)
                        }
                    }
                } header: {
                    Text("Tag \(day.dayIndex + 1)")
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
        }
    }
}
