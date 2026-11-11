import SwiftUI

// Open spots (stage 8, mocks 13 and 15): a day holds only what is fixed,
// everything else stays open on the stay until a day takes it. The
// server says what fits (`capacity` on the leg) and proposes a day
// ("Tag füllen"); the app shows both and writes nothing on its own.

/// Does the open part of a stay fit its coming days? `open-capacity.ts`.
struct TripStayCapacity: Codable, Equatable, Sendable {
    let mustMinutes: Int
    let wantMinutes: Int
    /// "Wenn Zeit".
    let maybeMinutes: Int
    /// Free minutes of the days still to come, less a share for the ways.
    let freeMinutes: Int
    let days: Int
    let fits: Bool
    let overMinutes: Int
}

enum TripOpenSpots {
    /// The open spots of a stay: its ideas without a day, Muss first.
    /// Food is chosen on the spot and never counted (`open-capacity.ts`).
    static func open(of leg: TripLeg) -> [TripCandidate] {
        leg.pool
            .filter { $0.category != "food" }
            .sorted { lhs, rhs in
                let left = rank(lhs.ideaPriority), right = rank(rhs.ideaPriority)
                if left != right { return left < right }
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.displayName.localizedCompare(rhs.displayName) == .orderedAscending
            }
    }

    private static func rank(_ priority: TripIdeaPriority) -> Int {
        switch priority {
        case .must: 0
        case .want: 1
        case .maybe: 2
        }
    }

    /// "ca. Muss 7 h · Will 5 h · frei 16 h", or what is too much.
    static func capacityLine(_ capacity: TripStayCapacity) -> String {
        if !capacity.fits {
            return "ca. Muss \(hours(capacity.mustMinutes)), frei \(hours(capacity.freeMinutes)) – "
                + "\(hours(capacity.overMinutes)) zu viel"
        }
        var parts: [String] = []
        if capacity.mustMinutes > 0 { parts.append("Muss \(hours(capacity.mustMinutes))") }
        if capacity.wantMinutes > 0 { parts.append("Will \(hours(capacity.wantMinutes))") }
        parts.append("frei \(hours(capacity.freeMinutes))")
        return "ca. " + parts.joined(separator: " · ")
    }

    /// The line under it: whether it fits, and what "Wenn Zeit" adds.
    static func capacityDetail(_ capacity: TripStayCapacity) -> String? {
        if !capacity.fits {
            return "Nicht alle Muss-Spots passen in die \(daysText(capacity.days))."
        }
        if capacity.maybeMinutes > 0 {
            return "passt · Wenn Zeit \(hours(capacity.maybeMinutes)) kommen dazu, falls Zeit bleibt"
        }
        return capacity.mustMinutes + capacity.wantMinutes > 0 ? "passt" : nil
    }

    /// The hint on the last coming day while Muss spots do not fit.
    static func mustHint(open: [TripCandidate], capacity: TripStayCapacity?) -> String? {
        guard let capacity, !capacity.fits else { return nil }
        let must = open.filter { $0.ideaPriority == .must }.count
        guard must > 0 else { return nil }
        let spots = must == 1 ? "ein Muss-Spot" : "\(must) Muss-Spots"
        return "Noch \(spots) offen, und die Zeit reicht nicht für alle."
    }

    /// "Kirche · 1 h · Muss": what the card of an open spot says.
    static func cardLine(_ candidate: TripCandidate) -> String {
        [TripCategory.label(candidate.category), TripClock.duration(candidate.dwellMinutes)]
            .joined(separator: " · ")
    }

    /// What a dragged open spot carries, beside `TripStayPlan.dragId`.
    static func dragId(_ osmRef: String) -> String { "trip-idea:\(osmRef)" }

    static func osmRef(fromDragId id: String) -> String? {
        guard id.hasPrefix("trip-idea:") else { return nil }
        return String(id.dropFirst("trip-idea:".count))
    }

    /// Roughly, in hours: the line is a number for planning.
    static func hours(_ minutes: Int) -> String {
        if minutes < 60 { return "\(max(0, minutes)) min" }
        let half = (Double(minutes) / 30).rounded() / 2
        return half == half.rounded()
            ? "\(Int(half)) h"
            : "\(Int(half)),5 h"
    }

