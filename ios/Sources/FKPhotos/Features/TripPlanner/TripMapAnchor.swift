/// The point a day's map is anchored to, and what it honestly is.
///
/// The day map drew a house labelled "Unterkunft" at the leg's anchor,
/// always. On an ordinary day that is right: the day leaves the
/// quarters in the morning and comes back at night (§4.5). On a day
/// trip it was wrong twice — the pin sat sixty kilometres from the
/// spots around it, and it called the place a hotel.
///
/// Pure, and separate from the map, because "which point, and what is
/// it called" has right and wrong answers while the drawing does not.
struct TripMapAnchor: Equatable {
    let coordinate: TripCoordinate
    /// What the pin says: "Unterkunft", or the outing's own name.
    let label: String
    let symbolName: String

    /// Where this day is anchored: its own destination when it is a day
    /// trip, the quarters otherwise.
    ///
    /// The name is never invented (§15.3): an outing nobody named says
    /// "Ausflugsziel" rather than borrowing the hotel's word for
    /// itself.
    static func of(day: TripDay?, legAnchor: TripCoordinate) -> TripMapAnchor {
        guard let anchor = day?.anchor else {
            return TripMapAnchor(
                coordinate: legAnchor,
                label: "Unterkunft",
                symbolName: "house.fill",
            )
        }
        return TripMapAnchor(
            coordinate: anchor.coordinate,
            label: anchor.displayName == "Auswärts" ? "Ausflugsziel" : anchor.displayName,
            // Not a house: the group sleeps at the quarters and spends
            // this day somewhere else.
            symbolName: "mappin.and.ellipse",
        )
    }
}
