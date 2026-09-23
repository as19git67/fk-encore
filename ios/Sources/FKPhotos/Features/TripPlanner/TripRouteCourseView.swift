import Foundation
import MapKit
import SwiftUI

/// One signposted way, on a map (§4.7).
///
/// A list of routes is a list of names until you can see where they
/// run. Two ten-kilometre walks out of the same town are not the same
/// decision — one follows the lake, the other goes over the ridge —
/// and nothing in a row of text says which is which. So the row leads
/// here, and here the way is drawn.
///
/// Drawn from the course OpenStreetMap holds, not from a straight line
/// between the ends. Where the relation's members do not join up there
/// is no course to draw, and the screen says that instead of inventing
/// one (§15.3).
///
/// The other half of the screen is the way out. The planner decides
/// *which* way is worth a day; it does not walk it with you. Komoot,
/// Organic Maps, Outdooractive and a Garmin do that, and all of them
/// read GPX — so the file goes into the share sheet and the app that
/// handles it takes over. What is exported is the geometry as
/// imported, fetched again for the purpose: the line on this map is
/// simplified to about fifty metres, which is right for looking at and
/// wrong for following.
struct TripRouteCourseView: View {
    let planId: Int
    let legIndex: Int
    let route: TripNearbyRoute
    /// Nil when the route is already in the pool — then there is
    /// nothing to take in.
    var onTake: (() async -> Void)?
    /// How far around the leg the pictures are looked for — the band
    /// the list was searched in. Nil lets the server choose.
    var radiusM: Int? = nil

    @State private var isTaking = false
    @State private var isExporting = false
    @State private var exported: ExportedFile?
    @State private var errorMessage: String?
    @State private var photos: [TripRoutePhoto] = []
    @State private var photosLoaded = false
    @State private var shownPhoto: TripRoutePhoto?

    /// A downloaded file, kept whole so the sheet can be `item`-bound:
    /// a `URL` alone is not `Identifiable`.
    private struct ExportedFile: Identifiable {
        let url: URL
        var id: String { url.absoluteString }
    }

    var body: some View {
        List {
            Section {
                if route.mapPoints.isEmpty {
                    // Nothing to draw and nothing to pretend: a map of
                    // the open Atlantic would be worse than a sentence.
                    Label("Zu dieser Strecke liegt kein Verlauf vor.",
                          systemImage: "map")
                        .foregroundStyle(.secondary)
                } else {
                    courseMap()
                        .frame(height: 260)
                        .listRowInsets(EdgeInsets())
                }
            } footer: {
                Text(route.hasCourse
                     ? "Der Verlauf kommt aus OpenStreetMap und ist für die Karte vereinfacht."
                     : "Für diese Strecke hat OpenStreetMap keinen zusammenhängenden Verlauf "
                       + "— gezeigt wird höchstens, wo sie beginnt.")
            }

            // Pictures, where Wikimedia has any. No section at all when
            // it has none: an empty strip or an apology would take the
            // space the facts below need (§15.3).
            if !photosLoaded {
                Section {
                    HStack { ProgressView(); Text("Bilder werden gesucht…").foregroundStyle(.secondary) }
                }
            } else if !photos.isEmpty {
                Section {
                    photoStrip()
                        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                } header: {
                    Text("Bilder")
                } footer: {
                    Text("Von Wikimedia Commons: Fotos der Orte am Weg und solche, die in "
                         + "seiner Nähe aufgenommen wurden. Nicht jedes zeigt den Weg selbst.")
                }
            }

            // What the way passes near the city, named where the map
            // has a name. Only the stretch near here: a long-distance
            // trail passes everything somewhere.
            if let highlights = route.highlights, !highlights.isEmpty {
                Section {
                    ForEach(highlights, id: \.self) { highlight in
                        if let phrase = highlight.phrase {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(phrase)
                                    if !highlight.names.isEmpty {
                                        Text(highlight.names.joined(separator: ", "))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            } icon: {
                                Image(systemName: highlight.symbolName)
                            }
                        }
                    }
                } header: {
                    Text("Unterwegs")
                } footer: {
                    Text("Was OpenStreetMap bis 150 m neben der Strecke kennt, "
                         + "im Umkreis der Etappe.")
                }
            }

            Section("Die Strecke") {
                LabeledContent("Länge", value: TripSpotExtent.kilometres(route.lengthM))
                if let ascentM = route.ascentM, ascentM > 0 {
                    LabeledContent("Anstieg", value: "\(ascentM) Hm")
                }
                LabeledContent("Dauer, geschätzt",
                               value: TripClock.duration(route.estimatedMinutes))
                if let difficulty = route.difficulty, !difficulty.isEmpty {
                    LabeledContent("Schwierigkeit", value: difficulty)
                }
                if route.roundtrip {
                    Label("Rundweg — endet, wo sie beginnt", systemImage: "arrow.triangle.capsulepath")
                        .font(.callout)
                }
                if let website = route.website, let url = URL(string: website) {
                    Link(destination: url) {
                        Label("Website der Strecke", systemImage: "safari")
                    }
                }
                if let wikipediaURL = route.wikipediaURL {
                    Link(destination: wikipediaURL) {
                        Label("Wikipedia-Artikel", systemImage: "book")
                    }
                }
                if let osmURL = openStreetMapURL {
                    Link(destination: osmURL) {
                        Label("In OpenStreetMap ansehen", systemImage: "map")
                    }
                }
            }

            Section {
                Button {
                    Task { await export() }
                } label: {
                    HStack {
                        Label("Als GPX exportieren", systemImage: "square.and.arrow.up")
                        Spacer()
                        if isExporting { ProgressView() }
                    }
                }
                .disabled(isExporting || !route.hasCourse)
            } footer: {
                Text(route.hasCourse
                     ? "Die Datei enthält den vollständigen Verlauf — feiner als die Linie "
                       + "oben — und lässt sich in Komoot, Organic Maps, Outdooractive oder "
                       + "auf ein Garmin übernehmen."
                     : "Ohne zusammenhängenden Verlauf gibt es nichts zu exportieren.")
            }

            if let onTake {
                Section {
                    Button {
                        Task {
                            isTaking = true
                            await onTake()
                            isTaking = false
                        }
                    } label: {
                        HStack {
                            Label("Zu den Kandidaten", systemImage: "plus.circle")
                            Spacer()
                            if isTaking { ProgressView() }
                        }
                    }
                    .disabled(isTaking)
                }
            }
        }
        .navigationTitle(route.name)
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(errorMessage, dismiss: { errorMessage = nil })
        .sheet(item: $exported) { file in
            TripFileShareSheet(url: file.url)
        }
        .sheet(item: $shownPhoto) { photo in
            TripRoutePhotoView(photo: photo)
        }
        .task { await loadPhotos() }
    }