    private static func daysText(_ days: Int) -> String {
        days == 1 ? "freie Zeit des letzten Tages" : "freie Zeit der \(days) Tage"
    }
}

// MARK: - Tag füllen

/// One open spot proposed for a day, with why (`open-fill.ts`).
struct TripFillPick: Codable, Identifiable, Equatable, Sendable {
    let osmRef: String
    let name: String
    let reasons: [String]
    var id: String { osmRef }
}

/// One line of the day as it would look.
struct TripFillLine: Codable, Identifiable, Equatable, Sendable {
    let osmRef: String
    let name: String
    let etaMinutes: Int?
    /// Proposed by this fill; the rest already stands on the day.
    let proposed: Bool
    var id: String { osmRef }
}

struct TripFillProposal: Codable, Equatable, Sendable {
    let dayIndex: Int
    let label: String
    let picks: [TripFillPick]
    let line: [TripFillLine]
    let freeMinutes: Int
    let overrunMinutes: Int
}

struct TripFillDayResponse: Codable, Sendable {
    let proposal: TripFillProposal
    let degraded: Bool
}

struct TripFillStayResponse: Codable, Sendable {
    let proposals: [TripFillProposal]
    let degraded: Bool
}

struct TripFillAcceptResponse: Codable, Sendable {
    let sentence: String
    let opId: Int
}

enum TripFillAPI {
    private struct FromBody: Encodable {
        let fromMinutes: Int?
    }

    static func day(planId: Int, legIndex: Int, dayIndex: Int, fromMinutes: Int?) async throws -> TripFillDayResponse {
        try await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/legs/\(legIndex)/days/\(dayIndex)/fill",
            body: FromBody(fromMinutes: fromMinutes))
    }

    static func stay(planId: Int, legIndex: Int, fromMinutes: Int?) async throws -> TripFillStayResponse {
        try await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/legs/\(legIndex)/fill",
            body: FromBody(fromMinutes: fromMinutes))
    }

    static func accept(planId: Int, legIndex: Int, days: [(dayIndex: Int, osmRefs: [String])],
                       fromMinutes: Int?) async throws -> TripFillAcceptResponse {
        struct Day: Encodable {
            let dayIndex: Int
            let osmRefs: [String]
        }
        struct Body: Encodable {
            let days: [Day]
            let fromMinutes: Int?
        }
        return try await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/legs/\(legIndex)/fill/accept",
            body: Body(days: days.map { Day(dayIndex: $0.dayIndex, osmRefs: $0.osmRefs) },
                       fromMinutes: fromMinutes))
    }
}

/// What "Tag füllen" (one day) or "Alle Tage füllen" was asked for.
struct TripFillRequest: Identifiable, Equatable {
    /// Nil for every coming day.
    let dayIndex: Int?
    /// On the running day, the local minute of now.
    let fromMinutes: Int?
    var id: String { dayIndex.map(String.init) ?? "all" }
}

