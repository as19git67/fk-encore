// `F4milCore` holds what every app built on this package shares: the API
// client, the session, the keychain, the App Group storage and the deep-link
// catalog (documentation/plans/assistent-ios.md, stage 2). Those types used to
// be this module's own, and some three hundred files use them without an
// import line. Re-exporting the module keeps it that way: whoever imports
// `FKPhotosLib` — the app target, the widgets, the tests — sees `APIClient`
// and `AuthManager` as before.
@_exported import F4milCore
