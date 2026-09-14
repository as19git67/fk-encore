import Foundation

/// The two halves of the Trip tab (§8.1): the trip you are on, and the
/// trip you are planning.
///
/// For a long time the planner hung on one toolbar icon inside a tab
/// about photo sync — four levels from the tab to a day. The concept
/// describes two peer areas, and this is the switch between them. The
/// raw values are stored, so the traveller comes back to the half they
/// left.
enum TripTabMode: String, CaseIterable, Sendable {
    /// Trip mode: photos going into a shared album.
    case capture
    /// The vacation planner: plans, days, ideas.
    case plan

    var title: String {
        switch self {
        case .capture: return "Aufnehmen"
        case .plan: return "Planen"
        }
    }

    /// Which half to show when the tab first appears.
    ///
    /// Decided once, like the tab itself (`TripLaunchRoute`): a screen
    /// that changes under the thumb is worse than one more tap. Trip
    /// mode wins because its screen carries the running plan as a
    /// banner anyway, so nothing is hidden; a planned trip running
    /// today with no photos going anywhere wants its day, not an empty
    /// grid. Otherwise the half the traveller left is the half they
    /// come back to.
    static func initial(
        tripModeActive: Bool,
        planRunningToday: Bool,
        remembered: TripTabMode,
    ) -> TripTabMode {
        if tripModeActive { return .capture }
        if planRunningToday { return .plan }
        return remembered
    }
}
