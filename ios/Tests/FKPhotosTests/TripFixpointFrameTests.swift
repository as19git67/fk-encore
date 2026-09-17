import XCTest
@testable import FKPhotosLib

/// A fixpoint that is the frame of a block (§7.3).
///
/// The band of fixed times must not list it — the block shows it as
/// its hours — and a plan from an older server, which knows no frames,
/// must still decode.
final class TripFixpointFrameTests: XCTestCase {

    private func fixpoint(_ extra: String) throws -> TripFixpoint {
        try JSONDecoder().decode(TripFixpoint.self, from: Data("""
        { "rowId": 5, "kind": "appointment", "label": "Aussichtsterrasse",
          "startMinutes": 1210, "durationMinutes": 50, "travelMinutes": 12,
          "bufferMinutes": 20, "lat": 48.14, "lon": 11.58\(extra) }
        """.utf8))
    }

    func testAnOrdinaryAppointmentFramesNothing() throws {
        XCTAssertFalse(try fixpoint("").framesBlock)
    }

    func testABoundFixpointFramesItsBlock() throws {
        let frame = try fixpoint(", \"blockId\": \"evening\", \"spotRef\": \"way:7\"")
        XCTAssertTrue(frame.framesBlock)
        XCTAssertEqual(frame.blockId, "evening")
        XCTAssertEqual(frame.windowText, "20:10–21:00")
    }

    func testHalfABindingIsNoBinding() throws {
        // A block without a spot would be an evening framed for nothing.
        XCTAssertFalse(try fixpoint(", \"blockId\": \"evening\"").framesBlock)
    }
}
