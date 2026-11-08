import SwiftUI

/// What the last "Reihenfolge vorschlagen" said about one day (ideas
/// plan, stage 4): by how much it runs over, and which ideas would make
/// it fit if the travellers took them off. Nothing is dropped for them.
struct TripOrderAdvice: Equatable, Sendable {
    let legIndex: Int
    let dayIndex: Int
    let overrunMinutes: Int
    let toDrop: [String]

    func applies(legIndex: Int, dayIndex: Int) -> Bool {
        self.legIndex == legIndex && self.dayIndex == dayIndex
    }

    func suggestsDropping(_ osmRef: String) -> Bool { toDrop.contains(osmRef) }
}

/// The day of ideas in words: estimated times and the day's sum.
enum TripDayClock {
    /// "ca. 10:40", the estimated start of a visit.
    static func eta(_ stop: TripStop) -> String? {
        stop.etaMinutes.map { "ca. \(TripClock.format($0))" }
    }

    /// "4 h 30 von 10 h verplant · 5 h 30 frei", or the overrun when
    /// the day does not hold what is on it. Nil for a day without a
    /// window: a trip from before, or a day without a frame time.
    static func summary(for day: TripDay) -> String? {
        guard let window = day.window else { return nil }
        let planned = day.plannedMinutes ?? 0
        let head = "\(TripClock.duration(planned)) von \(TripClock.duration(window.minutes)) verplant"
        if let over = day.overrunMinutes, over > 0 {
            return "\(head) · \(TripClock.duration(over)) zu viel"
        }
        let free = day.freeMinutes ?? 0
        let wait = day.waitMinutes ?? 0
        let waitText = wait > 0 ? " · \(TripClock.duration(wait)) warten" : ""
        return "\(head)\(waitText) · \(TripClock.duration(free)) frei"
    }

    /// The breaks of a block in the order they stand.
    static func breaks(of day: TripDay, blockId: String) -> [TripDayBreak] {
        (day.breaks ?? []).filter { $0.blockId == blockId }.sorted { $0.position < $1.position }
    }

    /// The stops and breaks of a block as one line, breaks at their places.
    static func line(stops: [TripStop], breaks: [TripDayBreak]) -> [TripDayLineItem] {
        var items: [TripDayLineItem] = []
        var pending = breaks.sorted { $0.position < $1.position }
        for stop in stops {
            while let next = pending.first, next.position <= items.count {
                items.append(.pause(next))
                pending.removeFirst()
            }
            items.append(.stop(stop))
        }
        items.append(contentsOf: pending.map { .pause($0) })
        return items
    }
}

/// One entry of a day's line: a stop or a break.
enum TripDayLineItem: Identifiable {
    case stop(TripStop)
    case pause(TripDayBreak)

    var id: String {
        switch self {
        case .stop(let stop): return "stop-\(stop.rowId)"
        case .pause(let brk): return "break-\(brk.id)"
        }
    }
}

/// The two breaks a day usually has, for the menu.
enum TripBreakPreset: CaseIterable, Identifiable {
    case lunch, coffee, rest

    var id: Self { self }
    var label: String {
        switch self {
        case .lunch: return "Mittag"
        case .coffee: return "Kaffee"
        case .rest: return "Pause"
        }
    }
    var minutes: Int {
        switch self {
        case .lunch: return 60
        case .coffee: return 30
        case .rest: return 20
        }
    }
    var symbolName: String {
        switch self {
        case .lunch: return "fork.knife"
        case .coffee: return "cup.and.saucer"
        case .rest: return "figure.seated.side"
        }
    }
}

/// A break in the day's list.
struct TripBreakRow: View {
    let pause: TripDayBreak
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "pause.circle")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(pause.label)
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(role: .destructive, action: onRemove) {
                Image(systemName: "xmark.circle")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Pause entfernen")
        }
    }

    private var caption: String {
        let length = TripClock.duration(pause.minutes)
        guard let eta = pause.etaMinutes else { return length }
        return "ca. \(TripClock.format(eta)) · \(length)"
    }
}
