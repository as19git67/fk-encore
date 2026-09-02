import Foundation

/// Non-destructive photo edits: a crop, a rotation and a few tone values,
/// stored per user and applied when the photo is rendered. The original file
/// is never touched.
///
/// The whole stack is server-side (`photo/photo-transforms-crud.service.ts`,
/// documented in `docs/photos-ai-transforms.md`); this is the client's half.
/// Three things can hold a recipe for one photo:
///
/// - **mine** — what this user saved, if anything
/// - **others** — what other people in the household saved, which can be
///   adopted wholesale
/// - **the suggestion** — what the AI proposed, one crop per aspect ratio,
///   plus tone values. Never applied on its own: the user confirms it.
///
/// This file is the wire format and the rules around it. Everything here is
/// pure, so what the UI offers for a given bundle is testable without a
/// server.
enum PhotoTransforms {

    // MARK: - Wire format

    /// A crop in normalized coordinates — `0…1` of the image's width and
    /// height, so it survives any resize.
    struct Crop: Codable, Equatable, Sendable {
        let x: Double
        let y: Double
        let w: Double
        let h: Double
    }

    /// The aspect ratios the server crops to, in the order the web lists them.
    enum AspectRatio: String, CaseIterable, Identifiable, Sendable {
        case square = "1:1"
        case fourFive = "4:5"
        case fiveFour = "5:4"
        case threeFour = "3:4"
        case fourThree = "4:3"
        case sixteenNine = "16:9"
        case nineSixteen = "9:16"

        var id: String { rawValue }

        /// Width over height.
        var value: Double {
            let parts = rawValue.split(separator: ":").compactMap { Double($0) }
            guard parts.count == 2, parts[1] != 0 else { return 1 }
            return parts[0] / parts[1]
        }

        var isPortrait: Bool { value < 1 }
        var isSquare: Bool { value == 1 }
    }

    /// Where a recipe came from.
    enum Source: String, Codable, Sendable {
        case user, ai, adopted
    }

    /// One saved recipe.
    struct Row: Codable, Identifiable, Equatable, Sendable {
        let id: Int
        let photo_id: Int
        let user_id: Int
        let source: Source
        let adopted_from: Int?
        let crop: Crop?
        let rotation: Int
        let exposure: Double
        let contrast: Double
        let gamma: Double
        let white_point: Double?
        let black_point: Double?
    }

    /// Someone else's recipe, with the name to offer it under.
    struct Other: Codable, Identifiable, Sendable {
        struct User: Codable, Sendable {
            let id: Int
            let name: String
        }

        let id: Int
        let photo_id: Int
        let user_id: Int
        let source: Source
        let adopted_from: Int?
        let crop: Crop?
        let rotation: Int
        let exposure: Double
        let contrast: Double
        let gamma: Double
        let white_point: Double?
        let black_point: Double?
        let user: User
    }

    /// What the AI proposed: one crop per ratio it could compose, plus tone.
    ///
    /// A missing ratio means the subject did not fit it — a photo with no
    /// detected face gets no crops at all, since a blind centred crop says
    /// nothing. The tone values are independent of that.
    struct Suggestion: Codable, Sendable {
        let crops: [String: Crop]
        let exposure: Double
        let contrast: Double
        let gamma: Double
        let white_point: Double?
        let black_point: Double?
    }

    /// Everything the editor needs, in one request.
    struct Bundle: Codable, Sendable {
        let mine: Row?
        let others: [Other]
        let suggestion: Suggestion?
        let model_version: String?
    }

    // MARK: - Requests

    struct FromSuggestionRequest: Encodable, Sendable {
        let ratio: String
    }

    struct AdoptRequest: Encodable, Sendable {
        let from_transform_id: Int
    }

    /// `DELETE /photos/:id/transforms`. Idempotent, so `deleted: false` only
    /// means there was nothing there — not a failure.
    struct DeleteResult: Decodable, Sendable {
        let deleted: Bool
    }

    // MARK: - Rendering

    /// Which version of a photo to render.
    enum Variant: Equatable, Sendable {
        /// The file as uploaded.
        case original
        /// The AI's proposal at one ratio — a preview, not something saved.
        case suggested(AspectRatio)
        /// What a given user saved.
        case user(id: Int)
    }

