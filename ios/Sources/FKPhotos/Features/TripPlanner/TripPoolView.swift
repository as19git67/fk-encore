import SwiftUI

/// The pool — everything this leg could do, and why (§5).
///
/// It existed as data from the first day of the planner and was visible
/// nowhere: the only trace was "Warum hier?" on a stop already planned,
/// and the "Zurück in den Vorrat" line after a redistribution. Four
/// ways now lead into it (§9.2) and none of them led anywhere you could
/// look, which makes them hard to trust.
///
/// Read-only for now, deliberately. Putting a candidate into a specific
/// block is a decision the solver makes with a budget and a walking
/// distance in hand; a screen that let you drop one anywhere would
/// either duplicate that arithmetic or ignore it. What this does is the
/// half that is honest without it: show what is in there, why it
/// scored as it did, and what somebody wrote next to it.
struct TripPoolView: View {
    let leg: TripLeg

    var body: some View {
        List {
            if leg.pool.isEmpty {
                ContentUnavailableView(
                    "Der Vorrat ist leer",
                    systemImage: "tray",
                    description: Text("Was der Planer findet und was ihr selbst beisteuert, "
                                      + "sammelt sich hier."),
                )
            } else {
                Section {
                    ForEach(sorted) { candidate in
                        row(candidate)
                    }
                } header: {
                    Text(countLabel)
                } footer: {
                    Text("Der Planer wählt aus dem Vorrat, was in einen Block passt. "
                         + "Was hier liegt, ist nicht verplant — es steht bereit.")
                }
            }
        }
        .navigationTitle("Vorrat")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Best first, which is the order the solver considers them in.
    private var sorted: [TripCandidate] {
        leg.pool.sorted {
            $0.score != $1.score ? $0.score > $1.score : $0.displayName < $1.displayName
        }
    }

    private var countLabel: String {
        leg.pool.count == 1 ? "1 Kandidat" : "\(leg.pool.count) Kandidaten"
    }

    private var plannedRefs: Set<String> {
        Set(leg.days.flatMap { $0.blocks }.flatMap { $0.stops }.map(\.osmRef))
    }

    @ViewBuilder
    private func row(_ candidate: TripCandidate) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(candidate.displayName).font(.headline)
                Spacer()
                Text(TripClock.duration(candidate.dwellMinutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Already in a day. Said rather than hidden — the same rule
            // the search follows, because a silently shorter list reads
            // as "not in the data".
            if plannedRefs.contains(candidate.osmRef) {
                Label("schon eingeplant", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // "Warum hier?" — the concept insists a suggestion carries
            // its reasons (§3.8, §8.3), and this is where they live.
            ForEach(candidate.reasons, id: \.self) { reason in
                Text("· \(reason)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
