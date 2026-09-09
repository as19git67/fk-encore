import Foundation

/// The planned trip whose dates say it is happening today (§8.1).
///
/// Kept in one place because two screens need the same answer and
/// neither should ask twice: the tab bar wants it before anything is
/// drawn, to open the app where the traveller actually is, and the trip
/// tab wants it for the banner and for opening the plan.
///
/// Answered from the dates rather than from anything anybody pressed. A
/// "start" button would have to be pressed on the one morning nobody
/// has their phone out, and it would be wrong the moment a flight
/// moved.
@Observable @MainActor
final class TripRunningPlan {
    static let shared = TripRunningPlan()

    private(set) var plan: TripPlanSummary?
    /// True once an answer has been fetched, whatever it was. The tab
    /// bar uses it to decide only once, rather than jumping under
    /// somebody's thumb when a slow answer arrives.
    private(set) var didLoad = false

    /// What "today" means. Injectable so a test is not at the mercy of
    /// the date the suite happens to run on.
    var now: () -> Date = { Date() }

    private init() {}

    func refresh() async {
        do {
            let response: ListTripPlansResponse =
                try await APIClient.shared.get("/trip-planner/plans")
            let today = now()
            plan = response.plans.first { $0.schedule(on: today).isRunning }
        } catch {
            // Silent: this is an offer, not a feature. A planner that
            // cannot be reached must not put an error on the tab bar.
            plan = nil
        }
        didLoad = true
    }
}

/// Where the app opens.
///
/// Split out as a plain function because it is a decision, not a view:
/// "a trip is running, so show me the trip" is exactly the kind of rule
/// that is easy to get subtly wrong and impossible to notice — it fires
/// once, at launch, on somebody else's phone.
enum TripLaunchRoute {
    /// Should the app open on the trip tab rather than on the feed?
    ///
    /// Two ways to be travelling, and either counts: trip mode is on
    /// (the photos are going somewhere), or a planned trip's dates say
    /// today is one of its days. Anything else opens where it always
    /// did — the feed is the right answer for the fifty other weeks.
    static func opensOnTrip(tripModeActive: Bool, planRunningToday: Bool) -> Bool {
        tripModeActive || planRunningToday
    }
}
