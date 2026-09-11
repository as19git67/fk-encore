import CoreLocation
import SwiftUI

/// Loading and changing the idea collection (§20.1).
///
/// Thin in the same way `TripPlannerViewModel` is: every rule the
/// concept cares about lives on the server — which OSM entry a
/// coordinate matches, what counts as a duplicate, who may write into a
/// collection — and this only fetches the answer and shows it.
///
/// One decision does live here, and it is about honesty rather than
/// logic: when a place is added from where somebody is standing, the
/// server may answer that it matched nothing (`unmatched`) or that it
/// folded into an idea already collected (`merged`). Both are told
/// plainly instead of being smoothed into "gespeichert" — the first
/// means category and duration are guesses, and the second means the
/// list will not grow, which somebody who just tapped "merken" would
/// otherwise read as a failure.
@Observable @MainActor
final class TripIdeasViewModel {
    private(set) var entries: [TripIdea] = []
    private(set) var collections: [TripIdeaCollection] = []
    /// Whose collection is on screen. Nil means the caller's own.
    var ownerId: Int?
    private(set) var isLoading = false
    private(set) var isAdding = false
    var errorMessage: String?
    /// What the last addition did, in the server's own words.
    var lastAddition: String?

    var collection: TripIdeaCollection? {
        guard let ownerId else { return collections.first(where: \.own) }
        return collections.first { $0.ownerId == ownerId }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: TripIdeasResponse = try await APIClient.shared.get(
                "/trip-planner/ideas",
                query: ownerId.map { ["ownerId": String($0)] },
            )
            entries = response.entries
            collections = response.collections
            errorMessage = nil
        } catch {
            errorMessage = "Der Vorrat ließ sich nicht laden."
        }
    }

    /// Remember where you are standing.
    ///
    /// - Parameter locationProvider: injectable for tests. Built inside
    ///   rather than as a default argument, because default arguments
    ///   are evaluated outside the actor and the provider is main-actor
    ///   isolated.
    func addHere(
        note: String?,
        locationProvider: TripLocationProvider? = nil,
    ) async {
        isAdding = true
        defer { isAdding = false }

        let provider = locationProvider
            ?? TripLocationProvider(accuracy: kCLLocationAccuracyNearestTenMeters)
        guard let location = await provider.currentLocation() else {
            errorMessage = "Ohne Standort lässt sich nichts merken — der Vorrat bräuchte den Ort."
            return
        }

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let ownerId: Int?
            let note: String?
        }
        do {
            let response: TripIdeaAddResponse = try await APIClient.shared.post(
                "/trip-planner/ideas",
                body: Body(
                    lat: location.coordinate.latitude,
                    lon: location.coordinate.longitude,
                    ownerId: ownerId,
                    note: note?.isEmpty == true ? nil : note,
                ),
            )
            lastAddition = Self.sentence(for: response)
            errorMessage = nil
            await load()
        } catch {
            errorMessage = "Das ließ sich nicht merken."
        }
    }

    /// What to say after an addition — pure, so the wording is testable.
    static func sentence(for response: TripIdeaAddResponse) -> String {
        var parts: [String] = []
        parts.append(
            response.merged
                ? "\(response.entry.displayName) war schon im Vorrat — ergänzt."
                : "\(response.entry.displayName) ist im Vorrat.",
        )
        if !response.unknown.isEmpty {
            // Named rather than hidden: an entry the map does not know
            // carries guesses, and a screen that keeps that to itself
            // presents a guess as a fact (§15.3).
            parts.append("Unbekannt: \(response.unknown.joined(separator: ", ")).")
        }
        return parts.joined(separator: " ")
    }

    func remove(_ idea: TripIdea) async {
        struct Body: Encodable {
            let id: Int
            let ownerId: Int?
        }
        // Taken out of the list first: the row is gone under the finger
        // that swiped it, and the reload behind it confirms rather than
        // performs. A list that waits for the server to answer feels
        // broken on a train.
        let before = entries
        entries.removeAll { $0.id == idea.id }
        do {
            let _: [String: Bool] = try await APIClient.shared.post(
                "/trip-planner/ideas/remove",
                body: Body(id: idea.id, ownerId: ownerId),
            )
            errorMessage = nil
        } catch {
            entries = before
            errorMessage = "\(idea.displayName) ließ sich nicht entfernen."
        }
    }

    /// Let somebody else write into your own collection (§20.1, §6.2).
    func share(with email: String) async {
        struct Body: Encodable { let email: String }
        do {
            let _: [String: [TripIdeaCollection]] = try await APIClient.shared.post(
                "/trip-planner/ideas/share",
                body: Body(email: email.trimmingCharacters(in: .whitespaces)),
            )
            errorMessage = nil
            lastAddition = "\(email) schreibt jetzt mit."
        } catch {
            errorMessage = "Niemand mit dieser Adresse gefunden."
        }
    }
}
