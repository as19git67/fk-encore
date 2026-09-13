import MapKit
import SwiftUI

/// The day on a map, with numbered pins in the order the plan walks
/// them, and a slider over the day underneath (§8.3).
///
/// The slider is the part that earns its place. Sliding it moves a
/// marker to **where the plan says you would be at that hour** — which
/// turns a light hint like "best around 19:30" from a claim into
/// something you can check against your own day. Both halves are
/// computed anyway (block times §4.1, and later the sun §7.3); the
/// slider only makes them meet.
struct TripDayMapView: View {
    let day: TripDay
    let anchor: TripCoordinate
    let light: TripDayLight?
    /// True when the leg's dates put today inside the trip — drives the
    /// user-location puck. Passed in rather than computed here so the
    /// view stays a pure function of its inputs.
    let isRunning: Bool

    @State private var camera: MapCameraPosition = .automatic
    @State private var sliderMinutes: Double = 0
    @State private var sliderActive = false
    @State private var selected: Selection?
    @State private var showLegend = false

    /// A tapped pin, kept whole: the sheet needs the number as much as
    /// the stop, and re-deriving it from the stop would be the walking
    /// order computed a second time.
    private struct Selection: Identifiable {
        let number: Int
        let stop: TripStop
        var id: Int { stop.rowId }
    }

    private var span: ClosedRange<Int>? { TripDayTimeline.span(of: day) }

    /// Every stop of the day in walking order — what the pins number by.
    private var numbered: [(index: Int, stop: TripStop)] {
        Array(day.blocks.flatMap(\.stops).enumerated()).map { ($0.offset + 1, $0.element) }
    }

    private var highlighted: TripTimelinePosition? {
        guard sliderActive else { return nil }
        return TripDayTimeline.position(in: day, at: Int(sliderMinutes))
    }

    var body: some View {
        VStack(spacing: 0) {
            map
            if showLegend { legend }
            if let span {
                timeSlider(span)
            }
        }
        .navigationTitle("Karte")
        .navigationBarTitleDisplayMode(.inline)
        // The map panel runs to the bottom edge of the screen. Left
        // showing, the tab bar steals the row under the slider for tabs
        // nobody can reach from a map anyway.
        .toolbar(.hidden, for: .tabBar)
        // And hiding the bar is not the same as hiding what it draws.
        // `.toolbar(.hidden,…)` takes away the bar's *content* — the
        // icons and their labels — while the bar itself keeps painting
        // its background, and the top edge of that background is a
        // hairline. It landed just under the slider, which is why the
        // line survived the fix above: nothing was ever hiding it.
        .toolbarBackgroundVisibility(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showLegend.toggle()
                } label: {
                    Label("Legende", systemImage: showLegend ? "info.circle.fill" : "info.circle")
                }
            }
        }
        .sheet(item: $selected) { pick in
            TripPinDetailSheet(detail: TripPinDetail.of(pick.stop, number: pick.number, in: day))
        }
        .onAppear {
            if let span, sliderMinutes == 0 { sliderMinutes = Double(span.lowerBound) }
        }
    }

    private var map: some View {
        Map(position: $camera) {
            if isRunning {
                UserAnnotation()
            }
            // The anchor is where the day starts and ends. Shown as a
            // house rather than a number: it is not a stop.
            Annotation("Unterkunft", coordinate: anchor.clCoordinate) {
                Image(systemName: "house.fill")
                    .padding(6)
                    .background(.background, in: .circle)
                    .overlay(Circle().stroke(.secondary))
            }

            ForEach(numbered, id: \.stop.rowId) { entry in
                Annotation(entry.stop.displayName, coordinate: entry.stop.coordinate.clCoordinate) {
                    Button {
                        selected = Selection(number: entry.index, stop: entry.stop)
                    } label: {
                        pin(entry.index, stop: entry.stop)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(entry.index). \(entry.stop.displayName)")
                }
            }
        }
        .mapStyle(.standard)
    }

    private func pin(_ number: Int, stop: TripStop) -> some View {
        let isHighlighted = highlighted?.stop?.rowId == stop.rowId
        return Text("\(number)")
            .font(.caption.weight(.bold))
            .foregroundStyle(.white)
            .frame(width: isHighlighted ? 32 : 26, height: isHighlighted ? 32 : 26)
            .background(pinColour(for: stop), in: .circle)
            .overlay(Circle().stroke(.white, lineWidth: isHighlighted ? 3 : 2))
            .animation(.easeInOut(duration: 0.15), value: isHighlighted)
    }

    private func pinColour(for stop: TripStop) -> Color { Self.colour(of: stop.stopStatus) }

    /// One mapping for the pins and the legend both. Two would be one
    /// too many: a legend that disagrees with the map is worse than no
    /// legend.
    static func colour(of status: TripStopStatus) -> Color {
        switch status {
        case .done:    return .green
        case .skipped: return .secondary
        case .planned: return .accentColor
        }
    }

    private func timeSlider(_ span: ClosedRange<Int>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(TripClock.format(Int(sliderMinutes)))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Spacer()
                // What the plan says about that hour — or, honestly,
                // nothing when the hour falls outside the day.
                if let position = highlighted {
                    Text(position.stop?.displayName ?? position.block.label)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if sliderActive {
                    Text("nichts geplant")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            lightLine

            Slider(
                value: $sliderMinutes,
                in: Double(span.lowerBound)...Double(span.upperBound),
                step: 5,
            ) {
                Text("Uhrzeit")
            } minimumValueLabel: {
                Text(TripClock.format(span.lowerBound)).font(.caption2).monospacedDigit()
            } maximumValueLabel: {
                Text(TripClock.format(span.upperBound)).font(.caption2).monospacedDigit()
            } onEditingChanged: { editing in
                sliderActive = true
                _ = editing
            }
        }
        .padding()
        .background(Color(uiColor: .systemBackground).ignoresSafeArea(edges: .bottom))
    }

    /// What the colours mean — shown on request rather than always.
    ///
    /// A map with three colours needs the key exactly once, and a strip
    /// that is always there costs the map a row of itself every day
    /// after that.
    private var legend: some View {
        HStack(spacing: 14) {
            ForEach(TripStopStatus.legendOrder, id: \.self) { status in
                HStack(spacing: 5) {
                    Circle()
                        .fill(Self.colour(of: status))
                        .frame(width: 10, height: 10)
                        .overlay(Circle().stroke(.white, lineWidth: 1))
                    Text(status.label)
                }
            }
            Spacer()
            Text("Tippen für Details")
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color(uiColor: .systemBackground))
    }

    /// What the sun is doing at the selected minute (§7.3) — and
    /// nothing at all when nobody computed it. A day without dates has
    /// no sun, and "kein besonderes Lichtfenster" under such a day
    /// would be a claim rather than an answer.
    @ViewBuilder
    private var lightLine: some View {
        switch TripDayTimeline.light(light, at: Int(sliderMinutes)) {
        case .unknown:
            EmptyView()
        case .ordinary:
            Label("Kein besonderes Lichtfenster", systemImage: "sun.max")
                .font(.caption)
                .foregroundStyle(.secondary)
        case .window(let window):
            Label("\(window.label) · \(window.range)", systemImage: window.symbolName)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

extension TripCoordinate {
    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}