/// The sheet "‹Tag› füllen" (mock 13 B): the day as it would look, each
/// proposed spot with why, "–" to leave one open; only "Übernehmen"
/// writes, and what is taken is "von der App".
struct TripDayFillSheet: View {
    let planId: Int
    let legIndex: Int
    let request: TripFillRequest
    /// The spots taken, per day; answers the refusal if there is one.
    let onAccept: ([(dayIndex: Int, osmRefs: [String])]) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var proposals: [TripFillProposal] = []
    @State private var dropped: Set<String> = []
    @State private var degraded = false
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Abbrechen") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Übernehmen") {
                            Task { await accept() }
                        }
                        .fontWeight(.semibold)
                        .disabled(loading || saving || kept.allSatisfy { $0.osmRefs.isEmpty })
                    }
                }
        }
        .task { await load() }
        .opaqueSheetBackground()
    }

    private var title: String {
        if request.dayIndex == nil { return "Alle Tage füllen" }
        return proposals.first.map { "\($0.label) füllen" } ?? "Tag füllen"
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            ProgressView("Suche passende Spots …")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error, proposals.isEmpty {
            ContentUnavailableView("Kein Vorschlag", systemImage: "exclamationmark.triangle",
                                   description: Text(error))
        } else if proposals.allSatisfy({ $0.picks.isEmpty }) {
            ContentUnavailableView("Nichts passt", systemImage: "calendar",
                                   description: Text("Kein offener Spot passt an diesem Tag noch hinein."))
        } else {
            List {
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                if degraded {
                    Section {
                        Label("Ohne Wettervorhersage: Regen ist nicht berücksichtigt.",
                              systemImage: "cloud.slash")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                ForEach(proposals, id: \.dayIndex) { proposal in
                    daySection(proposal)
                }
                Section {
                    EmptyView()
                } footer: {
                    Text("„–“ nimmt einen Spot aus dem Vorschlag; er bleibt offen. Übernommene Spots sind „von der App“: was der Tag nicht erreicht, ist am Abend wieder offen.")
                }
            }
        }
    }

    private func daySection(_ proposal: TripFillProposal) -> some View {
        let reasons = Dictionary(uniqueKeysWithValues: proposal.picks.map { ($0.osmRef, $0.reasons) })
        return Section {
            ForEach(proposal.line) { line in
                if line.proposed, dropped.contains(line.osmRef) {
                    EmptyView()
                } else {
                    row(line, reasons: reasons[line.osmRef])
                }
            }
            let left = proposal.picks.filter { dropped.contains($0.osmRef) }
            ForEach(left) { pick in
                HStack {
                    Text(pick.name).foregroundStyle(.secondary)
                    Spacer()
                    Button("Wieder dazu") { dropped.remove(pick.osmRef) }
                        .font(.footnote)
                }
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                if request.dayIndex == nil { Text(proposal.label) }
                Text(summary(proposal))
                    .textCase(nil)
            }
        }
    }

    private func row(_ line: TripFillLine, reasons: [String]?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(line.etaMinutes.map(TripClock.format) ?? "")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 44, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if !line.proposed {
                        Image(systemName: "pin.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("fest")
                    }
                    Text(line.name)
                        .fontWeight(line.proposed ? .regular : .semibold)
                }
                if let reasons, !reasons.isEmpty {
                    Text(reasons.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !line.proposed {
                    Text("steht schon fest")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if line.proposed {
                Button {
                    dropped.insert(line.osmRef)
                } label: {
                    Image(systemName: "minus.circle")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Aus dem Vorschlag nehmen")
            }
        }
    }

    /// "6 h 40 verplant · 20 min frei".
    private func summary(_ proposal: TripFillProposal) -> String {
        let kept = proposal.picks.filter { !dropped.contains($0.osmRef) }.count
        let spots = kept == 1 ? "1 Spot" : "\(kept) Spots"
        var line = "\(spots) vorgeschlagen · \(TripClock.duration(proposal.freeMinutes)) frei vorher"
        if proposal.overrunMinutes > 0 {
            line += " · \(TripClock.duration(proposal.overrunMinutes)) zu viel"
        }
        return line
    }

    private var kept: [(dayIndex: Int, osmRefs: [String])] {
        proposals.map { proposal in
            (proposal.dayIndex, proposal.picks.map(\.osmRef).filter { !dropped.contains($0) })
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            if let dayIndex = request.dayIndex {
                let response = try await TripFillAPI.day(planId: planId, legIndex: legIndex,
                                                         dayIndex: dayIndex, fromMinutes: request.fromMinutes)
                proposals = [response.proposal]
                degraded = response.degraded
            } else {
                let response = try await TripFillAPI.stay(planId: planId, legIndex: legIndex,
                                                          fromMinutes: request.fromMinutes)
                proposals = response.proposals.filter { !$0.picks.isEmpty }
                degraded = response.degraded
            }
        } catch {
            self.error = TripErrorText.describe(error)
        }
    }

    private func accept() async {
        saving = true
        defer { saving = false }
        let days = kept.filter { !$0.osmRefs.isEmpty }
        if let refusal = await onAccept(days) {
            error = refusal
        } else {
            dismiss()
        }
    }
}
