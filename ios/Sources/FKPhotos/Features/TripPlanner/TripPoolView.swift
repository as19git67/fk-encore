import SwiftUI

/// The pool — everything this leg could do, and why (§5).
///
/// It was data from the planner's first day and visible nowhere; then
/// it became a list you could look at and nothing else. That was the
/// wrong half to stop at: with four ways in (§9.2) a pile that only
/// grows is not a pool, it is a backlog. Three things were missing and
/// each of them is a gesture somebody reaches for immediately —
/// *where is that*, *not this one*, and *put it in Tuesday morning*.
///
/// The placement deliberately goes through a picker rather than a drag.
/// Dragging out of one screen into a day that is not on screen is not a
/// gesture iOS has; a picker also says out loud which day and which
/// block, which is the part that has consequences for the budget.
struct TripPoolView: View {
    @State var viewModel: TripPlannerViewModel
    /// Which leg's pool. Held as a position rather than as the leg so
    /// the list follows the plan after a placement rewrites it.
    let legIndex: Int

    @State private var query = ""
    @State private var placing: TripCandidate?

    private var leg: TripLeg? {
        viewModel.plan?.legs.first { $0.position == legIndex }
    }

    var body: some View {
        List {
            if let leg {
                if leg.pool.isEmpty {
                    ContentUnavailableView(
                        "Der Vorrat ist leer",
                        systemImage: "tray",
                        description: Text("Was der Planer findet und was ihr selbst beisteuert, "
                                          + "sammelt sich hier."),
                    )
                } else if matches(in: leg).isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    Section {
                        ForEach(matches(in: leg)) { candidate in
                            row(candidate, leg: leg)
                        }
                    } header: {
                        Text(countLabel(leg))
                    } footer: {
                        Text("Der Planer wählt aus dem Vorrat, was in einen Block passt. "
                             + "Was hier liegt, ist nicht verplant — es steht bereit.")
                    }
                }
            } else {
                ContentUnavailableView("Etappe nicht gefunden", systemImage: "tray")
            }
        }
        .navigationTitle("Vorrat")
        .navigationBarTitleDisplayMode(.inline)
        // A pool of a hundred and fifty candidates is what the planner
        // routinely produces; scrolling it to find the one somebody
        // mentioned at breakfast is not a plan.
        .searchable(text: $query, prompt: "Im Vorrat suchen")
        .sheet(item: $placing) { candidate in
            NavigationStack {
                TripPlacePickerView(leg: leg, candidate: candidate) { blockId, dayIndex in
                    await viewModel.place(candidate, inBlock: blockId, onDay: dayIndex)
                    placing = nil
                }
            }
        }
        .task { if viewModel.plan == nil { await viewModel.load() } }
    }

    /// Name, category and note all count as the thing you remember.
    ///
    /// The note especially: "beste Pastéis laut Blog" is often the only
    /// part of a find anybody recalls, and a search that ignored it
    /// would miss exactly the entries a person added by hand (§9.2).
    private func matches(in leg: TripLeg) -> [TripCandidate] {
        let sorted = leg.pool.sorted {
            $0.score != $1.score ? $0.score > $1.score : $0.displayName < $1.displayName
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return sorted }
        return sorted.filter { candidate in
            [candidate.displayName, TripCategory.label(candidate.category), candidate.note ?? ""]
                .contains { $0.lowercased().contains(needle) }
        }
    }

    private func countLabel(_ leg: TripLeg) -> String {
        let shown = matches(in: leg).count
        if shown == leg.pool.count {
            return leg.pool.count == 1 ? "1 Kandidat" : "\(leg.pool.count) Kandidaten"
        }
        return "\(shown) von \(leg.pool.count)"
    }

    private func plannedRefs(_ leg: TripLeg) -> Set<String> {
        Set(leg.days.flatMap { $0.blocks }.flatMap { $0.stops }.map(\.osmRef))
    }

    @ViewBuilder
    private func row(_ candidate: TripCandidate, leg: TripLeg) -> some View {
        NavigationLink {
            TripSpotDetailView(spot: TripSpotDetail(candidate), mode: leg.transportMode) {
                Section {
                    Button {
                        placing = candidate
                    } label: {
                        Label("In einen Block setzen", systemImage: "calendar.badge.plus")
                    }
                    Button(role: .destructive) {
                        Task { await viewModel.drop(candidate) }
                    } label: {
                        Label("Aus dem Vorrat entfernen", systemImage: "trash")
                    }
                } footer: {
                    Text("Entfernen heißt „nicht dieser“. Beim nächsten Neuplanen kann der "
                         + "Planer ihn wiederfinden — er liegt ja weiterhin in der Gegend.")
                }
            }
        } label: {
            label(candidate, leg: leg)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { await viewModel.drop(candidate) }
            } label: {
                Label("Entfernen", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                placing = candidate
            } label: {
                Label("Einplanen", systemImage: "calendar.badge.plus")
            }
            .tint(.accentColor)
        }
    }

    @ViewBuilder
    private func label(_ candidate: TripCandidate, leg: TripLeg) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label {
                    Text(candidate.displayName).font(.headline)
                } icon: {
                    Image(systemName: TripCategory.symbol(candidate.category))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(TripClock.duration(candidate.dwellMinutes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // What somebody wrote next to it, which is the part that
            // actually decides an afternoon (§9.2).
            if let note = candidate.note, !note.isEmpty {
                Text(note).font(.caption).italic()
            }

            // Already in a day. Said rather than hidden — the same rule
            // the search follows, because a silently shorter list reads
            // as "not in the data".
            if plannedRefs(leg).contains(candidate.osmRef) {
                Label("schon eingeplant", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // "Warum hier?" — a suggestion carries its reasons (§3.8, §8.3).
            ForEach(candidate.reasons, id: \.self) { reason in
                Text("· \(reason)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Which day, and which block (§8.4).
///
/// Both questions are asked out loud because both have a consequence:
/// the block is what gets a budget spent on it, and only a day that has
/// actually been planned can take a spot at all — a day still at trip
/// resolution has a frame and nothing in it (§4.3), and half-filling
/// one behind the traveller's back is worse than saying so.
struct TripPlacePickerView: View {
    let leg: TripLeg?
    let candidate: TripCandidate
    let place: (String, Int) async -> Void

    @State private var isPlacing = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            ForEach(leg?.days ?? []) { day in
                Section {
                    if day.detailed {
                        ForEach(day.blocks.filter { $0.kind == "spots" }) { block in
                            Button {
                                isPlacing = true
                                Task {
                                    await place(block.id, day.dayIndex)
                                    isPlacing = false
                                }
                            } label: {
                                HStack {
                                    Text(block.label)
                                    Spacer()
                                    Text(TripClock.duration(block.budgetMinutes - block.usedMinutes)
                                         + " frei")
                                        .font(.caption)
                                        // Over budget is shown, not
                                        // prevented (§8.4).
                                        .foregroundStyle(block.usedMinutes > block.budgetMinutes
                                                         ? .red : .secondary)
                                }
                            }
                            .disabled(isPlacing)
                        }
                    } else {
                        Text("Dieser Tag ist noch nicht ausgeplant.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Tag \(day.dayIndex + 1)")
                }
            }
        }
        .navigationTitle(candidate.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
        }
    }
}
