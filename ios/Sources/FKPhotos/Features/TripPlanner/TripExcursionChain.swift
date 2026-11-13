import SwiftUI

/// Excursions that follow each other without the way back to the
/// quarters in between (Mock 18, Anton 13.11.: Seestadt, then straight
/// on to Hafenstadt, then home). The server keeps each destination a
/// block of its own and links them through `from`; this is how the
/// stay's planning view reads and draws such a chain.
enum TripExcursionChain {
    /// The excursion this one goes on from, when it goes on from one.
    static func before(_ excursion: TripExcursion, in day: TripDay) -> TripExcursion? {
        guard let from = excursion.from else { return nil }
        return day.excursions?.first { $0.id == from }
    }

    /// The excursion that goes on from this one.
    static func after(_ excursion: TripExcursion, in day: TripDay) -> TripExcursion? {
        day.excursions?.first { $0.from == excursion.id }
    }

    /// "Ausflug nach Seestadt", or "Ausflug Seestadt → Hafenstadt" for a chain.
    static func title(_ chain: [TripExcursion]) -> String {
        guard chain.count > 1 else { return chain.first?.title ?? "Ausflug" }
        return "Ausflug " + chain.map(\.displayName).joined(separator: " → ")
    }

    /// The head of a chain: "Abfahrt 09:30 · zurück 14:30 · 2 Ziele".
    static func line(_ chain: [TripExcursion]) -> String {
        guard chain.count > 1, let first = chain.first, let last = chain.last else {
            return chain.first?.line ?? ""
        }
        return "Abfahrt \(TripClock.format(first.departMinutes)) · zurück \(TripClock.format(last.returnMinutes))"
            + " · \(chain.count) Ziele"
    }

    /// One destination of a chain: "an 10:02 · weiter 12:00" or
    /// "an 12:09 · zurück 14:30".
    static func stopLine(_ excursion: TripExcursion, goesOn: Bool) -> String {
        "an \(TripClock.format(excursion.arriveMinutes)) · "
            + (goesOn ? "weiter" : "zurück") + " \(TripClock.format(excursion.returnMinutes))"
    }

    /// The hop to a destination that goes on from the one before:
    /// "weiter 12:00 · 9 min · nicht zurück".
    static func hopLine(_ excursion: TripExcursion) -> String {
        "weiter \(TripClock.format(excursion.departMinutes))"
            + (excursion.travelMinutes > 0 ? " · \(TripClock.duration(excursion.travelMinutes))" : "")
            + " · nicht zurück"
    }

    /// Whether `next` may go on from `last` instead of from the quarters:
    /// it does not already, and it ends after `last` starts on.
    static func canLink(_ last: TripExcursion, _ next: TripExcursion) -> Bool {
        next.from == nil && next.id != last.id && next.returnMinutes > last.returnMinutes
    }

    /// The excursion right after the group at `index` that could go on
    /// from it: the next chain's first, with nothing planned at the
    /// quarters in between (a spot there needs the way back).
    static func next(after index: Int, in groups: [TripStaySectionGroup]) -> TripExcursion? {
        for group in groups.dropFirst(index + 1) {
            switch group {
            case .home(let section):
                if !section.block.stops.isEmpty { return nil }
            case .chain:
                return group.excursions.first
            }
        }
        return nil
    }

    /// The day's sections with each chain of excursions as one group, in
    /// the day's order.
    static func groups(_ sections: [TripStaySection]) -> [TripStaySectionGroup] {
        var out: [TripStaySectionGroup] = []
        for section in sections {
            guard let excursion = section.excursion else {
                out.append(.home(section))
                continue
            }
            if let from = excursion.from, case .chain(let links)? = out.last,
               links.last?.excursion?.id == from {
                out[out.count - 1] = .chain(links + [section])
            } else {
                out.append(.chain([section]))
            }
        }
        return out
    }
}

/// A part of a day in the stay's planning view: the day at the quarters,
/// or one excursion with every destination that follows it directly.
enum TripStaySectionGroup: Identifiable {
    case home(TripStaySection)
    case chain([TripStaySection])

    var id: String {
        switch self {
        case .home(let section): section.id
        case .chain(let links): links.first?.id ?? "chain"
        }
    }

    /// The excursions of a chain, in order; empty for the quarters.
    var excursions: [TripExcursion] {
        if case .chain(let links) = self { return links.compactMap(\.excursion) }
        return []
    }
}

/// Two excursions of a day about to go on from each other (Mock 18 B).
struct TripExcursionLink: Identifiable {
    let dayIndex: Int
    let last: TripExcursion
    let next: TripExcursion
    var id: String { "\(last.id)>\(next.id)" }

    /// What the server worked out for this pair, when it suggests it.
    var suggestion: TripExcursionLinkSuggestion? {
        next.linkSuggestion.flatMap { $0.from == last.id ? $0 : nil }
    }

    /// What the group gains: `next` leaves when `last` starts on rather
    /// than at its own hour. The hop itself the server reckons on save.
    var earlierMinutes: Int { max(0, next.departMinutes - last.returnMinutes) }
}

/// "Von Seestadt direkt nach Hafenstadt?" (Mock 18 B): what changes, and
/// "Verbinden".
struct TripExcursionLinkSheet: View {
    let link: TripExcursionLink
    let stayTitle: String
    /// Nil when it was linked, otherwise what went wrong.
    let onLink: () async -> String?

    @State private var saving = false
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss

    /// What changes, and how to take it back.
    private var footer: String {
        var parts: [String] = []
        if let suggestion = link.suggestion {
            parts.append("Spart ca. \(TripClock.duration(suggestion.savedMinutes)) Fahrt.")
        }
        if link.earlierMinutes > 0 {
            parts.append("Die Abfahrt um \(TripClock.format(link.next.departMinutes)) entfällt: "
                         + "ihr seid früher in \(link.next.displayName).")
        }
        if link.suggestion == nil {
            parts.append("Die Fahrzeit dazwischen rechnet die App beim Verbinden.")
        }
        parts.append("Lösen geht über „⋯“ am Ziel › „Dazwischen zurück zur Unterkunft“.")
        return parts.joined(separator: " ")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Weiter ab \(link.last.displayName)", value: TripClock.format(link.last.returnMinutes))
                    if let suggestion = link.suggestion {
                        LabeledContent("Fahrt nach \(link.next.displayName)",
                                       value: "ca. \(TripClock.duration(suggestion.hopMinutes))")
                        LabeledContent("Über \(stayTitle)", value: "ca. \(TripClock.duration(suggestion.viaQuartersMinutes))")
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("In \(link.next.displayName)", value: "bis \(TripClock.format(link.next.returnMinutes))")
                } header: {
                    Text("Ihr fahrt nicht nach \(stayTitle) zurück.")
                } footer: {
                    Text(footer)
                }
                if let failure {
                    Section {
                        Label(failure, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }
            }
            .navigationTitle("Von \(link.last.displayName) direkt nach \(link.next.displayName)?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        saving = true
                        failure = nil
                        Task {
                            failure = await onLink()
                            saving = false
                            if failure == nil { dismiss() }
                        }
                    } label: {
                        if saving { ProgressView() } else { Text("Verbinden") }
                    }
                    .disabled(saving)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .opaqueSheetBackground()
    }
}
