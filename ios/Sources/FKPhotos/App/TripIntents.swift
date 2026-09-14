import AppIntents
import Foundation

/// "Das hier merken" as an App Shortcut (§20, plan item E3).
///
/// Remembering the place you are standing on took five taps and two
/// screen changes, for an action that needs nothing but the location.
/// This is the one-tap version: from the Shortcuts app, from Siri, from
/// the Action button. The intent itself does not talk to the server —
/// the sheet does, so the note and the dwell time are asked for as they
/// always were, and a failure is read where the tap happened.
///
/// Public because App Shortcuts have to be declared in the app target
/// (`Main.swift`), which lives in another module.
public struct RememberHereIntent: AppIntent {
    public static let title: LocalizedStringResource = "Das hier merken"
    public static let description = IntentDescription(
        "Merkt den Ort, an dem du gerade stehst, in den Ideen der Urlaubsplanung.",
    )
    /// The sheet needs the app: the coordinate is asked for with the
    /// app's own location permission, and the note is typed.
    public static let openAppWhenRun = true

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        TripIdeaCaptureRequest.shared.request()
        return .result()
    }
}

/// Lets the app target's `AppIntentsPackage` include the intents that
/// live in this package.
public struct FKPhotosIntents: AppIntentsPackage {
    public init() {}
}