    // MARK: - The pictures

    @ViewBuilder
    private func photoStrip() -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 10) {
                ForEach(photos) { photo in
                    Button {
                        shownPhoto = photo
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            AsyncImage(url: URL(string: photo.thumbUrl)) { phase in
                                switch phase {
                                case .success(let image):
                                    image.resizable().scaledToFill()
                                case .failure:
                                    Image(systemName: "photo")
                                        .foregroundStyle(.secondary)
                                default:
                                    ProgressView()
                                }
                            }
                            .frame(width: 200, height: 150)
                            .background(.quaternary)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            Text(photo.caption ?? photo.credit)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .frame(width: 200, alignment: .leading)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(photo.caption.map { "Bild: \($0)" } ?? "Bild entlang der Strecke")
                }
            }
            .padding(.horizontal, 16)
        }
        .frame(height: 176)
    }

    /// Quietly: a way without pictures, or a Commons that is down, is
    /// a screen without the strip — not an error over a route that is
    /// otherwise all there.
    private func loadPhotos() async {
        guard !photosLoaded else { return }
        defer { photosLoaded = true }
        var query = [
            "osmRef": route.osmRef,
            "legIndex": String(legIndex),
        ]
        if let radiusM { query["radiusM"] = String(radiusM) }
        do {
            let response: TripRoutePhotosResponse = try await APIClient.shared.get(
                "/trip-planner/plans/\(planId)/routes/photos",
                query: query,
            )
            photos = response.photos
        } catch {
            photos = []
        }
    }

    // MARK: - The map

    @ViewBuilder
    private func courseMap() -> some View {
        Map(initialPosition: .region(region)) {
            if route.hasCourse, let via = route.via {
                MapPolyline(coordinates: via.map(\.clCoordinate))
                    .stroke(.blue, style: StrokeStyle(lineWidth: 4,
                                                      lineCap: .round,
                                                      lineJoin: .round))
            }
            if let start = route.mapPoints.first {
                Annotation("Start", coordinate: start.clCoordinate) {
                    Image(systemName: "figure.walk.departure")
                        .font(.caption)
                        .padding(5)
                        .background(.background, in: .circle)
                        .overlay(Circle().stroke(.blue))
                }
            }
            // A loop ends where it began, so a second flag there would
            // say nothing the start has not already said.
            if !route.roundtrip, route.hasCourse, let end = route.mapPoints.last {
                Annotation("Ende", coordinate: end.clCoordinate) {
                    Image(systemName: "flag.checkered")
                        .font(.caption)
                        .padding(5)
                        .background(.background, in: .circle)
                        .overlay(Circle().stroke(.blue))
                }
            }
        }
        .mapControlVisibility(.hidden)
        .allowsHitTesting(false)
        .accessibilityLabel("Verlauf von \(route.name)")
    }

    /// The whole way on screen, with a little air around it.
    ///
    /// Computed from the course rather than left to `.automatic`: an
    /// automatic camera frames the annotations, and a way with one pin
    /// at each end is then shown at a zoom where the line between them
    /// runs off both edges.
    private var region: MKCoordinateRegion {
        let points = route.mapPoints
        guard let first = points.first else {
            return MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                span: MKCoordinateSpan(latitudeDelta: 1, longitudeDelta: 1),
            )
        }
        var minLat = first.lat, maxLat = first.lat
        var minLon = first.lon, maxLon = first.lon
        for point in points {
            minLat = min(minLat, point.lat)
            maxLat = max(maxLat, point.lat)
            minLon = min(minLon, point.lon)
            maxLon = max(maxLon, point.lon)
        }
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2,
                                           longitude: (minLon + maxLon) / 2),
            // A quarter more than the way needs, and never so tight
            // that a short way fills the screen with one hillside.
            span: MKCoordinateSpan(latitudeDelta: max((maxLat - minLat) * 1.25, 0.01),
                                   longitudeDelta: max((maxLon - minLon) * 1.25, 0.01)),
        )
    }

    private var openStreetMapURL: URL? {
        guard let id = route.relationId else { return nil }
        return URL(string: "https://www.openstreetmap.org/relation/\(id)")
    }

    // MARK: - The file

    private func export() async {
        isExporting = true
        defer { isExporting = false }
        do {
            let data = try await APIClient.shared.downloadData(
                "/trip-planner/routes/gpx",
                query: [
                    "planId": String(planId),
                    "legIndex": String(legIndex),
                    "osmRef": route.osmRef,
                ],
            )
            exported = ExportedFile(url: try write(data))
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// The file on disk, named after the way.
    ///
    /// In a directory of its own under the temporary directory, so a
    /// second export of the same way overwrites nothing that is still
    /// open in the share sheet, and the file that reaches Komoot is
    /// called what the way is called rather than `file.gpx`.
    private func write(_ data: Data) throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("gpx/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(TripGpxName.file(for: route.name))
        try data.write(to: url, options: .atomic)
        return url
    }
}

/// One picture, large, with whose it is and where it came from.
struct TripRoutePhotoView: View {
    let photo: TripRoutePhoto
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    AsyncImage(url: URL(string: photo.thumbUrl)) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                        case .failure:
                            Label("Bild konnte nicht geladen werden", systemImage: "photo")
                                .foregroundStyle(.secondary)
                        default:
                            ProgressView()
                        }
                    }
                    .aspectRatio(CGFloat(photo.aspectRatio), contentMode: .fit)
                    .frame(maxWidth: .infinity)

                    if let caption = photo.caption {
                        Text(caption).font(.headline)
                    }
                    Text(photo.credit)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let url = URL(string: photo.pageUrl) {
                        Link(destination: url) {
                            Label("Auf Wikimedia Commons ansehen", systemImage: "safari")
                        }
                    }
                }
                .padding()
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }
}

/// A file name somebody can find again in their downloads.
///
/// The server names the file too, in its `Content-Disposition`, but
/// `downloadData` hands back bytes and not headers — so the name is
/// built again here from the same rule. Kept as its own type because
/// that duplication is worth testing.
enum TripGpxName {
    static func file(for name: String) -> String {
        let slug = name
            .folding(options: .diacriticInsensitive, locale: Locale(identifier: "de_DE"))
            .replacingOccurrences(of: "ß", with: "ss")
            .lowercased()
            .map { $0.isLetter || $0.isNumber ? $0 : Character("-") }
            .reduce(into: "") { out, character in
                // No runs of separators, so "Weg — Runde" does not
                // become "weg---runde".
                if character == "-" && out.hasSuffix("-") { return }
                out.append(character)
            }
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
            .prefix(80)
        return "\(slug.isEmpty ? "strecke" : String(slug)).gpx"
    }
}

/// The system share sheet, for a file.
///
/// `ShareLink` would do for a URL known when the view is built; this
/// one appears only once the download has finished, which is what
/// `item`-bound presentation is for.
struct TripFileShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
