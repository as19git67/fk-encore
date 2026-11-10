import MapKit
import SwiftUI

/// The sheet "Weg" (reise-planen-und-unterwegs.md, stage 6): from and
/// to, a duration per mode, the way on a small map, the arrival checked
/// against the place's hours and booked time, and "In der Karten-App
/// starten". Navigating is Apple Maps' job, not the app's.
///
/// Opened from "Route" on the next spot (from here), from the way line
/// between two spots and its label on the day map (from the spot
/// before), and from "Route" in the spot details. A mode picked here
/// counts for that one segment only; the day times use its minutes.
struct TripWaySheet: View {
    let viewModel: TripPlannerViewModel
    /// The stay's own mode, which a segment goes back to.
    let stayMode: TripTransportMode

    @State private var request: TripWayRequest
    @State private var selected: TripTransportMode
    @State private var response: TripWayResponse?
    @State private var loading = true
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss

    init(viewModel: TripPlannerViewModel, request: TripWayRequest, stayMode: TripTransportMode) {
        self.viewModel = viewModel
        self.stayMode = stayMode
        _request = State(initialValue: request)
        _selected = State(initialValue: TripWays.modes.contains(request.currentMode) ? request.currentMode : .foot)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ends
                }
                Section {
                    modePicker
                        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    if let way {
                        map(way)
                            .frame(height: 200)
                            .clipShape(.rect(cornerRadius: 10))
                            .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 8, trailing: 12))
                        summary(way)
                    } else if loading {
                        HStack {
                            ProgressView()
                            Text("Weg wird berechnet …").foregroundStyle(.secondary)
                        }
                    } else {
                        Text("Der Weg ließ sich gerade nicht berechnen. Die Karten-App kennt ihn trotzdem.")
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button {
                        startInMaps()
                    } label: {
                        Label("In der Karten-App starten", systemImage: "arrow.triangle.turn.up.right.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
                if let segment = request.segment {
                    segmentSection(segment)
                }
            }
            .navigationTitle("Weg")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .task(id: request.id) {
                loading = true
                response = await viewModel.way(request)
                loading = false
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .opaqueSheetBackground()
    }

    private var way: TripWay? {
        response?.ways.first { $0.transportMode == selected }
    }

    // MARK: - Parts

    private var ends: some View {
        HStack(spacing: 12) {
            VStack(spacing: 4) {
                Image(systemName: request.from.isHere ? "location.fill" : "circle")
                    .foregroundStyle(Color.accentColor)
                Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 1.5, height: 14)
                Image(systemName: "mappin.circle.fill")
                    .foregroundStyle(.red)
            }
            .font(.footnote)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Von").font(.caption).foregroundStyle(.secondary)
                    Text(request.from.name).lineLimit(1)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Nach").font(.caption).foregroundStyle(.secondary)
                    Text(request.to.name).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button {
                request = request.swapped()
            } label: {
                Image(systemName: "arrow.up.arrow.down")
                    .frame(width: 36, height: 36)
                    .contentShape(.rect)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.circle)
            .accessibilityLabel("Von und Nach tauschen")
        }
        .accessibilityElement(children: .contain)
    }

    private var modePicker: some View {
        HStack(spacing: 6) {
            ForEach(TripWays.modes, id: \.self) { mode in
                let option = response?.ways.first { $0.transportMode == mode }
                Button {
                    selected = mode
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: mode.systemImage)
                            .font(.body)
                        Text(option.map { TripClock.duration($0.minutes) } ?? "–")
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(selected == mode ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground),
                                in: .rect(cornerRadius: 10))
                    .foregroundStyle(selected == mode ? Color.accentColor : Color.primary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.map { "\(mode.label), \(TripClock.duration($0.minutes))" } ?? mode.label)
                .accessibilityAddTraits(selected == mode ? .isSelected : [])
            }
        }
    }

    private func map(_ way: TripWay) -> some View {
        let path = TripWays.path(shape: way.shape, from: request.from.coordinate, to: request.to.coordinate)
        return Map(initialPosition: .automatic, interactionModes: [.pan, .zoom]) {
            MapPolyline(coordinates: path.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) })
                .stroke(way.shape == nil ? Color.secondary : Color.accentColor,
                        style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round,
                                           dash: way.shape == nil ? [6, 5] : []))
            Marker(request.from.name, systemImage: request.from.isHere ? "location.fill" : "circle.fill",
                   coordinate: CLLocationCoordinate2D(latitude: request.from.coordinate.lat,
                                                      longitude: request.from.coordinate.lon))
                .tint(Color.accentColor)
            Marker(request.to.name, coordinate: CLLocationCoordinate2D(latitude: request.to.coordinate.lat,
                                                                       longitude: request.to.coordinate.lon))
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        // A new answer is a new line; without the id the map keeps the old frame.
        .id("\(request.id)|\(way.mode)|\(way.shape?.count ?? 0)")
    }

    @ViewBuilder
    private func summary(_ way: TripWay) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(TripWays.line(minutes: way.minutes, distanceM: way.distanceM, by: way.doneBy))
                .font(.headline)
            if way.mode == "transit" && way.doneBy == .transit {
                Text("Ohne Fahrplan geschätzt – die Karten-App kennt die Verbindungen.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if way.mode == "transit" {
                Text("Zu Fuß ist hier schneller als mit Bus oder Bahn.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if !way.routed {
                Text("Luftlinie, Dauer geschätzt.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let fit = TripWays.fitText(way, target: response?.target) {
                Label(fit, systemImage: TripWays.isWarning(way) ? "exclamationmark.triangle.fill" : "clock")
                    .font(.subheadline)
                    .foregroundStyle(TripWays.isWarning(way) ? Color.red : Color.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func segmentSection(_ segment: (fromRef: String, toRef: String)) -> some View {
        let differs = selected != request.currentMode
        let picked = request.currentMode != stayMode
        if differs || picked {
            Section {
                if differs {
                    Button {
                        Task { await keep(selected, segment) }
                    } label: {
                        Label("\(TripWays.capitalized(selected.label)) für diesen Abschnitt",
                              systemImage: selected.systemImage)
                    }
                    .disabled(saving || way == nil)
                }
                if picked {
                    Button {
                        Task { await keep(nil, segment) }
                    } label: {
                        Label("Wieder wie der Aufenthalt (\(stayMode.label))", systemImage: "arrow.uturn.backward")
                    }
                    .disabled(saving)
                }
            } footer: {
                Text("Gilt nur für diesen Weg. Der Tag rechnet mit der neuen Dauer weiter.")
            }
        }
    }

    private func keep(_ mode: TripTransportMode?, _ segment: (fromRef: String, toRef: String)) async {
        saving = true
        await viewModel.setSegmentMode(mode, fromRef: segment.fromRef, toRef: segment.toRef,
                                       from: request.from.coordinate, to: request.to.coordinate)
        saving = false
        if viewModel.errorMessage == nil {
            request.currentMode = mode ?? stayMode
        }
    }

    private func startInMaps() {
        let to = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(
            latitude: request.to.coordinate.lat, longitude: request.to.coordinate.lon)))
        to.name = request.to.name
        let from: MKMapItem
        if request.from.isHere {
            from = MKMapItem.forCurrentLocation()
        } else {
            from = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(
                latitude: request.from.coordinate.lat, longitude: request.from.coordinate.lon)))
            from.name = request.from.name
        }
        MKMapItem.openMaps(with: [from, to], launchOptions: [
            MKLaunchOptionsDirectionsModeKey: TripRouteMode(selected).appleDirectionsMode,
        ])
    }
}
