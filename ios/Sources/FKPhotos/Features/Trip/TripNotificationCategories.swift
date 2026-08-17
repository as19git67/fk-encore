import UserNotifications

/// Registers every Trip Mode notification category in one call.
///
/// `setNotificationCategories` *replaces* the whole set rather than adding to
/// it, so each category cannot register itself — whichever ran last would be
/// the only one left, and the other's notification would arrive with no action
/// buttons at all. Collecting them here makes that impossible to get wrong.
enum TripNotificationCategories {
    /// `@MainActor` because both monitors are — their static members are
    /// isolated along with the type.
    @MainActor
    static func registerAll() {
        UNUserNotificationCenter.current().setNotificationCategories([
            TripAutoEndMonitor.notificationCategory(),
            TripAutoStartMonitor.notificationCategory(),
        ])
    }
}