    /// Query for `GET /photos/:id/render`.
    ///
    /// The route answers `v=original` with a redirect to the plain file
    /// endpoint, so one call site can ask for any version.
    static func renderQuery(_ variant: Variant, width: Int? = nil) -> [String: String] {
        var query: [String: String] = [:]
        switch variant {
        case .original:
            query["v"] = "original"
        case .suggested(let ratio):
            query["v"] = "suggested"
            query["ratio"] = ratio.rawValue
        case .user(let id):
            query["v"] = "user"
            query["user"] = String(id)
        }
        if let width { query["w"] = String(width) }
        return query
    }

    static func renderPath(photoId: Int) -> String {
        "/photos/\(photoId)/render"
    }

    // MARK: - Reading a bundle

    /// The ratios the AI actually composed a crop for, in the listed order.
    ///
    /// Only these get a face-aware crop; the rest would fall back to a centred
    /// one, which is the cropper's job rather than a one-tap action.
    static func suggestedRatios(in bundle: Bundle?) -> [AspectRatio] {
        guard let crops = bundle?.suggestion?.crops else { return [] }
        return AspectRatio.allCases.filter { crops[$0.rawValue] != nil }
    }

    /// Other people's recipes, by name, so the list does not reshuffle
    /// between loads.
    static func adoptable(in bundle: Bundle?) -> [Other] {
        (bundle?.others ?? []).sorted {
            $0.user.name.localizedCaseInsensitiveCompare($1.user.name) == .orderedAscending
        }
    }

    /// Whether this photo currently renders through a recipe of the user's own.
    static func hasOwnRecipe(_ bundle: Bundle?) -> Bool {
        bundle?.mine != nil
    }

    /// What to render for a user looking at this photo: their own recipe when
    /// they have one, the original otherwise. A suggestion is never shown in
    /// place of the photo — it is a proposal, and the user confirms it.
    static func displayVariant(for bundle: Bundle?, userId: Int?) -> Variant {
        guard bundle?.mine != nil, let userId else { return .original }
        return .user(id: userId)
    }

    // MARK: - Describing a recipe

    /// A recipe in one line — „4:5 · +0,5 EV · Kontrast +20 %" — so a row in a
    /// list says what adopting it would do.
    ///
    /// Values at their neutral point are left out rather than written as
    /// „0 EV": a recipe that only crops should read as only cropping.
    static func summary(
        crop: Crop?,
        rotation: Int,
        exposure: Double,
        contrast: Double,
        gamma: Double,
        locale: Locale = Locale(identifier: "de_DE")
    ) -> String {
        var parts: [String] = []
        if crop != nil { parts.append("Zugeschnitten") }
        if rotation != 0 { parts.append("\(rotation)°") }
        if let ev = signedDecimal(exposure, locale: locale) { parts.append("\(ev) EV") }
        if let percent = signedPercent(contrast, locale: locale) {
            parts.append("Kontrast \(percent)")
        }
        // Gamma is multiplicative, so 1 is the neutral value, not 0.
        if abs(gamma - 1) >= 0.01 {
            parts.append("Gamma \(decimal(gamma, locale: locale))")
        }
        return parts.isEmpty ? "Unverändert" : parts.joined(separator: " · ")
    }

    static func summary(of row: Row, locale: Locale = Locale(identifier: "de_DE")) -> String {
        summary(
            crop: row.crop,
            rotation: row.rotation,
            exposure: row.exposure,
            contrast: row.contrast,
            gamma: row.gamma,
            locale: locale
        )
    }

    static func summary(of other: Other, locale: Locale = Locale(identifier: "de_DE")) -> String {
        summary(
            crop: other.crop,
            rotation: other.rotation,
            exposure: other.exposure,
            contrast: other.contrast,
            gamma: other.gamma,
            locale: locale
        )
    }

    // MARK: - Number formatting

    /// A signed value like „+0,5", or nil when it is neutral enough to omit.
    private static func signedDecimal(_ value: Double, locale: Locale) -> String? {
        guard abs(value) >= 0.01 else { return nil }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 1
        formatter.positivePrefix = "+"
        return formatter.string(from: NSNumber(value: value))
    }

    /// A signed percentage like „+20 %", or nil when neutral.
    private static func signedPercent(_ value: Double, locale: Locale) -> String? {
        guard abs(value) >= 0.01 else { return nil }
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        formatter.positivePrefix = "+"
        let rounded = (value * 100).rounded()
        guard let text = formatter.string(from: NSNumber(value: rounded)) else { return nil }
        return "\(text) %"
    }

    private static func decimal(_ value: Double, locale: Locale) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }
}
