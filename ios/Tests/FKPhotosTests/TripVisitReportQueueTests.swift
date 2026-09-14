import XCTest
@testable import FKPhotosLib

/// Visits that could not be reported, kept for later (§3.9, §7.1).
///
/// The monitor itself is CoreLocation plumbing and untestable in CI;
/// what can be pinned down is the queue under it — that a report that
/// failed is still there afterwards, that it leaves once sent, and that
/// the oldest go first when the queue is asked to forget.
final class TripVisitReportQueueTests: XCTestCase {

    private var store: UserDefaults!

    override func setUp() {
        super.setUp()
        let suite = "TripVisitReportQueueTests.\(UUID().uuidString)"
        store = UserDefaults(suiteName: suite)
        store.removePersistentDomain(forName: suite)
    }

    private func report(_ n: Int, planId: Int = 1) -> TripVisitReport {
        TripVisitReport(
            planId: planId, stopId: n, osmRef: "node:\(n)", name: "Ort \(n)",
            arrivedAt: "2026-09-01T10:00:00Z", leftAt: "2026-09-01T10:40:00Z",
            dwellMinutes: 40, hasMatchingPhoto: false,
        )
    }

    func testAnEmptyStoreIsAnEmptyQueue() {
        XCTAssertEqual(TripVisitReportQueue.load(from: store), [])
    }

    func testAFailedReportIsKeptInOrder() {
        TripVisitReportQueue.append(report(1), to: store)
        TripVisitReportQueue.append(report(2), to: store)
        XCTAssertEqual(TripVisitReportQueue.load(from: store), [report(1), report(2)])
    }

    func testASentReportLeavesTheQueue() {
        TripVisitReportQueue.append(report(1), to: store)
        TripVisitReportQueue.append(report(2), to: store)
        TripVisitReportQueue.remove(report(1), from: store)
        XCTAssertEqual(TripVisitReportQueue.load(from: store), [report(2)])
        // The last one out takes the key with it — nothing lingers in
        // the defaults for a queue with nothing in it.
        TripVisitReportQueue.remove(report(2), from: store)
        XCTAssertNil(store.data(forKey: TripVisitReportQueue.key))
    }

    func testTheOldestAreDroppedWhenTheQueueOverflows() {
        for n in 0..<(TripVisitReportQueue.capacity + 3) {
            TripVisitReportQueue.append(report(n), to: store)
        }
        let queue = TripVisitReportQueue.load(from: store)
        XCTAssertEqual(queue.count, TripVisitReportQueue.capacity)
        XCTAssertEqual(queue.first?.stopId, 3)
    }

    func testTheWireBodyCarriesEverythingButThePlan() throws {
        // The plan id is in the URL; sending it in the body too would be
        // a field `visits.ts` never asked for.
        let data = try JSONEncoder().encode(report(5, planId: 9).body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(json["planId"])
        XCTAssertEqual(json["osmRef"] as? String, "node:5")
        XCTAssertEqual(json["dwellMinutes"] as? Int, 40)
    }
}
