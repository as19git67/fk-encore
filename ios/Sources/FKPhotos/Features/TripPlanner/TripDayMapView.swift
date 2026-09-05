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

    @State private var camera: MapCameraPosition = .automatic
    @State private var sliderMinutes: Double = 0
    @State private var sliderActive = false

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
            if let span {
                timeSlider(span)
            }
        }
        .navigationTitle("Karte")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if let span, sliderMinutes == 0 { sliderMinutes = Double(span.lowerBound) }
        }
    }

    private var map: some View {
        Map(position: $camera) {
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
                    pin(entry.index, stop: entry.stop)
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

    private func pinColour(for stop: TripStop) -> Color {
        switch stop.stopStatus {
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
        .background(.bar)
    }
}

extension TripCoordinate {
    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }
}
