import Foundation

/// Album names are the only thing that links an iOS album to its server album,
/// and the two sides normalise differently: the iOS photo library keeps a title
/// exactly as typed (trailing spaces included), while the web app trims before
/// creating an album. An iOS album named `"Urlaub "` therefore never matched the
/// server's `"Urlaub"`, and the sync created a second, space-suffixed album
/// (issue #849).
///
/// Every name comparison — and every name sent to the server — goes through
/// here, so both sides agree on what "same album" means.
enum AlbumName {
    /// Canonical form used for matching and for names sent to the server.
    static func normalized(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// True when both names denote the same album. Deliberately case-sensitive:
    /// only surrounding whitespace is noise, differing capitalisation is not.
    static func matches(_ lhs: String, _ rhs: String) -> Bool {
        normalized(lhs) == normalized(rhs)
    }
}
