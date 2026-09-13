import XCTest
@testable import F4milShareWire

/// The share extension's half of the wire contract (§9.2).
///
/// These types are hand-written mirrors of what the trip-planner
/// service returns, and until now nothing checked the mirroring. CI
/// compiles the extension, but a `Decodable` that asks for a field the
/// server never sends compiles perfectly well and fails inside a
/// `JSONDecoder` on somebody's phone — where, behind a `try?`, it looks
/// like an empty list rather than a bug. `ShareIdeaCollection` asked
/// for a `label` that never existed, and the share sheet demanded a
/// trip for months because of it.
///
/// So each fixture below is the shape the endpoint really returns,
/// transcribed from its TypeScript interface, and the tests decode
/// through the real types. The other half of the contract lives in
/// `trip-planner/share-wire-contract.test.ts`, which asserts the server
/// still sends these keys: a fixture alone would happily agree with a
/// mirror and a server that had drifted apart.
final class ShareWireTypesTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: - Idea collections (GET /trip-planner/ideas)

    /// The exact bug: the server sends no `label`, and never did.
    func testACollectionDecodesWithoutALabel() throws {
        let json = """
        {"collections":[
          {"ownerId":7,"ownerName":null,"own":true},
          {"ownerId":9,"ownerName":"Anna","own":false}
        ]}
        """
        struct Response: Decodable { let collections: [ShareIdeaCollection] }
        let response = try decode(Response.self, json)

        XCTAssertEqual(response.collections.count, 2)
        XCTAssertEqual(response.collections[0].ownerId, 7)
        XCTAssertTrue(response.collections[0].own)
    }

    func testTheLabelIsComputedTheWayTheAppComputesIt() throws {
        let json = """
        {"collections":[
          {"ownerId":7,"ownerName":null,"own":true},
          {"ownerId":9,"ownerName":"Anna","own":false},
          {"ownerId":11,"ownerName":null,"own":false}
        ]}
        """
        struct Response: Decodable { let collections: [ShareIdeaCollection] }
        let labels = try decode(Response.self, json).collections.map(\.label)

        XCTAssertEqual(labels, ["Mein Vorrat", "Vorrat von Anna", "Geteilter Vorrat"])
    }

    // MARK: - Trips (GET /trip-planner/plans)

    func testAPlanSummaryIgnoresTheFieldsThePickerDoesNotNeed() throws {
        // The server sends dayCount, startDate and updatedAt too. An
        // extra key must never be a decoding failure — only a missing
        // one is.
        let json = """
        {"plans":[{"id":3,"title":"Toskana","legTitles":["Florenz",null],
                   "dayCount":9,"startDate":"2026-05-02","updatedAt":"2026-04-01T10:00:00Z"}]}
        """
        struct Response: Decodable { let plans: [SharePlanSummary] }
        let plan = try XCTUnwrap(try decode(Response.self, json).plans.first)

        XCTAssertEqual(plan.id, 3)
        XCTAssertEqual(plan.displayTitle, "Toskana")
    }

    func testAnUntitledTripIsNamedAfterItsLegs() throws {
        let json = """
        {"plans":[{"id":4,"title":null,"legTitles":["Pisa",null,"Siena"],
                   "dayCount":4,"startDate":null,"updatedAt":"2026-04-01T10:00:00Z"}]}
        """
        struct Response: Decodable { let plans: [SharePlanSummary] }
        let plan = try XCTUnwrap(try decode(Response.self, json).plans.first)

        XCTAssertEqual(plan.displayTitle, "Pisa \u{2192} Siena")
    }

    func testATripWithNothingToCallItStillHasAName() throws {
        let json = """
        {"plans":[{"id":5,"title":null,"legTitles":[null],
                   "dayCount":1,"startDate":null,"updatedAt":"2026-04-01T10:00:00Z"}]}
        """
        struct Response: Decodable { let plans: [SharePlanSummary] }
        let plan = try XCTUnwrap(try decode(Response.self, json).plans.first)

        XCTAssertEqual(plan.displayTitle, "Reise")
    }

    // MARK: - Reading a link (POST /trip-planner/map-link)

    func testAMapLinkWithAPlace() throws {
        let json = """
        {"isMapLink":true,"lat":43.4674,"lon":11.0431,"name":"Torre Grossa",
         "source":"apple","unresolved":false}
        """
        let read = try decode(ShareMapLinkRead.self, json)

        XCTAssertTrue(read.isMapLink)
        XCTAssertEqual(read.lat ?? 0, 43.4674, accuracy: 0.0001)
        XCTAssertEqual(read.name, "Torre Grossa")
        XCTAssertFalse(read.unresolved)
    }

    func testAPageThatIsNoMapLinkAtAll() throws {
        let json = """
        {"isMapLink":false,"lat":null,"lon":null,"name":null,
         "source":null,"unresolved":false}
        """
        let read = try decode(ShareMapLinkRead.self, json)

        XCTAssertFalse(read.isMapLink)
        XCTAssertNil(read.lat)
        XCTAssertNil(read.name)
    }

    func testAShortLinkNobodyCouldFollow() throws {
        // The third answer, and the only one worth retrying: a map link
        // whose place is not known *yet*.
        let json = """
        {"isMapLink":true,"lat":null,"lon":null,"name":null,
         "source":"google","unresolved":true}
        """
        let read = try decode(ShareMapLinkRead.self, json)

        XCTAssertTrue(read.isMapLink)
        XCTAssertTrue(read.unresolved)
        XCTAssertNil(read.lat)
    }

    // MARK: - Analysis (POST /trip-planner/plans/:planId/shares)

    func testACoordinateProposalCanBeAddedAndNeedsADuration() throws {
        let json = """
        {"kind":"map-link","sourceUrl":"https://example.invalid/x","rejected":[],
         "proposals":[{"name":"Ein Ort","verdict":"coordinate",
                       "position":{"lat":43.4,"lon":11.0},"osmRef":null,
                       "categories":[],"legIndex":null,"options":[],
                       "quote":null,"placeHint":null,"kindHint":null}]}
        """
        let response = try decode(ShareAnalyzeResponse.self, json)
        let proposal = try XCTUnwrap(response.proposals.first)

        XCTAssertEqual(response.kind, "map-link")
        XCTAssertTrue(proposal.canAdd)
        XCTAssertTrue(proposal.needsDuration)
        XCTAssertFalse(proposal.needsChoice)
    }

    func testAnAmbiguousProposalCarriesItsOptions() throws {
        let json = """
        {"kind":"article","sourceUrl":null,"rejected":["die Seite war zu lang"],
         "proposals":[{"name":"Santa Maria","verdict":"ambiguous","position":null,
                       "osmRef":null,"categories":["worship"],"legIndex":null,
                       "options":[{"osmRef":"way:1","name":"Santa Maria Novella",
                                   "lat":43.77,"lon":11.24,"categories":["worship"],
                                   "legIndex":0,"distanceM":420.0}],
                       "quote":"die Kirche am Bahnhof","placeHint":null,"kindHint":"Kirche"}]}
        """
        let response = try decode(ShareAnalyzeResponse.self, json)
        let proposal = try XCTUnwrap(response.proposals.first)

        XCTAssertEqual(response.rejected, ["die Seite war zu lang"])
        XCTAssertTrue(proposal.needsChoice)
        XCTAssertFalse(proposal.canAdd)
        XCTAssertEqual(proposal.options.first?.osmRef, "way:1")
        XCTAssertEqual(proposal.quote, "die Kirche am Bahnhof")
    }

    func testAProposalTheRegionCouldNotPlaceAddsNothing() throws {
        let json = """
        {"kind":"article","sourceUrl":null,"rejected":[],
         "proposals":[{"name":"Irgendwo","verdict":"none","position":null,
                       "osmRef":null,"categories":[],"legIndex":null,"options":[],
                       "quote":null,"placeHint":null,"kindHint":null}]}
        """
        let proposal = try XCTUnwrap(try decode(ShareAnalyzeResponse.self, json).proposals.first)

        XCTAssertFalse(proposal.canAdd)
        XCTAssertFalse(proposal.needsDuration)
        XCTAssertFalse(proposal.needsChoice)
    }
}
