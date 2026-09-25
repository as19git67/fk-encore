import SwiftUI

/// "Which block?" — the one screen that answers it (§8.4).
///
/// Shared by the pool (placing a candidate) and the day plan (moving a
/// planned stop), because these were three different gestures for one
/// decision: the pool offered a picker, the day plan offered nothing,
/// and the list on the since-merged "Unterwegs" screen offered a menu
/// that included the block the stop was already in.
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
    /// Answers whether the move happened. The sheet closes only then;
    /// it used to close either way, leaving the spot where it was with
    /// nothing said.
    let choose: (String, Int) async -> Bool

    @State private var isWorking = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    init(
        title: String,
        leg: TripLeg?,
        current: (dayIndex: Int, blockId: String)? = nil,
        choose: @escaping (String, Int) async -> Bool,
    ) {
        self.title = title
        self.leg = leg
        self.current = current
        self.choose = choose
    }

    /// The moment the picker is opened: what is past then stays out
    /// of the list. Read once — a sheet that loses a block while it is
    /// open would be worse than one that is a minute out of date.
    private let now = Date()

    /// The days still ahead, today included. Yesterday is not a place
    /// a spot can go, and listing it as one was the trial's complaint.
    private var daysAhead: [TripDay] {
        guard let leg else { return [] }
        return leg.days.filter { !TripBlockTargets.isPast($0.dayIndex, in: leg, now: now) }
    }

    var body: some View {
        List {
            if let leg, daysAhead.count < leg.days.count {
                Text(daysAhead.isEmpty
                     ? "Die Reise ist vorbei — es gibt keinen Tag mehr, in den ein Stopp passt."
                     : "Vergangene Tage werden nicht angeboten.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            ForEach(daysAhead) { day in
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
                        let targets = TripBlockTargets.ofDay(day.dayIndex, in: leg, excluding: current, now: now)
                        if targets.isEmpty {
                            Text(current?.dayIndex == day.dayIndex
                                 ? "Hier steht der Stopp schon."
                                 : leg.flatMap { TripBlockTargets.todayIndex(in: $0, now: now) } == day.dayIndex
                                     ? "Heute ist kein Block mehr übrig."
                                     : "Kein Block, in den ein Stopp passt.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(targets) { target in
                            Button {
                                isWorking = true
                                Task {
                                    let ok = await choose(target.blockId, target.dayIndex)
                                    isWorking = false
                                    if ok {
                                        dismiss()
                                    } else {
                                        failure = "Das ließ sich nicht verschieben. Noch einmal versuchen?"
                                    }
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
        .plannerErrorBanner(failure, dismiss: { failure = nil })
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
        }
    }
}
