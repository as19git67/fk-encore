import SwiftUI

/// The day of ideas as one band (ideas plan, stage 5): from the day's
/// start to its end, fixpoints as pins, visits as filled segments, the
/// ways as thin connectors, breaks hatched, free time empty, and „jetzt“
/// on the running day.
///
/// Drawn from what the server computed for the day (`window`, each
/// stop's `etaMinutes`, each break's), never from a second clock in the
/// app: the band and the list say the same times because they read the
/// same numbers.
struct TripDayBandModel: Equatable {
    enum Kind: Equatable {
        case way
        case visit(osmRef: String)
        case pause
        /// An appointment, a train: time the day has given away.
        case fixed
    }

    struct Segment: Equatable, Identifiable {
        let id: String
        let kind: Kind
        let label: String
        let startMinutes: Int
        let endMinutes: Int
        var minutes: Int { max(0, endMinutes - startMinutes) }
    }

    struct Pin: Equatable, Identifiable {
        let id: Int
        let label: String
        let minutes: Int
    }

    let window: TripDayWindow
    let segments: [Segment]
    let pins: [Pin]
    let plannedMinutes: Int
    let travelMinutes: Int

    /// Nil for a day with no window — a trip from before, a day without
    /// a frame time — which keeps its block cards.
    init?(day: TripDay) {
        guard let window = day.window, window.minutes > 0 else { return nil }
        self.window = window
        var segments: [Segment] = []
        var travel = 0
        for block in day.blocks where block.kind == "spots" {
            let line = TripDayClock.line(stops: block.stops, breaks: TripDayClock.breaks(of: day, blockId: block.id))
            for item in line {
                switch item {
                case .stop(let stop):
                    guard let eta = stop.etaMinutes else { continue }
                    let arrive = eta - max(0, stop.waitMinutes ?? 0)
                    let way = stop.travelFromPrevious.minutes
                    travel += way
                    if way > 0 {
                        segments.append(Segment(id: "way-\(stop.rowId)", kind: .way, label: "Weg",
                                                startMinutes: arrive - way, endMinutes: arrive))
                    }
                    segments.append(Segment(id: "stop-\(stop.rowId)", kind: .visit(osmRef: stop.osmRef),
                                            label: stop.displayName,
                                            startMinutes: eta, endMinutes: eta + stop.dwellMinutes))
                case .pause(let pause):
                    guard let eta = pause.etaMinutes else { continue }
                    segments.append(Segment(id: "break-\(pause.id)", kind: .pause, label: pause.label,
                                            startMinutes: eta, endMinutes: eta + pause.minutes))
                }
            }
        }
        for fix in day.fixpoints where fix.durationMinutes > 0 && !fix.isVisit {
            segments.append(Segment(id: "fix-\(fix.rowId)", kind: .fixed, label: fix.label,
                                    startMinutes: fix.startMinutes,
                                    endMinutes: fix.startMinutes + fix.durationMinutes))
        }
        self.segments = segments.sorted { $0.startMinutes < $1.startMinutes }
        self.pins = day.fixpoints.map { Pin(id: $0.rowId, label: $0.label, minutes: $0.startMinutes) }
        self.plannedMinutes = day.plannedMinutes ?? 0
        self.travelMinutes = travel
    }

    /// Where on the band a minute of the day falls, 0…1, clamped.
    func fraction(_ minutes: Int) -> Double {
        let span = Double(window.minutes)
        guard span > 0 else { return 0 }
        return min(1, max(0, Double(minutes - window.startMinutes) / span))
    }

    /// The band's end, past the window when the line runs over.
    var lineEndMinutes: Int { segments.map(\.endMinutes).max() ?? window.startMinutes }

    /// "4 h 30 von 10 h verplant, 1 h 10 unterwegs".
    var sentence: String {
        var text = "\(TripClock.duration(plannedMinutes)) von \(TripClock.duration(window.minutes)) verplant"
        if travelMinutes > 0 { text += ", \(TripClock.duration(travelMinutes)) unterwegs" }
        return text
    }

    /// How full the day is, 0…1 and more when it runs over: the mark on
    /// the day's chip.
    var fill: Double {
        guard window.minutes > 0 else { return 0 }
        return Double(plannedMinutes) / Double(window.minutes)
    }
}

/// The band itself.
struct TripDayBand: View {
    let model: TripDayBandModel
    /// The running day's clock, for the cursor; nil on any other day.
    var now: Int? = nil
    /// The visit tapped, by OSM reference.
    var onSelect: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary.opacity(0.6))
                        .frame(height: 22)
                    ForEach(model.segments) { segment in
                        segmentView(segment)
                            .frame(width: max(2, width * (model.fraction(segment.endMinutes) - model.fraction(segment.startMinutes))),
                                   height: height(of: segment))
                            .offset(x: width * model.fraction(segment.startMinutes))
                    }
                    ForEach(model.pins) { pin in
                        Image(systemName: "mappin")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .offset(x: width * model.fraction(pin.minutes) - 4, y: -16)
                            .accessibilityLabel("\(pin.label) um \(TripClock.format(pin.minutes))")
                    }
                    if let now, now >= model.window.startMinutes, now <= model.window.endMinutes {
                        Rectangle()
                            .fill(.red)
                            .frame(width: 2, height: 30)
                            .offset(x: width * model.fraction(now) - 1)
                            .accessibilityLabel("Jetzt")
                    }
                }
            }
            .frame(height: 30)
            HStack {
                Text(TripClock.format(model.window.startMinutes))
                Spacer()
                Text(model.sentence)
                Spacer()
                Text(TripClock.format(model.window.endMinutes))
            }
            .font(.caption2)
            .monospacedDigit()
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.sentence)
    }

    private func height(of segment: TripDayBandModel.Segment) -> CGFloat {
        segment.kind == .way ? 4 : 22
    }

    @ViewBuilder
    private func segmentView(_ segment: TripDayBandModel.Segment) -> some View {
        switch segment.kind {
        case .way:
            Capsule().fill(.secondary)
        case .visit(let osmRef):
            RoundedRectangle(cornerRadius: 4)
                .fill(segment.endMinutes > model.window.endMinutes ? Color.red.opacity(0.7) : Color.accentColor)
                .onTapGesture { onSelect?(osmRef) }
                .accessibilityLabel("\(segment.label), ca. \(TripClock.format(segment.startMinutes))")
                .accessibilityAddTraits(.isButton)
        case .pause:
            RoundedRectangle(cornerRadius: 4)
                .strokeBorder(.secondary, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                .background(RoundedRectangle(cornerRadius: 4).fill(.secondary.opacity(0.15)))
                .accessibilityLabel("\(segment.label), ca. \(TripClock.format(segment.startMinutes))")
        case .fixed:
            RoundedRectangle(cornerRadius: 4)
                .fill(.orange.opacity(0.5))
                .accessibilityLabel("\(segment.label) um \(TripClock.format(segment.startMinutes))")
        }
    }
}

/// How full a day is, as a thin bar under its chip.
struct TripDayFillMark: View {
    let fill: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(fill > 1 ? Color.red : Color.accentColor)
                    .frame(width: proxy.size.width * min(1, max(0, fill)))
            }
        }
        .frame(height: 3)
        .accessibilityHidden(true)
    }
}

#Preview("Tag als Band") {
    var day = TripDay(id: 1, dayIndex: 0, detailed: true, bufferReason: nil, blocks: [], fixpoints: [])
    day.window = TripDayWindow(startMinutes: 540, endMinutes: 1140)
    day.plannedMinutes = 270
    return TripDayBand(model: TripDayBandModel(day: day)!, now: 660)
        .padding()
}
