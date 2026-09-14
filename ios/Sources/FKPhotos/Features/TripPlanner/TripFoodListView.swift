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
///
/// Opened from a meal block, it can also **put a place into that
/// block**: the find goes to the leg's candidates the way a shared link
/// does (§9.2) and is then placed, so "wir essen hier" is one tap and
/// not a trip through the pool. Without a block — the view works on its
/// own — the rows only look and call.
struct TripFoodListView: View {
    let position: TripCoordinate
    /// The block this list was opened from, when it was. Nil leaves the
    /// rows without the way into the plan.
    var target: BlockTarget? = nil
    /// Called after a place was put into the block, so the screen that
    /// owns the plan can reload it.
    var onPlaced: (() async -> Void)? = nil

    /// Where a chosen place goes: which plan, which leg, which day,
    /// which block. Everything the two calls need, handed in rather
    /// than looked up — this view has no plan of its own.
    struct BlockTarget: Sendable {
        let planId: Int
        let legIndex: Int
        let dayIndex: Int
        let blockId: String
    }

    @State private var places: [FoodPlace] = []
    @State private var consideredCount = 0
    @State private var isLoading = false
    @State private var errorMessage: String?
    /// The place being written into the plan, while it is.
    @State private var placingRef: String?
    /// What became of a place put into the block, by its ref — shown on
    /// the row so the list says what it did rather than going quiet.
    @State private var placed: [String: String] = [:]

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
                } else if errorMessage != nil {
                    // The banner above says what went wrong; a grey
                    // "nothing found" here would say something else.
                    EmptyView()
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
        .plannerErrorBanner(errorMessage, retry: { await load() }, dismiss: { errorMessage = nil })
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
                // would be a claim we cannot stand behind. Prefixed with
                // where it comes from, so "Mo-Fr 11:00-22:00" reads as
                // somebody's tag and not as this app's promise.
                Text("Laut OpenStreetMap: \(hours)")
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

            if target != nil {
                if let outcome = placed[place.osmRef] {
                    Label(outcome, systemImage: "checkmark.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
                } else {
                    Button {
                        Task { await put(place) }
                    } label: {
                        if placingRef == place.osmRef {
                            HStack { ProgressView(); Text("Wird eingetragen\u{2026}") }
                        } else {
                            Label("In diesen Block setzen", systemImage: "plus.circle")
                        }
                    }
                    .font(.caption)
                    .buttonStyle(.bordered)
                    .disabled(placingRef != nil)
                    .padding(.top, 2)
                }
            }
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

    /// Put one place into the block this list was opened from.
    ///
    /// Two calls, in the order the plan understands them: first the
    /// place becomes a candidate of the leg — the find path (§9.2), with
    /// the leg named so it does not land in whichever leg is nearest —
    /// then the candidate is placed in the block. If the first succeeds
    /// and the second does not, the row says so: the place is in the
    /// candidates, and that is worth knowing rather than a bare error.
    private func put(_ place: FoodPlace) async {
        guard let target else { return }
        placingRef = place.osmRef
        defer { placingRef = nil }

        struct Added: Decodable {
            struct Entry: Decodable { let osmRef: String }
            let entry: Entry
            let merged: Bool
        }
        struct PlaceBody: Encodable {
            let legIndex: Int
            let dayIndex: Int
            let blockId: String
            let osmRef: String
        }
        struct Placed: Decodable {
            let overfullBlockIds: [String]
        }

        let added: Added
        do {
            added = try await APIClient.shared.post(
                "/trip-planner/plans/\(target.planId)/finds",
                body: TripAddFindRequest(
                    lat: place.lat,
                    lon: place.lon,
                    name: place.name,
                    note: nil,
                    sourceUrl: nil,
                    legIndex: target.legIndex,
                    // An hour: the one figure a meal needs, sent so the
                    // find is never refused for want of one when the
                    // map's entry does not match after all.
                    dwellMinutes: 60,
                ),
            )
        } catch {
            errorMessage = "\(place.displayName) ließ sich nicht zu den Kandidaten legen."
            return
        }

        do {
            let result: Placed = try await APIClient.shared.post(
                "/trip-planner/plans/\(target.planId)/pool/place",
                body: PlaceBody(
                    legIndex: target.legIndex,
                    dayIndex: target.dayIndex,
                    blockId: target.blockId,
                    osmRef: added.entry.osmRef,
                ),
            )
            // Over budget is said, never hidden (§8.4): the traveller
            // decided, and the cost of the decision is theirs to see.
            placed[place.osmRef] = result.overfullBlockIds.contains(target.blockId)
                ? "Im Block — der ist damit übervoll."
                : "Im Block."
            errorMessage = nil
            await onPlaced?()
        } catch {
            placed[place.osmRef] = added.merged
                ? "Bei den Kandidaten (war schon dabei) — in den Block ließ es sich nicht setzen."
                : "Bei den Kandidaten — in den Block ließ es sich nicht setzen."
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
            errorMessage = TripErrorText.describe(error)
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
