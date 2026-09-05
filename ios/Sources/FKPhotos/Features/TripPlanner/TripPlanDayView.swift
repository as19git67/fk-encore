import SwiftUI

/// One day of a plan: a card per block, spots as compact rows with the
/// way between them, and a utilisation line underneath (§8.3).
///
/// Three things the concept asks for and this screen keeps:
///
///   - a block is a label and a budget, never a timetable — the rows
///     carry dwell times and walks, not clock times (§4.1);
///   - the hard times that *do* exist are shown as the frame they are,
///     above the blocks rather than inside them (§4.4);
///   - "Warum hier?" is one tap away on every spot. A plan nobody can
///     interrogate is a plan nobody trusts (§3.8).
struct TripPlanDayView: View {
    @State private var showSettings = false
    @State var viewModel: TripPlannerViewModel

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.plan == nil {
                ProgressView("Plan wird geladen…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let day = viewModel.day, let leg = viewModel.leg {
                content(day: day, leg: leg)
            } else if let message = viewModel.errorMessage {
                ContentUnavailableView("Plan nicht verfügbar", systemImage: "map", description: Text(message))
            } else {
                ContentUnavailableView("Kein Plan", systemImage: "map")
            }
        }
        .navigationTitle(viewModel.leg?.title ?? viewModel.plan?.title ?? "Plan")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let day = viewModel.day, let leg = viewModel.leg {
                // The map is the one thing reached often enough to earn
                // a button of its own; the rest live in a menu, because
                // five icons across a title bar is a puzzle.
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        TripDayMapView(day: day, anchor: leg.anchor)
                    } label: {
                        Label("Karte", systemImage: "map")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        NavigationLink {
                            TripTodayView(viewModel: viewModel)
                        } label: {
                            Label("Heute", systemImage: "sun.max")
                        }
                        // Everything this leg could do, and why (§5).
                        NavigationLink {
                            TripPoolView(leg: leg)
                        } label: {
                            Label("Vorrat (\(leg.pool.count))", systemImage: "tray.full")
                        }
                        // The way into the pool that needs nothing else
                        // — no share sheet, no map app, no model
                        // (§9.2, case 4).
                        NavigationLink {
                            TripPlaceSearchView(planId: viewModel.planId, legIndex: leg.position)
                        } label: {
                            Label("Ort suchen", systemImage: "magnifyingglass")
                        }
                        Divider()
                        Button {
                            showSettings = true
                        } label: {
                            Label("Einstellungen", systemImage: "slider.horizontal.3")
                        }
                    } label: {
                        Label("Mehr", systemImage: "ellipsis.circle")
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                TripPlanSettingsView(
                    planId: viewModel.planId,
                    constraints: viewModel.plan?.constraints,
                    title: viewModel.plan?.title,
                ) {
                    // Saving re-plans the days, so the screen behind has
                    // to be told rather than left showing the old ones.
                    Task { await viewModel.load() }
                }
            }
        }
        .task {
            await viewModel.load()
            watchStops()
        }
        .onDisappear { TripVisitMonitor.shared.stop() }
        .onChange(of: viewModel.dayIndex) { _, _ in watchStops() }
        .onChange(of: viewModel.legIndex) { _, _ in watchStops() }
    }

    /// Put geofences around the next stops of the day on screen (§7.1).
    ///
    /// Driven from the day view rather than started once at launch: the
    /// fences are only worth having around the day you are actually on,
    /// and re-deriving them when the day or leg changes is cheaper than
    /// keeping a second copy of "which day are we looking at".
    private func watchStops() {
        let stops = viewModel.stopsOfDay
        guard !stops.isEmpty else {
            TripVisitMonitor.shared.stop()
            return
        }
        TripVisitMonitor.shared.watch(
            planId: viewModel.planId,
            stops: stops,
            stopIdsByRef: Dictionary(stops.map { ($0.osmRef, $0.rowId) },
                                     uniquingKeysWith: { first, _ in first }),
        )
    }

    @ViewBuilder
    private func content(day: TripDay, leg: TripLeg) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                legHeader(leg)
                if !day.fixpoints.isEmpty {
                    fixpointBand(day.fixpoints)
                }
                if day.detailed {
                    ForEach(day.blocks) { block in
                        blockCard(block)
                    }
                } else {
                    tripResolutionCard(day)
                }
            }
            .padding()
        }
        .safeAreaInset(edge: .top) { dayPicker(leg) }
    }

    // MARK: - Header and navigation between days

    private func legHeader(_ leg: TripLeg) -> some View {
        HStack(spacing: 6) {
            Image(systemName: leg.transportMode.systemImage)
            Text(leg.transportMode.label)
            if leg.anchorRadiusM != nil {
                // An anchor zone is not an address. Saying so keeps the
                // plan from claiming a precision it does not have (§4.2).
                Text("· Unterkunft noch offen")
            }
            Spacer()
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private func dayPicker(_ leg: TripLeg) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(leg.days) { day in
                    Button {
                        viewModel.dayIndex = day.dayIndex
                    } label: {
                        VStack(spacing: 2) {
                            Text("Tag \(day.dayIndex + 1)")
                                .font(.subheadline.weight(day.dayIndex == viewModel.dayIndex ? .semibold : .regular))
                            // A day still at trip resolution is marked, so
                            // an empty-looking day never reads as a day
                            // with nothing to do (§4.3).
                            if !day.detailed {
                                Image(systemName: "circle.dashed")
                                    .font(.caption2)
                            }
                        }
                        .frame(minWidth: 56)
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(
                            day.dayIndex == viewModel.dayIndex
                                ? AnyShapeStyle(.tint.opacity(0.15))
                                : AnyShapeStyle(.clear),
                            in: .rect(cornerRadius: 10),
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    // MARK: - The frame

    private func fixpointBand(_ fixpoints: [TripFixpoint]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(fixpoints) { fix in
                HStack(spacing: 8) {
                    Image(systemName: fix.isDeparture ? "arrow.right.to.line" : "calendar.badge.clock")
                        .foregroundStyle(fix.isDeparture ? .orange : .secondary)
                    Text(fix.startsAt).monospacedDigit().font(.subheadline.weight(.semibold))
                    Text(fix.label).font(.subheadline)
                    Spacer()
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 12))
    }

    private func tripResolutionCard(_ day: TripDay) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Noch nicht im Detail geplant", systemImage: "circle.dashed")
                .font(.headline)
            Text("Der Rahmen steht — die Blöcke und ihre Zeiten. Die Spots kommen "
                 + "üblicherweise am Vorabend dazu, wenn Wetter und Lust bekannt sind.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            ForEach(day.blocks) { block in
                HStack {
                    Text(block.label)
                    Spacer()
                    Text(TripClock.duration(block.budgetMinutes))
                        .foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }

            Button {
                Task { await viewModel.detailCurrentDay() }
            } label: {
                if viewModel.isDetailing {
                    ProgressView()
                } else {
                    Text("Diesen Tag jetzt planen")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(viewModel.isDetailing)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 14))
    }

    // MARK: - Block cards

    private func blockCard(_ block: TripBlock) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(block.label).font(.headline)
                Spacer()
                Text("ca. \(TripClock.duration(block.usedMinutes)) von \(TripClock.duration(block.budgetMinutes))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: min(block.utilisation, 1))
                // Over budget is the one state that has to be
                // unmistakable, because it is the one the traveller has
                // to decide about (§8.4).
                .tint(block.utilisation > 1 ? .red : .accentColor)

            if block.isMeal {
                // A meal block holds time and a rough area, not a venue:
                // the planner never picks a restaurant (§10.3).
                Label("Zeit fürs Essen — der Planer sucht kein Lokal aus.", systemImage: "fork.knife")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if block.stops.isEmpty {
                Text("Nichts geplant.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(block.stops.enumerated()), id: \.element.rowId) { index, stop in
                    if index > 0 || stop.travelFromPrevious.minutes > 0 {
                        travelRow(stop.travelFromPrevious)
                    }
                    stopRow(stop)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: .rect(cornerRadius: 14))
    }

    private func travelRow(_ travel: TripTravel) -> some View {
        HStack(spacing: 6) {
            Image(systemName: travel.symbolName)
            Text("\(travel.minutes) min")
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.leading, 4)
    }

    private func stopRow(_ stop: TripStop) -> some View {
        let reasons = viewModel.reasons(for: stop)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if stop.pinned {
                    Image(systemName: "pin.fill").foregroundStyle(.orange)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(stop.displayName)
                        .strikethrough(stop.stopStatus == .skipped)
                    Text(TripClock.duration(stop.dwellMinutes))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if stop.stopStatus == .done {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                }
                if !reasons.isEmpty {
                    Button {
                        viewModel.toggleReasons(for: stop.osmRef)
                    } label: {
                        Image(systemName: viewModel.expandedReasons.contains(stop.osmRef)
                              ? "questionmark.circle.fill" : "questionmark.circle")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Warum hier?")
                }
            }

            if viewModel.expandedReasons.contains(stop.osmRef) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(reasons, id: \.self) { reason in
                        Text("· \(reason)")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: viewModel.expandedReasons)
    }
}
