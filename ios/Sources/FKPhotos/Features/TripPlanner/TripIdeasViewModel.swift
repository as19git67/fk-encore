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
    /// A shared link waiting to be collected (§9.2, way 1). Peeked
    /// rather than taken, so leaving the screen does not lose it.
    private(set) var pendingShare: TripSharePayload?
    /// The place that link names, once it has been read. Nil while a
    /// short link is still being resolved, and for a link that names
    /// none — a share with no coordinate belongs to a trip's analysis,
    /// not here.
    private(set) var sharedPlace: TripMapLink.Place?

    var collection: TripIdeaCollection? {
        guard let ownerId else { return collections.first(where: \.own) }
        return collections.first { $0.ownerId == ownerId }
    }

    /// Look whether the share sheet left something a link can be read from.
    ///
    /// Only map links are picked up here. An article or a bare piece of
    /// text needs the region search and the language model to become a
    /// place, and that path belongs to a trip (§9.3) — offering it in a
    /// collection with no trip behind it would promise a reading nobody
    /// can do here.
    func checkShare(_ payload: TripSharePayload? = TripShareInbox.peek()) async {
        guard let payload, let url = payload.url else {
            pendingShare = nil
            sharedPlace = nil
            return
        }
        if let place = TripMapLink.place(from: url) {
            pendingShare = payload
            sharedPlace = place
            return
        }
        // A short link carries no coordinate until it has been followed.
        if let resolved = await Self.resolve(url), let place = TripMapLink.place(from: resolved) {
            pendingShare = payload
            sharedPlace = place
            return
        }
        pendingShare = nil
        sharedPlace = nil
    }

    /// Follow a short link to the address it stands for.
    ///
    /// `nonisolated` and static: it is a network call with no state
    /// behind it, and holding the main actor while a redirect chain
    /// resolves would freeze the list for no reason.
    nonisolated static func resolve(_ urlString: String) async -> String? {
        guard let url = URL(string: urlString), TripMapLink.isMapLink(url) else { return nil }
        let session = URLSession(configuration: .ephemeral)
        do {
            let (_, response) = try await session.data(from: url)
            return response.url?.absoluteString
        } catch {
            return nil
        }
    }

    /// Put the shared place into the collection.
    ///
    /// The name from the link is offered as the title rather than
    /// written as the map's name: `q=` is what the sender's app called
    /// it, which is often what *they* call it — and the server decides
    /// separately whether an OSM entry sits within eighty metres.
    func addShared(note: String?) async {
        guard let place = sharedPlace, let payload = pendingShare else { return }
        isAdding = true
        defer { isAdding = false }

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let ownerId: Int?
            let name: String?
            let note: String?
            let sourceUrl: String?
        }
        do {
            let response: TripIdeaAddResponse = try await APIClient.shared.post(
                "/trip-planner/ideas",
                body: Body(
                    lat: place.lat,
                    lon: place.lon,
                    ownerId: ownerId,
                    name: place.name ?? payload.title,
                    note: note?.isEmpty == true ? nil : note,
                    sourceUrl: payload.url,
                ),
            )
            lastAddition = response.sentence
            errorMessage = nil
            // Only now: a payload consumed before the server agreed
            // would be gone after a failed request, and the link with it.
            TripShareInbox.clear()
            pendingShare = nil
            sharedPlace = nil
            await load()
        } catch {
            errorMessage = "Der geteilte Ort ließ sich nicht merken."
        }
    }

    /// "Not into the collection" — the link stays in the inbox for the
    /// trip picker, which is the other thing it could have meant.
    func dismissShare() {
        pendingShare = nil
        sharedPlace = nil
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
            lastAddition = response.sentence
            errorMessage = nil
            await load()
        } catch {
            errorMessage = "Das ließ sich nicht merken."
        }
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
