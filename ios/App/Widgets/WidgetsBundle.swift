import SwiftUI
import WidgetKit

/// The extension's entry point (#764, #768 §1). Everything it renders
/// reads data the app already wrote — see `WidgetSnapshots.swift` and
/// `TripDayActivityManager` in the package; nothing here talks to the
/// server.
@main
struct FKPhotosWidgetsBundle: WidgetBundle {
    var body: some Widget {
        OnThisDayWidget()
        LatestRecapWidget()
        RecentFeedWidget()
        TripDayLiveActivity()
    }
}
