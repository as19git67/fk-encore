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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // The anti-pool: what this trip has turned down. It
                // belongs next to the pool rather than in the settings,
                // because it is the same question — what may the
                // planner offer? — with the opposite answer.
                NavigationLink {
                    TripHiddenSpotsView(viewModel: viewModel)
                } label: {
                    Label("Ausgeblendet", systemImage: "eye.slash")
                }
            }
        }
        .task { await viewModel.loadHiddenSpots() }
        // A pool of a hundred and fifty candidates is what the planner
        // routinely produces; scrolling it to find the one somebody
        // mentioned at breakfast is not a plan.
        .searchable(text: $query, prompt: "Im Vorrat suchen")
        .sheet(item: $placing) { candidate in
            NavigationStack {
                TripBlockPickerView(title: candidate.displayName, leg: leg) { blockId, dayIndex in
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
            TripSpotDetailView(
                spot: TripSpotDetail(candidate),
                mode: leg.transportMode,
                onSave: { await viewModel.saveNote($0) },
            ) { closeDetail in
                Section {
                    Button {
                        placing = candidate
                    } label: {
                        Label("In einen Block setzen", systemImage: "calendar.badge.plus")
                    }
                    if candidate.isManual {
                        // A find somebody brought in themselves is
                        // theirs to delete: it exists because a person
                        // added it, and nothing will propose it again.
                        Button(role: .destructive) {
                            Task {
                                await viewModel.drop(candidate)
                                closeDetail()
                            }
                        } label: {
                            Label("Aus dem Vorrat entfernen", systemImage: "trash")
                        }
                    } else {
                        Button(role: .destructive) {
                            Task {
                                await viewModel.hide(osmRef: candidate.osmRef)
                                closeDetail()
                            }
                        } label: {
                            Label("Für diese Reise ausblenden", systemImage: "eye.slash")
                        }
                    }
                } footer: {
                    Text(candidate.isManual
                         ? "Selbst hinzugefügt — entfernen heißt hier wirklich weg."
                         : "Ausblenden heißt „diesen nicht“: Der Planer schlägt ihn auf dieser "
                           + "Reise nicht mehr vor, auch beim nächsten Neuplanen nicht. "
                           + "Rückgängig oben unter „Ausgeblendet“.")
                }
            }
        } label: {
            label(candidate, leg: leg)
        }
        .swipeActions(edge: .trailing) {
            if candidate.isManual {
                Button(role: .destructive) {
                    Task { await viewModel.drop(candidate) }
                } label: {
                    Label("Entfernen", systemImage: "trash")
                }
            } else {
                Button(role: .destructive) {
                    Task { await viewModel.hide(osmRef: candidate.osmRef) }
                } label: {
                    Label("Ausblenden", systemImage: "eye.slash")
                }
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
                if candidate.isPhotoStop {
                    Image(systemName: "camera.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Fotostopp")
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

/// What this trip has turned down, and the way back (§5).
///
/// A "no" you cannot take back is a deletion wearing a friendlier word,
/// so the list exists for the same reason the hiding does: the spot is
/// still out there, only the answer is kept.
struct TripHiddenSpotsView: View {
    @State var viewModel: TripPlannerViewModel

    var body: some View {
        List {
            if viewModel.hiddenSpots.isEmpty {
                ContentUnavailableView(
                    "Nichts ausgeblendet",
                    systemImage: "eye",
                    description: Text("Was ihr für diese Reise ausblendet, steht hier — und "
                                      + "lässt sich von hier aus wieder einblenden."),
                )
            } else {
                Section {
                    ForEach(viewModel.hiddenSpots) { hidden in
                        HStack {
                            Text(hidden.displayName)
                            Spacer()
                            Button("Einblenden") {
                                Task { await viewModel.unhide(osmRef: hidden.osmRef) }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                } footer: {
                    // Said plainly, because "einblenden" could be read
                    // as "put it back on Tuesday morning".
                    Text("Eingeblendet heißt: Der Planer darf ihn wieder vorschlagen. Auf den "
                         + "Plan kommt er dadurch nicht — das entscheidet die nächste Planung "
                         + "oder ihr selbst.")
                }
            }
        }
        .navigationTitle("Ausgeblendet")
        .navigationBarTitleDisplayMode(.inline)
        .task { await viewModel.loadHiddenSpots() }
    }
}
