import XCTest
@testable import FKPhotosLib

/// The share handover, and what the review screen does with it (§9.2).
///
/// Three things are worth holding down here, and all three fail
/// quietly. The payload format crosses a process boundary between two
/// separately built targets. The inbox decides what counts as still
/// interesting. And the review screen decides what actually reaches the
/// pool — which coordinate, which leg, and whether a duration is sent
/// at all, which is the difference between using OpenStreetMap's data
/// and overwriting it with a default.
final class TripSharePayloadCopyTests: XCTestCase {
    /// The two copies must not drift.
    ///
    /// The share extension links no library — it has its own minimal
    /// API client for exactly that reason — so the payload type exists
    /// once on each side. A field renamed on one side only would make
    /// every share arrive empty, and nothing would say so.
    func testTheExtensionAndTheAppShareOneDefinition() throws {
        let here = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // → ios/Tests/FKPhotosTests
            .deletingLastPathComponent()   // → ios/Tests
            .deletingLastPathComponent()   // → ios
        let appCopy = here.appending(path: "Sources/FKPhotos/Features/TripPlanner/TripSharePayload.swift")
        let extensionCopy = here.appending(path: "F4milShare/TripSharePayload.swift")

        let app = try String(contentsOf: appCopy, encoding: .utf8)
        let ext = try String(contentsOf: extensionCopy, encoding: .utf8)
        XCTAssertEqual(app, ext,
                       "TripSharePayload.swift has drifted apart between the app and the "
                       + "share extension — copy whichever one you changed over the other")
    }
}

final class TripShareInboxTests: XCTestCase {
    private var store: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "trip-share-tests-\(UUID().uuidString)"
        store = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        store.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func payload(age: TimeInterval = 0) -> TripSharePayload {
        TripSharePayload(
            url: "https://beispiel.test/zehn-cafes",
            text: nil,
            title: nil,
            capturedAt: Date().addingTimeInterval(-age),
        )
    }

    func testAnEmptyInboxHasNothingWaiting() {
        XCTAssertNil(TripShareInbox.peek(store))
    }

    func testWhatWasSharedComesBack() {
        TripShareInbox.put(payload(), into: store)
        XCTAssertEqual(TripShareInbox.peek(store)?.url, "https://beispiel.test/zehn-cafes")
    }

    func testPeekingLeavesItThereAndTakingDoesNot() {
        // Leaving the screen without confirming must not lose the find;
        // being offered it must not offer it forever.
        TripShareInbox.put(payload(), into: store)
        XCTAssertNotNil(TripShareInbox.peek(store))
        XCTAssertNotNil(TripShareInbox.peek(store))
        XCTAssertNotNil(TripShareInbox.take(store))
        XCTAssertNil(TripShareInbox.peek(store))
    }

    func testAForgottenLinkStopsBeingPending() {
        // A link shared three weeks ago is not a pending task, and
        // turning up with it at the start of the next trip would be an
        // ambush.
        TripShareInbox.put(payload(age: TripSharePayload.maximumAge + 60), into: store)
        XCTAssertNil(TripShareInbox.peek(store))
    }

    func testAPayloadWithNothingInItIsNotOffered() {
        TripShareInbox.put(
            TripSharePayload(url: nil, text: "   ", title: nil, capturedAt: Date()),
            into: store,
        )
        XCTAssertNil(TripShareInbox.peek(store))
    }

    func testUnreadablePayloadsAreClearedRatherThanRetried() {
        // A payload from another version of the format would otherwise
        // show a banner that opens nothing, every single time.
        store.set(Data("nicht mal JSON".utf8), forKey: TripSharePayload.defaultsKey)
        XCTAssertNil(TripShareInbox.peek(store))
        XCTAssertNil(store.data(forKey: TripSharePayload.defaultsKey))
    }
}

@MainActor
final class TripShareReviewViewModelTests: XCTestCase {
    private func model() -> TripShareReviewViewModel {
        TripShareReviewViewModel(
            planId: 7,
            payload: TripSharePayload(url: "https://beispiel.test/artikel", text: nil,
                                      title: nil, capturedAt: Date()),
        )
    }

    private func proposal(
        verdict: String,
        osmRef: String? = nil,
        position: TripShareProposal.Coordinate? = nil,
        legIndex: Int? = nil,
        options: [TripShareProposal.Option] = [],
        quote: String? = nil,
        placeHint: String? = nil,
    ) -> TripShareProposal {
        TripShareProposal(
            name: "Café Beispielhof",
            verdict: verdict,
            position: position,
            osmRef: osmRef,
            categories: [],
            legIndex: legIndex,
            options: options,
            quote: quote,
            placeHint: placeHint,
            kindHint: nil,
        )
    }

