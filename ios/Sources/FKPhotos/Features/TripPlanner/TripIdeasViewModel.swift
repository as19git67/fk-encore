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
/// **Nothing pure lives here.** Constants belong on `TripIdeaDefaults`
/// and wording on the response it reads — this class is `@MainActor`,
/// so anything put on it becomes actor-isolated and unreachable from a
/// test. Two red builds made that point; the third would be nobody's
/// fault but this comment's.
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
    /// A shared link that names no place — an article, most likely.
    /// Set instead of dropping the share silently, so the screen can
    /// offer the reading it cannot do itself (§9.3).
    private(set) var sharedArticleUrl: String?
    /// The share somebody waved away with „Später" in this session, so
    /// the next `checkShare` does not offer the same link again. Not
    /// persisted: the link stays in the inbox for the trip picker, and
    /// a fresh launch may well be the moment it is wanted here.
    private var dismissedShare: TripSharePayload?
    /// What is near here, once somebody asked (§20.2).
    private(set) var nearby: [TripNearIdea] = []
    /// In range but deliberately not offered — told recently, or waved
    /// away often enough. A number, never a list.
    private(set) var quietNearby = 0
    private(set) var isLoadingNearby = false
    var nearbyError: String?
    /// The outing on offer, once somebody asked (§20.2).
    private(set) var outing: TripOutingProposal?
    /// Where it would start — kept so accepting uses the same anchor the
    /// proposal was computed from, not wherever the phone is by then.
    private(set) var outingAnchor: CLLocationCoordinate2D?
    /// The anchor the proposal was *asked* around when it was a group
    /// of ideas rather than the phone — nil for a proposal from where
    /// somebody stands. The outing screen compares it with its own to
    /// tell a stale proposal from one that is its.
    private(set) var outingRequestedAround: TripCoordinate?
    /// How long the outing may take. Bound to the screen's picker, and
    /// re-proposing is the screen's job — a budget that changes under a
    /// proposal without recomputing would show a day for a different
    /// afternoon.
    var outingBudgetMinutes = TripIdeaDefaults.outingBudgetMinutes
    private(set) var isProposing = false
    private(set) var isAcceptingOuting = false
    var outingError: String?

    var collection: TripIdeaCollection? {
        guard let ownerId else { return collections.first(where: \.own) }
        return collections.first { $0.ownerId == ownerId }
    }

    // MARK: - What is near here (§20.2)

    /// Ideas near the current position, and how many were held back.
    ///
    /// **Asked with `markSuggested: false`, and that is the whole
    /// point.** §20.2 makes being returned the same as being told, and
    /// then keeps quiet about that entry for a week. A screen somebody
    /// opened is not a notification: spending the week's silence because
    /// a person looked at a list would make the rule punish curiosity.
    func loadNearby(locationProvider: TripLocationProvider? = nil) async {
        isLoadingNearby = true
        defer { isLoadingNearby = false }

        let provider = locationProvider
            ?? TripLocationProvider(accuracy: kCLLocationAccuracyHundredMeters)
        guard let location = await provider.currentLocation() else {
            nearbyError = "Ohne Standort lässt sich nicht sagen, was hier in der Nähe ist."
            return
        }

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let radiusM: Int
            let ownerId: Int?
            let markSuggested: Bool
        }
        do {
            let response: TripIdeaNearbyResponse = try await APIClient.shared.post(
                "/trip-planner/ideas/nearby",
                body: Body(
                    lat: location.coordinate.latitude,
                    lon: location.coordinate.longitude,
                    radiusM: TripIdeaDefaults.nearbyRadiusM,
                    ownerId: ownerId,
                    markSuggested: false,
                ),
            )
            nearby = response.ideas
            quietNearby = response.quiet
            nearbyError = nil
        } catch {
            nearbyError = "Die Umgebung ließ sich nicht abfragen."
        }
    }

    /// "Nicht jetzt."
    ///
    /// Counted, not acted on: the entry stays in the collection, and
    /// after enough of these it simply stops speaking up (§20.2). So the
    /// row goes off *this* screen — which is what the tap meant — and
    /// the collection keeps it.
    func dismissNearby(_ idea: TripNearIdea) async {
        struct Body: Encodable {
            let id: Int
            let ownerId: Int?
        }
        let before = nearby
        nearby.removeAll { $0.id == idea.id }
        do {
            let _: [String: Int] = try await APIClient.shared.post(
                "/trip-planner/ideas/dismiss",
                body: Body(id: idea.id, ownerId: ownerId),
            )
            nearbyError = nil
        } catch {
            nearby = before
            nearbyError = "Das ließ sich nicht merken."
        }
    }

    // MARK: - The outing (§20.2, §20.3)

    /// „Soll ich daraus einen Nachmittag machen?"
    ///
    /// The call that turns the collection into a planner: a pool, an
    /// anchor and a time budget *are* the planner's input, and the only
    /// thing missing was the occasion. Nothing is written — the answer
    /// is a proposal, and accepting it is a second, deliberate step.
    ///
    /// - Parameter around: a place to start from instead of the phone —
    ///   the middle of a group in the collection, when the question is
    ///   asked from the list rather than from the street. Nil asks
    ///   where the phone is.
    func proposeOuting(
        around: TripCoordinate? = nil,
        locationProvider: TripLocationProvider? = nil,
    ) async {
        isProposing = true
        defer { isProposing = false }

        let anchor: CLLocationCoordinate2D
        if let around {
            anchor = CLLocationCoordinate2D(latitude: around.lat, longitude: around.lon)
        } else {
            let provider = locationProvider
                ?? TripLocationProvider(accuracy: kCLLocationAccuracyHundredMeters)
            guard let location = await provider.currentLocation() else {
                outingError = "Ohne Standort lässt sich kein Ausflug vorschlagen."
                return
            }
            anchor = location.coordinate
        }
        outingAnchor = anchor
        outingRequestedAround = around

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let radiusM: Int
            let budgetMinutes: Int
            let ownerId: Int?
        }
        do {
            outing = try await APIClient.shared.post(
                "/trip-planner/ideas/outing",
                body: Body(
                    lat: anchor.latitude,
                    lon: anchor.longitude,
                    radiusM: TripIdeaDefaults.outingRadiusM,
                    budgetMinutes: outingBudgetMinutes,
                    ownerId: ownerId,
                ),
            )
            outingError = nil
        } catch {
            outingError = "Der Ausflug ließ sich nicht berechnen."
        }
    }

    /// Does the proposal on hand belong to this anchor?
    ///
    /// The outing screen is reached from two places — the nearby list,
    /// which means "here", and a group in the collection, which means
    /// "there" — and a proposal computed for one must not be shown as
    /// the answer for the other.
    func hasOuting(around: TripCoordinate?) -> Bool {
        outing != nil && outingRequestedAround == around
    }

    /// Take the proposal, and get an ordinary one-day trip out of it (§20.3).
    ///
    /// Only the ideas from the collection are handed over: what the
    /// region search filled up with is a suggestion for *this* day and
    /// has no business being written into the collection on the way.
    /// The trip is planned from them, and the answer says which made it
    /// onto the day and which stayed in its pool.
    func acceptOuting(date: String, title: String?) async -> Int? {
        guard let outing, outing.offered, let anchor = outingAnchor else { return nil }
        let ideaIds = collectedIds(in: outing)
        guard !ideaIds.isEmpty else {
            outingError = "Ohne eigene Ideen wird daraus keine Reise."
            return nil
        }

        isAcceptingOuting = true
        defer { isAcceptingOuting = false }

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let ideaIds: [Int]
            let ownerId: Int?
            let date: String
            let title: String?
            let budgetMinutes: Int
        }
        do {
            let response: TripOutingAcceptResponse = try await APIClient.shared.post(
                "/trip-planner/ideas/outing/accept",
                body: Body(
                    lat: anchor.latitude,
                    lon: anchor.longitude,
                    ideaIds: ideaIds,
                    ownerId: ownerId,
                    date: date,
                    title: title?.isEmpty == true ? nil : title,
                    // The budget the proposal was computed with, not the
                    // picker's current value: accepting means "this day",
                    // and the two differ the moment somebody moves the
                    // picker and does not wait for the recomputation.
                    budgetMinutes: outing.budgetMinutes,
                ),
            )
            outingError = nil
            lastAddition = response.sentence
            return response.plan.id
        } catch {
            outingError = "Aus dem Vorschlag ließ sich keine Reise machen."
            return nil
        }
    }

    /// Which of the proposal's stops came out of the collection.
    ///
    /// Matched by reference against the entries on screen: the proposal
    /// says `fromIdeas`, but not which id, and accepting needs the ids.
    private func collectedIds(in outing: TripOutingProposal) -> [Int] {
        let refs = Set(outing.stops.filter(\.fromIdeas).map(\.osmRef))
        return entries.filter { refs.contains($0.osmRef) }.map(\.id)
    }

    /// Look whether the share sheet left something a link can be read from.
    ///
    /// Only map links are picked up here. An article or a bare piece of
    /// text needs the region search and the language model to become a
    /// place, and that path belongs to a trip (§9.3) — offering it in a
    /// collection with no trip behind it would promise a reading nobody
    /// can do here.
    func checkShare(_ payload: TripSharePayload? = TripShareInbox.peek()) async {
        guard let payload, let url = payload.url, payload != dismissedShare else {
            pendingShare = nil
            sharedPlace = nil
            sharedArticleUrl = nil
            return
        }
        sharedArticleUrl = nil
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
        // Everything the local reader does not know — which is every
        // Google Maps link, `geo:`, OpenStreetMap and the short forms
        // of all of them. The server has read all of these since the
        // share sheet existed; it was only ever reachable through a
        // trip, which is the one thing the collection does not have.
        if let place = await readOnServer(url) {
            pendingShare = payload
            sharedPlace = place
            return
        }
        // No place in it, by any reader: an article, most likely. Said
        // rather than dropped — the collection cannot read it (that
        // needs an area and the language model, §9.3), but it can say
        // where that reading happens.
        pendingShare = payload
        sharedPlace = nil
        sharedArticleUrl = url
    }

    /// Ask the server what the link says.
    ///
    /// Deliberately silent on failure: a share that turns out to be an
    /// article is not an error here, it is a share for a trip's
    /// analysis (§9.3), and the link stays in the inbox for that.
    private func readOnServer(_ url: String) async -> TripMapLink.Place? {
        struct Body: Encodable { let url: String }
        struct Read: Decodable {
            let isMapLink: Bool
            let lat: Double?
            let lon: Double?
            let name: String?
        }
        do {
            let read: Read = try await APIClient.shared.post(
                "/trip-planner/map-link", body: Body(url: url))
            guard let lat = read.lat, let lon = read.lon else { return nil }
            return TripMapLink.Place(lat: lat, lon: lon, name: read.name)
        } catch {
            return nil
        }
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
    func addShared(note: String?, dwellMinutes: Int) async {
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
            /// See `addHere`: a place the map does not know has no
            /// duration but the one somebody names.
            let dwellMinutes: Int
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
                    dwellMinutes: dwellMinutes,
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
    ///
    /// Remembered for this session: „Später" answered once is answered,
    /// and a screen that asks again every time it comes to the front
    /// has turned a share into nagging.
    func dismissShare() {
        dismissedShare = pendingShare
        pendingShare = nil
        sharedPlace = nil
        sharedArticleUrl = nil
    }

    // MARK: - Into a trip (§20.3)

    /// Take one collected idea into a trip's candidates.
    ///
    /// The same endpoint the trip's own „Aus dem Vorrat" screen calls,
    /// reached from the other end: standing in the collection and
    /// knowing which trip wants this. The idea stays collected — it is
    /// used, not consumed. Returns the sentence to show, or nil after a
    /// failure that `errorMessage` describes.
    func takeIdea(_ idea: TripIdea, into plan: TripPlanSummary) async -> String? {
        struct Body: Encodable {
            let id: Int
            let ownerId: Int?
        }
        do {
            let response: TripIdeaTakeResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(plan.id)/ideas/take",
                body: Body(id: idea.id, ownerId: idea.ownerId ?? ownerId),
            )
            errorMessage = nil
            let sentence = response.sentence(idea: idea.displayName, plan: plan.displayTitle)
            lastAddition = sentence
            return sentence
        } catch {
            errorMessage = "\(idea.displayName) ließ sich nicht in die Reise übernehmen."
            return nil
        }
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
            errorMessage = "Die Ideen ließen sich nicht laden."
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
        dwellMinutes: Int,
        locationProvider: TripLocationProvider? = nil,
    ) async {
        isAdding = true
        defer { isAdding = false }

        let provider = locationProvider
            ?? TripLocationProvider(accuracy: kCLLocationAccuracyNearestTenMeters)
        guard let location = await provider.currentLocation() else {
            errorMessage = "Ohne Standort lässt sich nichts merken — eine Idee braucht ihren Ort."
            return
        }

        struct Body: Encodable {
            let lat: Double
            let lon: Double
            let ownerId: Int?
            let note: String?
            /// Asked for, never assumed. Where OpenStreetMap knows the
            /// spot the server prefers its own figure; where it does
            /// not, this is the only answer there is — and without it
            /// the whole call was refused, which is what made "merken"
            /// look as though it had worked and changed nothing.
            let dwellMinutes: Int
        }
        do {
            let response: TripIdeaAddResponse = try await APIClient.shared.post(
                "/trip-planner/ideas",
                body: Body(
                    lat: location.coordinate.latitude,
                    lon: location.coordinate.longitude,
                    ownerId: ownerId,
                    note: note?.isEmpty == true ? nil : note,
                    dwellMinutes: dwellMinutes,
                ),
            )
            lastAddition = response.sentence
            errorMessage = nil
            await load()
        } catch {
            errorMessage = "Das ließ sich nicht merken."
        }
    }

    // MARK: - Sorted into places (§20.1)

    /// The collection grouped by where things are, newest group first.
    ///
    /// Computed rather than stored: it is a reading of `entries`, and a
    /// second copy would be one more thing to keep in step with adding,
    /// removing and correcting.
    var clusters: [TripIdeaCluster] { TripIdeaClusters.group(entries) }

    /// What each group is called, once Apple has said. Keyed by the
    /// group's id.
    private(set) var clusterNames: [Int: String] = [:]

    /// Ask the geocoder what these places are called.
    ///
    /// Apple names, fk-encore plans (§9.1) — nothing here knows what a
    /// region is called, and a name derived from the entries would call
    /// a group of nine after whichever one was saved first.
    ///
    /// One at a time, and only for a group somebody can see: `CLGeocoder`
    /// is a shared, rate-limited service, and a collection with thirty
    /// groups asking at once gets every request refused rather than the
    /// first few answered. The section header asks when it appears, so
    /// the groups below the fold cost nothing until they are scrolled
    /// to. A group with no name keeps its count, which is honest and
    /// readable.
    func nameCluster(_ cluster: TripIdeaCluster) async {
        guard clusterNames[cluster.id] == nil, !namingClusters.contains(cluster.id) else { return }
        namingClusters.insert(cluster.id)
        defer { namingClusters.remove(cluster.id) }

        let location = CLLocation(latitude: cluster.centre.lat, longitude: cluster.centre.lon)
        guard let placemark = try? await CLGeocoder().reverseGeocodeLocation(location).first else {
            return
        }
        let name = placemark.locality
            ?? placemark.subAdministrativeArea
            ?? placemark.administrativeArea
            ?? placemark.country
        if let name, !name.isEmpty { clusterNames[cluster.id] = name }
    }

    /// Groups a geocoder request is out for, so a header that appears
    /// twice while scrolling does not ask twice.
    private var namingClusters: Set<Int> = []

    /// The heading for one group: the place, or how many are in it.
    func title(of cluster: TripIdeaCluster) -> String {
        clusterNames[cluster.id] ?? cluster.fallbackTitle
    }

    // MARK: - Correcting one (§20)

    /// Save what somebody changed about a collected place.
    ///
    /// Only the fields the sheet carries are sent, and the server
    /// leaves the rest alone — the entry's dates and its photo-stop
    /// flag survive a save from a screen that never mentions them.
    /// Sending them as nulls "for completeness" is how an edit screen
    /// quietly deletes what another one wrote.
    func update(_ idea: TripIdea, with edit: TripSpotEdit) async {
        struct Body: Encodable {
            let id: Int
            let ownerId: Int?
            let title: String
            let note: String
            let sourceUrl: String
            let dwellMinutes: Int
        }
        do {
            let response: TripIdeaUpdateResponse = try await APIClient.shared.patch(
                "/trip-planner/ideas/\(idea.id)",
                body: Body(
                    id: idea.id,
                    ownerId: idea.ownerId ?? ownerId,
                    // An empty string clears the field, which is what an
                    // emptied text field means; omitting would leave it.
                    title: edit.title,
                    note: edit.note,
                    sourceUrl: edit.url,
                    dwellMinutes: edit.dwellMinutes,
                ),
            )
            errorMessage = nil
            replace(response.entry)
        } catch {
            errorMessage = "Die \u{00C4}nderung lie\u{00DF} sich nicht speichern."
        }
    }

    /// Put the saved entry back into the list in place of the old one,
    /// rather than reloading: the list is what the reader is looking at.
    private func replace(_ entry: TripIdea) {
        guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return }
        entries[index] = entry
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
                body: Body(id: idea.id, ownerId: idea.ownerId ?? ownerId),
            )
            errorMessage = nil
        } catch {
            entries = before
            errorMessage = "\(idea.displayName) ließ sich nicht entfernen."
        }
    }

    /// Let somebody else write into your own collection (§20.1, §6.2).
    // MARK: - Who writes with me (§20.1)

    /// Who I let into my collection.
    private(set) var members: [TripIdeaMember] = []
    /// The rest of the household, offered to be let in.
    private(set) var household: [TripHouseholdUser] = []
    private(set) var isLoadingMembers = false

    func loadMembers() async {
        isLoadingMembers = true
        defer { isLoadingMembers = false }
        struct MembersResponse: Decodable { let members: [TripIdeaMember] }
        do {
            let mine: MembersResponse = try await APIClient.shared.get("/trip-planner/ideas/members")
            members = mine.members
            let offered: TripHouseholdUsersResponse = try await APIClient.shared.get(
                "/trip-planner/shareable-users", query: ["forIdeas": "true"])
            household = offered.users
            errorMessage = nil
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// Let somebody from the household write into my collection. Picked
    /// from a list, like an album share — nobody types an address for a
    /// person who lives in the same house.
    func share(with user: TripHouseholdUser) async {
        struct Body: Encodable { let userId: Int }
        do {
            let _: [String: [TripIdeaCollection]] = try await APIClient.shared.post(
                "/trip-planner/ideas/share", body: Body(userId: user.id))
            errorMessage = nil
            lastAddition = "\(user.displayName) schreibt jetzt mit."
            await loadMembers()
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    /// Take somebody out again. Their own collection is untouched; they
    /// only stop seeing and writing into mine.
    func unshare(_ member: TripIdeaMember) async {
        struct Body: Encodable { let userId: Int }
        do {
            let _: [String: Bool] = try await APIClient.shared.post(
                "/trip-planner/ideas/unshare", body: Body(userId: member.userId))
            errorMessage = nil
            await loadMembers()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}
