import UserNotifications

/// Registers every notification category the app has, in one call.
///
/// `setNotificationCategories` *replaces* the whole set rather than adding to
/// it, so each category cannot register itself — whichever ran last would be
/// the only one left, and the others' notifications would arrive with no
/// action buttons at all. Collecting them here makes that impossible to get
/// wrong, which is also why the review-queue category (#968) belongs in this
/// list rather than registering itself next to where it is posted.
///
/// The name still says Trip because that is where the pattern started; the set
/// is the whole app's.
enum TripNotificationCategories {
    /// `@MainActor` because the monitors are — their static members are
    /// isolated along with the type.
    @MainActor
    static func registerAll() {
        UNUserNotificationCenter.current().setNotificationCategories([
            TripAutoEndMonitor.notificationCategory(),
            TripAutoStartMonitor.notificationCategory(),
            ReviewQueueNotifier.notificationCategory(),
        ])
    }
}