    private func option(_ ref: String, lat: Double, leg: Int, distanceM: Double?) -> TripShareProposal.Option {
        .init(osmRef: ref, name: "Café Beispielhof", lat: lat, lon: 11.5,
              categories: [], legIndex: leg, distanceM: distanceM)
    }

    func testAResolvedPlaceNeedsNothingButAYes() {
        let vm = model()
        let resolved = proposal(verdict: "unique", osmRef: "node:1",
                                position: .init(lat: 48.1, lon: 11.5), legIndex: 1)
        XCTAssertEqual(resolved.missing, .nothing)
        XCTAssertTrue(vm.isReady(resolved))

        let request = vm.requestFor(resolved)
        XCTAssertEqual(request?.legIndex, 1)
        // Its duration comes from OpenStreetMap. Sending a default
        // would overwrite real data with a guess.
        XCTAssertNil(request?.dwellMinutes)
    }

    func testAnAmbiguousNameWaitsForTheChoice() {
        let vm = model()
        let ambiguous = proposal(verdict: "ambiguous", options: [
            option("node:2", lat: 48.2, leg: 0, distanceM: 200),
            option("node:3", lat: 48.3, leg: 1, distanceM: 900),
        ])
        XCTAssertEqual(ambiguous.missing, .whichPlace)
        XCTAssertFalse(vm.isReady(ambiguous))
        XCTAssertNil(vm.requestFor(ambiguous))

        vm.chosenOption[ambiguous.id] = ambiguous.options[1]
        XCTAssertTrue(vm.isReady(ambiguous))
        let request = vm.requestFor(ambiguous)
        // The chosen place brings its own coordinate *and* its own leg,
        // which need not be the leg the article was read in.
        XCTAssertEqual(request?.lat, 48.3)
        XCTAssertEqual(request?.legIndex, 1)
        XCTAssertNil(request?.dwellMinutes)
    }

    func testAPlaceNobodyHasDataForMustBeGivenADuration() {
        // The one question §9.2 allows the planner to ask. Without an
        // answer the request is not sent at all, rather than sent with
        // an invented number.
        let vm = model()
        let pin = proposal(verdict: "coordinate", position: .init(lat: 48.1, lon: 11.5), legIndex: 0)
        XCTAssertEqual(pin.missing, .howLong)
        XCTAssertFalse(vm.isReady(pin))
        XCTAssertNil(vm.requestFor(pin))

        vm.dwellMinutes[pin.id] = 30
        XCTAssertTrue(vm.isReady(pin))
        XCTAssertEqual(vm.requestFor(pin)?.dwellMinutes, 30)
    }

    func testANameThatResolvedToNothingIsANoteRatherThanACandidate() {
        // Nothing to add: there is no coordinate to put on a map. It
        // stays visible with its quote until somebody resolves it.
        let vm = model()
        let unresolved = proposal(verdict: "none", quote: "die besten Pastéis der Stadt")
        XCTAssertFalse(unresolved.isAddable)
        XCTAssertFalse(vm.isReady(unresolved))
        XCTAssertNil(vm.requestFor(unresolved))
    }

    func testTheReasonItWasSavedTravelsWithIt() {
        // Why a spot was saved matters more when planning than its
        // name, and the article's own words are the best version of it.
        let vm = model()
        let withQuote = proposal(verdict: "unique", osmRef: "node:1",
                                 position: .init(lat: 48.1, lon: 11.5),
                                 quote: "die besten Pastéis der Stadt",
                                 placeHint: "in der Altstadt")
        let request = vm.requestFor(withQuote)
        XCTAssertEqual(request?.note, "„die besten Pastéis der Stadt“ · in der Altstadt")
        XCTAssertEqual(request?.sourceUrl, "https://beispiel.test/artikel")
    }

    func testNoNoteRatherThanAnEmptyOne() {
        let vm = model()
        let bare = proposal(verdict: "unique", osmRef: "node:1",
                            position: .init(lat: 48.1, lon: 11.5))
        XCTAssertNil(vm.requestFor(bare)?.note)
    }

    func testSomethingAlreadyAddedIsNotOfferedAgain() {
        let vm = model()
        let resolved = proposal(verdict: "unique", osmRef: "node:1",
                                position: .init(lat: 48.1, lon: 11.5))
        XCTAssertTrue(vm.isReady(resolved))
        // The same transition `add(_:)` makes on success.
        vm.markAdded(resolved.id, outcome: "im Vorrat")
        XCTAssertFalse(vm.isReady(resolved))
    }
}

