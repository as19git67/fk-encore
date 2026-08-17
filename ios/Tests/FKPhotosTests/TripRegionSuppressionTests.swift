import CoreLocation
import XCTest
@testable import FKPhotosLib

/// Locks §9.3's "stop nagging" contract: a region can be silenced explicitly,
/// and one the user keeps returning to silences itself. Without both, the daily
/// commute would ask "Trip Mode einschalten?" every single day.
final class TripRegionSuppressionTests: XCTestCase {

    private let start = Date(timeIntervalSince1970: 1_000_000)

    override func setUp() {
        super.setUp()
        TripRegionSuppression.resetAll()
    }

    override func tearDown() {
        TripRegionSuppression.resetAll()
        super.tearDown()
    }

    private func day(_ n: Int) -> Date {
        start.addingTimeInterval(Double(n) * 24 * 60 * 60)
    }

    // MARK: - Grid

    func testNearbyCoordinatesShareACell() {
        // ~1 km apart — well inside one ~5.5 km cell.
        let a = TripRegionGrid.cellKey(latitude: 48.140, longitude: 11.580)
        let b = TripRegionGrid.cellKey(latitude: 48.148, longitude: 11.582)
        XCTAssertEqual(a, b)
    }

    func testDistantCoordinatesGetDifferentCells() {
        let munich = TripRegionGrid.cellKey(latitude: 48.14, longitude: 11.58)
        let hamburg = TripRegionGrid.cellKey(latitude: 53.55, longitude: 9.99)
        XCTAssertNotEqual(munich, hamburg)
    }

    // MARK: - Explicit suppression

    func testSuppressedRegionStaysSuppressed() {
        let cell = TripRegionGrid.cellKey(latitude: 48.14, longitude: 11.58)
        XCTAssertFalse(TripRegionSuppression.isSuppressed(cell: cell))
        TripRegionSuppression.suppress(cell: cell)
        XCTAssertTrue(TripRegionSuppression.isSuppressed(cell: cell))
    }

    func testSuppressingOneRegionLeavesOthersAlone() {
        let commute = TripRegionGrid.cellKey(latitude: 48.14, longitude: 11.58)
        let holiday = TripRegionGrid.cellKey(latitude: 43.77, longitude: 11.25)
        TripRegionSuppression.suppress(cell: commute)
        XCTAssertFalse(
            TripRegionSuppression.isSuppressed(cell: holiday),
            "New destinations must still be suggested"
        )
    }

    // MARK: - Auto-suppression

    func testRegionGoesQuietAfterEnoughDistinctDays() {
        let cell = "commute"
        let threshold = TripRegionSuppression.autoSuppressAfterDistinctDays

        for n in 0..<(threshold - 1) {
            XCTAssertFalse(
                TripRegionSuppression.recordVisit(cell: cell, on: day(n)),
                "Still below the threshold on day \(n)"
            )
        }
        XCTAssertTrue(
            TripRegionSuppression.recordVisit(cell: cell, on: day(threshold - 1)),
            "The threshold visit silences the region"
        )
        XCTAssertTrue(TripRegionSuppression.isSuppressed(cell: cell))
    }

    func testRepeatVisitsOnOneDayCountOnce() {
        let cell = "office"
        // A single day's worth of photos must not push a region over the
        // threshold — the caller runs this on every sync pass.
        for _ in 0..<(TripRegionSuppression.autoSuppressAfterDistinctDays * 3) {
            TripRegionSuppression.recordVisit(cell: cell, on: day(0))
        }
        XCTAssertEqual(TripRegionSuppression.distinctVisitDays(cell: cell), 1)
        XCTAssertFalse(TripRegionSuppression.isSuppressed(cell: cell))
    }

    func testAHolidayLengthStayDoesNotSilenceTheRegion() {
        // A week away is a trip: it is asked about on day one, and must not
        // teach the app to stop asking about that region in future years.
        let cell = "holiday"
        let visits = TripRegionSuppression.autoSuppressAfterDistinctDays - 1
        for n in 0..<visits {
            TripRegionSuppression.recordVisit(cell: cell, on: day(n))
        }
        XCTAssertFalse(TripRegionSuppression.isSuppressed(cell: cell))
    }

    func testVisitHistoryIsDroppedOnceSuppressed() {
        let cell = "commute"
        TripRegionSuppression.recordVisit(cell: cell, on: day(0))
        TripRegionSuppression.suppress(cell: cell)
        XCTAssertEqual(
            TripRegionSuppression.distinctVisitDays(cell: cell), 0,
            "A silenced region needs no further bookkeeping"
        )
    }

    func testRecordingAVisitToASuppressedRegionIsANoOp() {
        let cell = "commute"
        TripRegionSuppression.suppress(cell: cell)
        XCTAssertTrue(TripRegionSuppression.recordVisit(cell: cell, on: day(0)))
        XCTAssertEqual(TripRegionSuppression.distinctVisitDays(cell: cell), 0)
    }

    // MARK: - Day keys

    func testDayKeyIsStableWithinADayAndChangesAcrossDays() {
        // Anchored on the local start of day, so the assertion holds in every
        // CI timezone — a fixed epoch offset plus eight hours lands on the next
        // local day east of UTC.
        let midnight = Calendar.current.startOfDay(for: start)
        let morning = midnight.addingTimeInterval(1 * 60 * 60)
        let evening = midnight.addingTimeInterval(10 * 60 * 60)
        XCTAssertEqual(
            TripRegionSuppression.dayKey(for: morning),
            TripRegionSuppression.dayKey(for: evening),
            "Both fall on the same local day"
        )
        XCTAssertNotEqual(
            TripRegionSuppression.dayKey(for: morning),
            TripRegionSuppression.dayKey(for: morning.addingTimeInterval(24 * 60 * 60))
        )
    }
}
