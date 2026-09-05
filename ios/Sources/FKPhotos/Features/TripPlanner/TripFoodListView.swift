import MapKit
import SwiftUI

/// Somewhere to eat, here, now (§10.3).
///
/// A filtered list, not a ranking. Open data knows that a restaurant
/// exists, not whether it is any good, so the order is by distance and
/// nothing else — and the screen has to look like that, or it will be
/// read as a recommendation anyway. Hence: no stars, no badges, no
/// "top pick", and the distance is the most prominent thing on a row
/// after the name.
///
/// The attributes are shown only where OSM has them. A missing tag is
/// unknown, never "no": rendering an untagged place with a grey
/// crossed-out leaf would invent a fact about it.
struct TripFoodListView: View {
    let position: TripCoordinate

    @State private var places: [FoodPlace] = []
    @State private var consideredCount = 0
    @State private var isLoading = false
    @State private var errorMessage: String?

    @State private var vegetarian = false
    @State private var vegan = false
    @State private var outdoorSeating = false
    @State private var wheelchair = false
    @State private var onlyCafes = false

    @AppStorage(TripMapsPreference.key) private var mapsPreference: String = TripMapsApp.apple.rawValue

    var body: some View {
        List {
            Section {
                Toggle("Vegetarisch", isOn: $vegetarian)
                Toggle("Vegan", isOn: $vegan)
                Toggle("Draußen sitzen", isOn: $outdoorSeating)
                Toggle("Stufenlos", isOn: $wheelchair)
                Toggle("Nur Cafés", isOn: $onlyCafes)
            } header: {
                Text("Filter")
            } footer: {
                Text("Gefiltert nach dem, was OpenStreetMap verzeichnet, sortiert nach "
                     + "Entfernung. Keine Bewertung — die kennen wir nicht.")
            }

            Section {
                if isLoading {
                    ProgressView()
                } else if let errorMessage {
                    Text(errorMessage).foregroundStyle(.secondary)
                } else if places.isEmpty {
                    Text(anyFilterOn
                         ? "Nichts in der Nähe, das diese Angaben trägt. "
                           + "Viele Lokale sind in OpenStreetMap kaum getaggt — ohne Filter "
                           + "steht meist mehr da."
                         : "Nichts in der Nähe gefunden.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(places) { place in
                        row(place)
                    }
                }
            } header: {
                if !places.isEmpty {
                    Text("\(places.count) von \(consideredCount) in der Nähe")
                }
            }
        }
        .navigationTitle("Essen in der Nähe")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: filterKey) { await load() }
        .refreshable { await load() }
    }

    private var anyFilterOn: Bool {
        vegetarian || vegan || outdoorSeating || wheelchair
    }

    /// Re-runs the search whenever a filter changes.
    private var filterKey: String {
        "\(vegetarian)\(vegan)\(outdoorSeating)\(wheelchair)\(onlyCafes)"
    }

    private func row(_ place: FoodPlace) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(place.displayName)
                Spacer()
                Text(place.distanceLabel)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }

            if let subtitle = place.attributeLine {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let hours = place.openingHours {
                // Verbatim, because OSM's syntax is the only thing that
                // is actually true — paraphrasing it into "open now"
                // would be a claim we cannot stand behind.
                Text(hours)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 16) {
                Button {
                    openInMaps(place)
                } label: {
                    Label("In Karten ansehen", systemImage: "map")
                }
                if let phone = place.phoneURL {
                    Link(destination: phone) {
                        Label("Anrufen", systemImage: "phone")
                    }
                }
                if let website = place.websiteURL {
                    Link(destination: website) {
                        Label("Website", systemImage: "safari")
                    }
                }
            }
            .font(.caption)
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(.vertical, 2)
    }

    private func openInMaps(_ place: FoodPlace) {
        // Looking a place up is a handoff like any other, so it follows
        // the same setting as navigation (§9.1).
        let app = TripMapsAvailability(
            preference: TripMapsApp(rawValue: mapsPreference) ?? .apple,
            googleAppInstalled: UIApplication.shared.canOpenURL(
                URL(string: "\(TripMapsApp.googleScheme)://")!,
            ),
        ).resolved ?? .apple

        let coordinate = TripCoordinate(lat: place.lat, lon: place.lon)
        switch app {
        case .google:
            if let url = TripMapsURL.googleLookup(coordinate, name: place.name) {
                UIApplication.shared.open(url)
            }
        case .apple, .ask:
            let item = MKMapItem(placemark: MKPlacemark(coordinate: coordinate.clCoordinate))
            item.name = place.name
            item.openInMaps()
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        struct Body: Encodable {
            let position: TripCoordinate
            let vegetarian: Bool
            let vegan: Bool
            let outdoorSeating: Bool
            let wheelchair: Bool
            let categories: [String]?
        }
        do {
            let response: NearbyFoodResponse = try await APIClient.shared.post(
                "/trip-planner/food",
                body: Body(
                    position: position,
                    vegetarian: vegetarian,
                    vegan: vegan,
                    outdoorSeating: outdoorSeating,
                    wheelchair: wheelchair,
                    categories: onlyCafes ? ["cafe"] : nil,
                ),
            )
            places = response.places
            consideredCount = response.consideredCount
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct NearbyFoodResponse: Codable, Sendable {
    let region: String
    let places: [FoodPlace]
    let consideredCount: Int
}

struct FoodPlace: Codable, Identifiable, Sendable {
    let osmRef: String
    let name: String?
    let lat: Double
    let lon: Double
    let distanceM: Int
    let kind: String?
    let categories: [String]
    /// Straight from OSM and unverified. Absent means **unknown**, not
    /// "no" — the row must not render a missing tag as a refusal.
    let cuisine: String?
    let openingHours: String?
    let dietVegetarian: String?
    let dietVegan: String?
    let outdoorSeating: String?
    let wheelchair: String?
    let phone: String?
    let website: String?

    var id: String { osmRef }
    var displayName: String { name ?? "Unbenanntes Lokal" }

    var distanceLabel: String {
        distanceM < 1_000 ? "\(distanceM) m" : String(format: "%.1f km", Double(distanceM) / 1_000)
    }

    /// The attributes OSM actually carries, joined into one line. Only
    /// what is present: an untagged place gets no line rather than a row
    /// of crossed-out icons it never earned.
    var attributeLine: String? {
        var parts: [String] = []
        if let cuisine, !cuisine.isEmpty {
            // OSM separates several cuisines with semicolons.
            parts.append(cuisine.split(separator: ";").joined(separator: ", "))
        }
        if let label = FoodPlace.dietLabel(dietVegan, affirmative: "vegan") { parts.append(label) }
        if let label = FoodPlace.dietLabel(dietVegetarian, affirmative: "vegetarisch") {
            parts.append(label)
        }
        if outdoorSeating == "yes" { parts.append("draußen") }
        if wheelchair == "yes" { parts.append("stufenlos") }
        else if wheelchair == "limited" { parts.append("teilweise stufenlos") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// "vegan", "nur vegan", "vegan (begrenzt)" — or nothing at all for
    /// "no" and for a missing tag, which are different facts but neither
    /// belongs on the line.
    static func dietLabel(_ value: String?, affirmative: String) -> String? {
        switch value {
        case "yes":     return affirmative
        case "only":    return "nur \(affirmative)"
        case "limited": return "\(affirmative) (begrenzt)"
        default:        return nil
        }
    }

    var phoneURL: URL? {
        guard let phone, !phone.isEmpty else { return nil }
        let digits = phone.filter { $0.isNumber || $0 == "+" }
        return digits.isEmpty ? nil : URL(string: "tel:\(digits)")
    }

    var websiteURL: URL? {
        guard let website, !website.isEmpty else { return nil }
        // OSM carries plenty of bare hostnames.
        let candidate = website.hasPrefix("http") ? website : "https://\(website)"
        return URL(string: candidate)
    }
}