/// Reading the open page, on the device (§9.3 stage 1).
///
/// The script itself runs inside Safari and cannot be reached from a
/// test; what *can* be pinned down is the boundary it hands across —
/// which is exactly where a mistake is invisible. A renamed key, a page
/// that yields nothing, a selection preferred over the article: each
/// produces a share that looks like it worked and carries less than it
/// should.
final class TripSharePageReadingTests: XCTestCase {
    private func results(
        url: String? = "https://beispiel.test/zehn-cafes",
        title: String? = "Zehn Cafés in Musterstadt",
        text: String? = "Das Café am Beispielplatz röstet selbst.",
        selection: String? = nil,
    ) -> [String: Any] {
        var dictionary: [String: Any] = [:]
        if let url { dictionary["url"] = url }
        if let title { dictionary["title"] = title }
        if let text { dictionary["text"] = text }
        if let selection { dictionary["selection"] = selection }
        return dictionary
    }

    func testThePageTextComesAcrossWithItsLinkAndTitle() throws {
        let payload = try XCTUnwrap(TripSharePayload(javaScriptResults: results()))

        XCTAssertEqual(payload.url, "https://beispiel.test/zehn-cafes")
        XCTAssertEqual(payload.title, "Zehn Cafés in Musterstadt")
        XCTAssertEqual(payload.text, "Das Café am Beispielplatz röstet selbst.")
    }

    func testASelectionWinsOverTheWholePage() throws {
        // Selecting a paragraph before sharing says something the page
        // cannot: "this one", not "the eleven in this list".
        let payload = try XCTUnwrap(TripSharePayload(javaScriptResults: results(
            selection: "Das Café am Beispielplatz röstet selbst.",
        )))

        XCTAssertEqual(payload.text, "Das Café am Beispielplatz röstet selbst.")
    }

    func testAStrayTapIsNotASelection() throws {
        // A couple of characters caught by a finger must not throw away
        // the article they were sitting in.
        let payload = try XCTUnwrap(TripSharePayload(javaScriptResults: results(
            text: "Das Café am Beispielplatz röstet selbst.",
            selection: "Das",
        )))

        XCTAssertEqual(payload.text, "Das Café am Beispielplatz röstet selbst.")
    }

    func testAPageWithNoReadableTextStillArrivesAsItsLink() throws {
        // A photo gallery has nothing to extract from. The link alone is
        // still a find — the server fetch is the fallback for exactly
        // this — so it must not be dropped.
        let payload = try XCTUnwrap(TripSharePayload(javaScriptResults: results(
            text: "   ", selection: "",
        )))

        XCTAssertEqual(payload.url, "https://beispiel.test/zehn-cafes")
        XCTAssertNil(payload.text)
    }

    func testNothingUsableIsRefusedRatherThanStoredEmpty() {
        // An empty payload in the App Group would show up in the app as
        // a find with nothing in it.
        XCTAssertNil(TripSharePayload(javaScriptResults: results(url: nil, title: nil, text: nil)))
        XCTAssertNil(TripSharePayload(javaScriptResults: [:]))
    }

    func testAKeyOfTheWrongTypeIsIgnoredRatherThanCrashing() throws {
        // The script runs in somebody else's page; a value of an
        // unexpected shape is not a reason to lose the rest.
        var raw = results()
        raw["title"] = 42
        let payload = try XCTUnwrap(TripSharePayload(javaScriptResults: raw))

        XCTAssertNil(payload.title)
        XCTAssertEqual(payload.text, "Das Café am Beispielplatz röstet selbst.")
    }

    /// The script has to exist under the name the Info.plist registers,
    /// or Safari silently activates the extension without ever running
    /// it — and every share arrives as a bare link.
    func testTheScriptIsCalledWhatTheInfoPlistSaysItIs() throws {
        let ios = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // → ios/Tests/FKPhotosTests
            .deletingLastPathComponent()   // → ios/Tests
            .deletingLastPathComponent()   // → ios
        let plist = try Data(contentsOf: ios.appending(path: "App/ShareExtension/Info.plist"))
        let parsed = try XCTUnwrap(
            try PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any])
        let attributes = try XCTUnwrap(
            (parsed["NSExtension"] as? [String: Any])?["NSExtensionAttributes"] as? [String: Any])

        let name = try XCTUnwrap(attributes["NSExtensionJavaScriptPreprocessingFile"] as? String)
        XCTAssertFalse(name.hasSuffix(".js"), "the value is the base name, without the extension")

        let script = ios.appending(path: "F4milShare/\(name).js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: script.path),
                      "Info.plist registers \(name).js, which is not in the extension's folder")

        // Registering the script without asking for web pages means it
        // never runs.
        let rule = try XCTUnwrap(attributes["NSExtensionActivationRule"] as? [String: Any])
        XCTAssertNotNil(rule["NSExtensionActivationSupportsWebPageWithMaxCount"])

        // The keys the script writes and the ones the payload reads are
        // one contract across two languages, so hold the script to it.
        let source = try String(contentsOf: script, encoding: .utf8)
        for key in ["url:", "title:", "text:", "selection:"] {
            XCTAssertTrue(source.contains(key), "the script no longer hands over \(key)")
        }
    }
}
