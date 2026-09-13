/// How much of the destination a day trip is about (§4.5).
///
/// The server plans an outing at the size of the place — eight
/// kilometres, wide enough for a city with its outskirts. That is right
/// for "we are going to Verona" and wrong at both ends: a day inside
/// one old town is smaller, and a day spent driving a valley is larger.
/// The day anchor has carried a `radiusM` since it existed; nothing in
/// the app ever offered it, so the only answer anybody could give was
/// the default one.
///
/// Three choices rather than a field in metres. Nobody plans a day in
/// metres — they say which of these three days it is, and the metres
/// are this table's business.
enum TripOutingReach: String, CaseIterable, Identifiable, Sendable {
    /// The old town and the walk between its corners.
    case centre
    /// The default: the city and its edges, as the server plans it.
    case place
    /// The valley, the coast road, the three villages.
    case region

    var id: String { rawValue }

    var label: String {
        switch self {
        case .centre: return "Ortskern"
        case .place: return "Ort"
        case .region: return "Gegend"
        }
    }

    /// What to send. Nil for the ordinary case: the default belongs to
    /// the server, and writing 8 000 into the day would freeze today's
    /// number into every plan made today.
    var radiusM: Int? {
        switch self {
        case .centre: return 2_000
        case .place: return nil
        case .region: return 25_000
        }
    }

    /// What the choice means for the day, in the sentence under it.
    var explanation: String {
        switch self {
        case .centre:
            return "Nur das Zentrum — Vorschläge im Umkreis von zwei Kilometern."
        case .place:
            return "Der Ort mit seinem Rand. Das ist der Normalfall."
        case .region:
            return "Auch, was weiter draußen liegt — bis fünfundzwanzig Kilometer. "
                + "Sinnvoll, wenn der Tag ohnehin im Auto stattfindet."
        }
    }

    /// The choice a stored day describes.
    ///
    /// An exact match for the two named radii, and everything else —
    /// including a radius from some future version of the sheet — reads
    /// as the nearest of the three rather than as nothing at all. The
    /// alternative is a sheet that opens on the default and silently
    /// widens a day somebody had narrowed.
    static func of(radiusM: Int?) -> TripOutingReach {
        guard let radiusM else { return .place }
        if radiusM <= 3_000 { return .centre }
        if radiusM >= 12_000 { return .region }
        return .place
    }
}
