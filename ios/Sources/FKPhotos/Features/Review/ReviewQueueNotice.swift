import Foundation

/// How the number of unreviewed groups is presented, and when it is worth
/// interrupting someone about.
///
/// The group review had exactly one way in — a silent checklist icon in the
/// feed toolbar — with nothing saying whether there was anything to review
/// (#968). Everything that says „there are N groups waiting" now goes through
/// here: the badge, the hub row, the feed banner and the notification. Pure,
/// so the plural forms and the „is this news?" rule are testable without a
/// server or a screen.
enum ReviewQueueNotice {

    /// Above this, the exact number stops being useful and starts being wide.
    static let badgeCap = 99

    /// The badge over the toolbar icon. Nil when there is nothing to show —
    /// „0" is not a badge, and neither is „not loaded yet".
    static func badgeText(_ count: Int?) -> String? {
        guard let count, count > 0 else { return nil }
        return count > badgeCap ? "\(badgeCap)+" : "\(count)"
    }

    /// Subtitle for the hub row: what is waiting, in words.
    static func subtitle(_ count: Int?) -> String {
        guard let count else { return "Ähnliche Fotos aussortieren" }
        switch count {
        case 0: return "Nichts offen — alles durchgesehen"
        case 1: return "1 Gruppe wartet"
        default: return "\(count) Gruppen warten"
        }
    }

    /// Headline for the feed banner.
    static func bannerTitle(_ count: Int) -> String {
        count == 1 ? "1 Gruppe wartet auf Review" : "\(count) Gruppen warten auf Review"
    }

    // MARK: - Notification

    static let notificationCategoryId = "review-queue-pending"
    static let notificationRequestId = "review-queue-pending"

    /// Whether a freshly read count is worth a notification.
    ///
    /// Three rules, all of them about not being a nuisance:
    ///
    /// - The count has to have **grown**. A queue that shrank is the user
    ///   working through it; telling them about their own progress is noise.
    /// - There has to be a **previous** count. The first read after an install
    ///   is a measurement, not news — a pile that was always there is not an
    ///   event, and announcing it would greet a new user with a chore.
    /// - The count has to be above zero, which follows from the first rule but
    ///   is cheap to state.
    static func shouldNotify(previous: Int?, current: Int) -> Bool {
        guard let previous else { return false }
        return current > previous && current > 0
    }

    /// What the notification says. It names the new arrivals rather than the
    /// total: „3 neue Gruppen" is the news, „47 Gruppen" is a backlog.
    static func notificationBody(previous: Int, current: Int) -> String {
        let added = max(0, current - previous)
        let head = added == 1
            ? "1 neue Gruppe ähnlicher Fotos"
            : "\(added) neue Gruppen ähnlicher Fotos"
        return "\(head) — insgesamt \(current) offen."
    }
}
