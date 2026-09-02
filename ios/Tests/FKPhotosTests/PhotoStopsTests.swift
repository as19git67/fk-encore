import XCTest
@testable import FKPhotosLib

/// Grouping photos into the places they were taken — the Swift side of the
/// web's `usePhotoStops`, which drives both map views.
final class PhotoStopsTests: XCTestCase {

    /// Fixed so day keys and cluster labels do not depend on the runner's zone.
    private let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return cal
    }()

    /// A synthetic photo. Coordinates default to a made-up spot; every value
    /// here is invented, never taken from a real library.
    private func photo(
        id: Int,
        lat: Double? = nil,
        lon: Double? = nil,
        takenAt: String? = nil,
        score: Double? = nil,
        name: String? = nil,
        city: String? = nil,
        country: String? = nil
    ) -> PhotoWithCuration {
        PhotoWithCuration(
            id: id,
            user_id: 1,
            filename: "photo-\(id).jpg",
            original_name: "photo-\(id).jpg",
            mime_type: "image/jpeg",
            size: 0,
            hash: nil,
            taken_at: takenAt,
            created_at: "2024-06-01T12:00:00.000Z",
            latitude: lat,
            longitude: lon,
            location_name: name,
            location_city: city,
            location_country: country,
            ai_quality_score: score,
            auto_crop: nil,
            curation_status: .visible,
            description: nil,
            keywords: nil
        )
    }

    /// Metres north of a base latitude, as a latitude delta. One degree of
    /// latitude is ~111.32 km everywhere, so this is exact enough to place
    /// fixtures a known distance apart.
    private func latOffset(_ meters: Double) -> Double {
        meters / 111_320
    }

    // MARK: - Distance

    func testDistanceBetweenTheSamePointIsZero() {
        let point = PhotoStops.Coordinate(latitude: 48.0, longitude: 11.0)
        XCTAssertEqual(PhotoStops.distance(point, point), 0, accuracy: 0.001)
    }

    func testADegreeOfLatitudeIsAboutOneHundredElevenKilometres() {
        let d = PhotoStops.distance(
            PhotoStops.Coordinate(latitude: 48.0, longitude: 11.0),
            PhotoStops.Coordinate(latitude: 49.0, longitude: 11.0)
        )
        XCTAssertEqual(d, 111_195, accuracy: 500)
    }

    func testDistanceIsSymmetric() {
        let a = PhotoStops.Coordinate(latitude: 48.1, longitude: 11.5)
        let b = PhotoStops.Coordinate(latitude: 52.5, longitude: 13.4)
        XCTAssertEqual(
            PhotoStops.distance(a, b),
            PhotoStops.distance(b, a),
            accuracy: 0.001
        )
    }

    // MARK: - Day keys

    func testTheDayKeyIsLocalNotUTC() {
        // 22:30 Berlin on 1 June is 20:30 UTC the same day — but an evening
        // photo in summer sits close enough to midnight UTC that a UTC key
        // would drift. Pin it just past midnight Berlin, where the two differ.
        let p = photo(id: 1, takenAt: "2024-06-01T22:30:00.000Z")
        // 22:30 UTC is 00:30 Berlin on the 2nd.
        XCTAssertEqual(PhotoStops.dayKey(p, calendar: calendar), "2024-06-02")
    }

    func testCreatedAtStandsInWhenNothingWasTaken() {
        let p = photo(id: 1, takenAt: nil)
        XCTAssertEqual(PhotoStops.dayKey(p, calendar: calendar), "2024-06-01")
    }

    // MARK: - Cover

    func testTheCoverIsTheBestScoringPhoto() {
        let photos = [
            photo(id: 1, score: 0.4),
            photo(id: 2, score: 0.9),
            photo(id: 3, score: 0.7),
        ]
        XCTAssertEqual(PhotoStops.cover(of: photos)?.id, 2)
    }

    func testAnUnscoredSetKeepsTheFirstPhoto() {
        let photos = [photo(id: 7), photo(id: 8)]
        XCTAssertEqual(PhotoStops.cover(of: photos)?.id, 7)
    }

    func testNothingHasNoCover() {
        XCTAssertNil(PhotoStops.cover(of: []))
    }

    // MARK: - Location label

    func testTheLabelDropsTheCityTheNameAlreadyCarries() {
        let p = photo(id: 1, name: "Beispielgasse 4, Musterstadt", city: "Musterstadt")
        XCTAssertEqual(PhotoStops.locationLabel(for: p), "Beispielgasse 4, Musterstadt")
    }

    func testTheLabelJoinsNameAndCityWhenTheyDiffer() {
        let p = photo(id: 1, name: "Beispielgasse 4", city: "Musterstadt")
        XCTAssertEqual(PhotoStops.locationLabel(for: p), "Beispielgasse 4, Musterstadt")
    }

    func testTheCountryOnlyStandsInWhenNothingElseIsKnown() {
        XCTAssertEqual(
            PhotoStops.locationLabel(for: photo(id: 1, country: "Beispielland")),
            "Beispielland"
        )
        XCTAssertEqual(
            PhotoStops.locationLabel(for: photo(id: 2, city: "Musterstadt", country: "Beispielland")),
            "Musterstadt"
        )
    }

    func testDuplicateTokensAreDroppedCaseInsensitively() {
        let p = photo(id: 1, name: "MUSTERSTADT", city: "Musterstadt")
        XCTAssertEqual(PhotoStops.locationLabel(for: p), "MUSTERSTADT")
    }

    func testAPhotoWithoutAnyPlaceHasNoLabel() {
        XCTAssertEqual(PhotoStops.locationLabel(for: photo(id: 1)), "")
    }

    // MARK: - Radii

    func testAWideDayKeepsTheFullRadii() {
        let (include, separation) = PhotoStops.radii(forDaySpan: 50_000)
        XCTAssertEqual(include, PhotoStops.clusterIncludeMeters, accuracy: 0.001)
        XCTAssertEqual(separation, PhotoStops.minClusterSeparationMeters, accuracy: 0.001)
    }

    func testADayInOneCityTightensTheRadii() {
        // Half the reference span → half the radii, so the day still splits.
        let (include, separation) = PhotoStops.radii(forDaySpan: 10_000)
        XCTAssertEqual(include, PhotoStops.clusterIncludeMeters * 0.5, accuracy: 0.001)
        XCTAssertEqual(separation, PhotoStops.minClusterSeparationMeters * 0.5, accuracy: 0.001)
    }

    func testTheRadiiNeverShrinkPastTheFloor() {
        // A burst at one spot must not shatter into single-photo stops.
        let (include, separation) = PhotoStops.radii(forDaySpan: 10)
        XCTAssertEqual(include, PhotoStops.clusterIncludeMeters * PhotoStops.minRadiusScale, accuracy: 0.001)
        XCTAssertEqual(separation, PhotoStops.minClusterSeparationMeters * PhotoStops.minRadiusScale, accuracy: 0.001)
    }

    // MARK: - Stops

    func testPhotosWithoutCoordinatesAreNotOnTheMap() {
        let photos = [photo(id: 1), photo(id: 2, lat: 48.0, lon: 11.0)]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.count, 1)
        XCTAssertEqual(stops.first?.photos.map(\.id), [2])
    }

    func testNoCoordinatesAtAllMeansNoStops() {
        XCTAssertTrue(PhotoStops.stops(for: [photo(id: 1), photo(id: 2)], calendar: calendar).isEmpty)
    }

    func testPhotosTakenAtOneSpotBecomeOneStop() {
        let photos = (1...5).map { i in
            photo(
                id: i,
                lat: 48.0 + latOffset(Double(i) * 5),   // ~5 m apart
                lon: 11.0,
                takenAt: "2024-06-01T1\(i):00:00.000Z"
            )
        }
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.count, 1)
        XCTAssertEqual(stops.first?.photos.count, 5)
    }

    func testPlacesFurtherApartThanTheSeparationBecomeSeparateStops() {
        // A wide day (spanning 50 km) keeps the full 400/600 m radii, so two
        // spots 50 km apart cannot merge.
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 2, lat: 48.0 + latOffset(50_000), lon: 11.0, takenAt: "2024-06-01T14:00:00.000Z"),
        ]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.count, 2)
    }

    func testEveryPhotoLandsInExactlyOneStop() {
        let photos = (1...12).map { i in
            photo(
                id: i,
                lat: 48.0 + latOffset(Double(i) * 900),
                lon: 11.0,
                takenAt: "2024-06-01T1\(i % 10):00:00.000Z"
            )
        }
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        let placed = stops.flatMap { $0.photos.map(\.id) }
        XCTAssertEqual(Set(placed), Set(photos.map(\.id)))
        XCTAssertEqual(placed.count, photos.count, "no photo may appear twice")
    }

    func testDifferentDaysNeverShareAStop() {
        // Same spot, two days.
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 2, lat: 48.0, lon: 11.0, takenAt: "2024-06-02T10:00:00.000Z"),
        ]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.count, 2)
        XCTAssertEqual(stops.map(\.day), ["2024-06-01", "2024-06-02"])
    }

    func testStopsAreNumberedInOrderAcrossDays() {
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-02T10:00:00.000Z"),
            photo(id: 2, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
        ]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.map(\.id), [0, 1])
        XCTAssertEqual(stops.map(\.day), ["2024-06-01", "2024-06-02"])
    }

    func testAStopsPhotosAreInChronologicalOrder() {
        let photos = [
            photo(id: 3, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T18:00:00.000Z"),
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 2, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T14:00:00.000Z"),
        ]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.first?.photos.map(\.id), [1, 2, 3])
    }

    func testAStopIsLabelledAfterItsCover() {
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z",
                  score: 0.2, city: "Kleinstadt"),
            photo(id: 2, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T11:00:00.000Z",
                  score: 0.9, city: "Musterstadt"),
        ]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.first?.coverPhoto.id, 2)
        XCTAssertEqual(stops.first?.locationLabel, "Musterstadt")
    }

    // MARK: - Days

    func testTheDayListIsSortedAndUnique() {
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-03T10:00:00.000Z"),
            photo(id: 2, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 3, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T12:00:00.000Z"),
        ]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(PhotoStops.days(of: stops), ["2024-06-01", "2024-06-03"])
    }

    func testStopsGroupUnderTheirDay() {
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 2, lat: 48.0, lon: 11.0, takenAt: "2024-06-02T10:00:00.000Z"),
        ]
        let grouped = PhotoStops.byDay(PhotoStops.stops(for: photos, calendar: calendar))
        XCTAssertEqual(grouped["2024-06-01"]?.count, 1)
        XCTAssertEqual(grouped["2024-06-02"]?.count, 1)
    }

    // MARK: - Overview

    func testNearbyStopsMergeIntoOneOverviewPin() {
        // Same spot on two days — two stops, but one region.
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 2, lat: 48.0, lon: 11.0, takenAt: "2024-06-02T10:00:00.000Z"),
        ]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.count, 2)
        let clusters = PhotoStops.overviewClusters(for: stops)
        XCTAssertEqual(clusters.count, 1)
        XCTAssertEqual(Set(clusters[0].stopIds), Set(stops.map(\.id)))
    }

    func testRegionsFurtherApartThanTheMergeRadiusStayApart() {
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 2, lat: 48.0 + latOffset(200_000), lon: 11.0, takenAt: "2024-06-02T10:00:00.000Z"),
        ]
        let clusters = PhotoStops.overviewClusters(for: PhotoStops.stops(for: photos, calendar: calendar))
        XCTAssertEqual(clusters.count, 2)
    }

    func testEveryStopLandsInExactlyOneOverviewCluster() {
        let photos = (1...9).map { i in
            photo(
                id: i,
                lat: 48.0 + latOffset(Double(i) * 20_000),
                lon: 11.0,
                takenAt: "2024-06-0\(i)T10:00:00.000Z"
            )
        }
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        let clusters = PhotoStops.overviewClusters(for: stops)
        let assigned = clusters.flatMap(\.stopIds)
        XCTAssertEqual(Set(assigned), Set(stops.map(\.id)))
        XCTAssertEqual(assigned.count, stops.count)
    }

    func testNoStopsMeansNoOverview() {
        XCTAssertTrue(PhotoStops.overviewClusters(for: []).isEmpty)
    }

    // MARK: - Jumps

    func testASingleStopHasNothingToJumpBetween() {
        let photos = [photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z")]
        XCTAssertTrue(PhotoStops.longJumps(for: PhotoStops.stops(for: photos, calendar: calendar)).isEmpty)
    }

    func testOnlyTheLongestHopsAreDrawn() {
        // Nine short hops and one very long one: the 90th percentile keeps
        // the long one and drops the rest.
        var photos: [PhotoWithCuration] = []
        for i in 1...10 {
            photos.append(photo(
                id: i,
                lat: 48.0 + latOffset(Double(i) * 30_000),
                lon: 11.0,
                takenAt: "2024-06-\(String(format: "%02d", i))T10:00:00.000Z"
            ))
        }
        photos.append(photo(
            id: 11,
            lat: 48.0 + latOffset(3_000_000),
            lon: 11.0,
            takenAt: "2024-06-11T10:00:00.000Z"
        ))
        let jumps = PhotoStops.longJumps(for: PhotoStops.stops(for: photos, calendar: calendar))
        XCTAssertEqual(jumps.count, 1)
        XCTAssertEqual(jumps.first?.toDay, "2024-06-11")
    }

    func testOnlyConsecutiveStopsAreCandidates() {
        // Three stops → two candidate hops, never the A→C shortcut.
        let photos = (1...3).map { i in
            photo(
                id: i,
                lat: 48.0 + latOffset(Double(i) * 40_000),
                lon: 11.0,
                takenAt: "2024-06-0\(i)T10:00:00.000Z"
            )
        }
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(stops.count, 3)
        let jumps = PhotoStops.longJumps(for: stops)
        for jump in jumps {
            let d = PhotoStops.distance(jump.from, jump.to)
            // An A→C line would be ~80 km; only ~40 km hops are legitimate.
            XCTAssertLessThan(d, 60_000)
        }
    }

    // MARK: - Bounds

    func testBoundsCoverEveryStopWithPadding() throws {
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z"),
            photo(id: 2, lat: 49.0, lon: 12.0, takenAt: "2024-06-02T10:00:00.000Z"),
        ]
        let b = try XCTUnwrap(
            PhotoStops.bounds(for: PhotoStops.stops(for: photos, calendar: calendar))
        )
        XCTAssertLessThan(b.minLatitude, 48.0)
        XCTAssertGreaterThan(b.maxLatitude, 49.0)
        XCTAssertLessThan(b.minLongitude, 11.0)
        XCTAssertGreaterThan(b.maxLongitude, 12.0)
    }

    func testASinglePointStillGetsARegionAMapCanShow() throws {
        let b = try XCTUnwrap(
            PhotoStops.bounds(for: [PhotoStops.Coordinate(latitude: 48.0, longitude: 11.0)])
        )
        XCTAssertEqual(b.maxLatitude - b.minLatitude, 0.01, accuracy: 0.0001)
        XCTAssertEqual(b.maxLongitude - b.minLongitude, 0.01, accuracy: 0.0001)
    }

    func testNothingHasNoBounds() {
        XCTAssertNil(PhotoStops.bounds(for: [] as [PhotoStops.Coordinate]))
    }
}

/// The timeline strip beside the map: the run of cards, the day colours and
/// the captions on them.
final class PhotoStopsTimelineTests: XCTestCase {

    private let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return cal
    }()

    private func photo(
        id: Int,
        lat: Double,
        lon: Double,
        takenAt: String,
        city: String? = nil
    ) -> PhotoWithCuration {
        PhotoWithCuration(
            id: id,
            user_id: 1,
            filename: "photo-\(id).jpg",
            original_name: "photo-\(id).jpg",
            mime_type: "image/jpeg",
            size: 0,
            hash: nil,
            taken_at: takenAt,
            created_at: takenAt,
            latitude: lat,
            longitude: lon,
            location_name: nil,
            location_city: city,
            location_country: nil,
            ai_quality_score: nil,
            auto_crop: nil,
            curation_status: .visible,
            description: nil,
            keywords: nil
        )
    }

    /// Three stops: two on the first day, one on the second.
    private func threeStops() -> [PhotoStops.Stop] {
        let photos = [
            photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z", city: "Musterstadt"),
            photo(id: 2, lat: 48.5, lon: 11.0, takenAt: "2024-06-01T16:00:00.000Z", city: "Kleinstadt"),
            photo(id: 3, lat: 49.0, lon: 11.0, takenAt: "2024-06-02T10:00:00.000Z", city: "Beispieldorf"),
        ]
        return PhotoStops.stops(for: photos, calendar: calendar)
    }

    // MARK: - Colours

    func testEachDayGetsThePaletteInOrder() {
        let colors = PhotoStops.colors(forDays: ["2024-06-01", "2024-06-02", "2024-06-03"])
        XCTAssertEqual(colors["2024-06-01"], PhotoStops.dayColors[0])
        XCTAssertEqual(colors["2024-06-02"], PhotoStops.dayColors[1])
        XCTAssertEqual(colors["2024-06-03"], PhotoStops.dayColors[2])
    }

    func testATripLongerThanThePaletteWrapsAround() {
        let days = (1...12).map { String(format: "2024-06-%02d", $0) }
        let colors = PhotoStops.colors(forDays: days)
        XCTAssertEqual(colors[days[10]], PhotoStops.dayColors[0])
        XCTAssertEqual(colors[days[11]], PhotoStops.dayColors[1])
    }

    func testHexColoursParseToChannels() throws {
        let white = try XCTUnwrap(PhotoStops.rgb(fromHex: "#FFFFFF"))
        XCTAssertEqual(white.red, 1, accuracy: 0.001)
        XCTAssertEqual(white.green, 1, accuracy: 0.001)
        XCTAssertEqual(white.blue, 1, accuracy: 0.001)

        let blue = try XCTUnwrap(PhotoStops.rgb(fromHex: "#4285F4"))
        XCTAssertEqual(blue.red, 66.0 / 255, accuracy: 0.001)
        XCTAssertEqual(blue.green, 133.0 / 255, accuracy: 0.001)
        XCTAssertEqual(blue.blue, 244.0 / 255, accuracy: 0.001)
    }

    func testTheHashIsOptional() throws {
        let withHash = try XCTUnwrap(PhotoStops.rgb(fromHex: "#4285F4"))
        let without = try XCTUnwrap(PhotoStops.rgb(fromHex: "4285F4"))
        XCTAssertEqual(withHash.red, without.red, accuracy: 0.0001)
    }

    func testEveryPaletteEntryParses() {
        for hex in PhotoStops.dayColors {
            XCTAssertNotNil(PhotoStops.rgb(fromHex: hex), "\(hex) should parse")
        }
    }

    func testNonsenseIsNotAColour() {
        XCTAssertNil(PhotoStops.rgb(fromHex: ""))
        XCTAssertNil(PhotoStops.rgb(fromHex: "#FFF"))
        XCTAssertNil(PhotoStops.rgb(fromHex: "#GGGGGG"))
    }

    // MARK: - Titles

    func testAStopIsTitledByItsPlace() {
        let stops = threeStops()
        XCTAssertEqual(PhotoStops.title(of: stops[0]), "Musterstadt")
    }

    func testAStopWithoutAPlaceIsNumberedFromOne() {
        let photos = [photo(id: 1, lat: 48.0, lon: 11.0, takenAt: "2024-06-01T10:00:00.000Z")]
        let stops = PhotoStops.stops(for: photos, calendar: calendar)
        XCTAssertEqual(PhotoStops.title(of: stops[0]), "Stopp 1")
    }

    // MARK: - Entries

    func testTheStripLeadsWithTheOverviewCard() throws {
        let entries = PhotoStops.timeline(for: threeStops())
        guard case .overview(let dayCount) = try XCTUnwrap(entries.first) else {
            return XCTFail("expected the overview card first")
        }
        XCTAssertEqual(dayCount, 2)
    }

    func testEveryStopGetsACardInOrder() {
        let stops = threeStops()
        let entries = PhotoStops.timeline(for: stops)
        XCTAssertEqual(entries.count, stops.count + 1)
        let ids = entries.dropFirst().map(\.id)
        XCTAssertEqual(ids, stops.map(\.id))
    }

    func testOnlyTheFirstStopOfADayIsMarked() {
        let entries = PhotoStops.timeline(for: threeStops()).dropFirst()
        let marks = entries.map { entry -> Bool in
            guard case .stop(_, let isFirstOfDay, _) = entry else { return false }
            return isFirstOfDay
        }
        // Two stops on day one, one on day two.
        XCTAssertEqual(marks, [true, false, true])
    }

    func testStopsOfOneDayShareTheirColour() {
        let entries = PhotoStops.timeline(for: threeStops()).dropFirst()
        let colors = entries.compactMap { entry -> String? in
            guard case .stop(_, _, let color) = entry else { return nil }
            return color
        }
        XCTAssertEqual(colors[0], colors[1], "same day, same colour")
        XCTAssertNotEqual(colors[1], colors[2], "a new day changes colour")
    }

    func testTheOverviewCardNeverCollidesWithAStop() {
        let entries = PhotoStops.timeline(for: threeStops())
        XCTAssertEqual(Set(entries.map(\.id)).count, entries.count)
    }

    func testNoStopsMeansNoStrip() {
        XCTAssertTrue(PhotoStops.timeline(for: []).isEmpty)
    }

    func testTheOverviewIdIsReserved() {
        // Stop ids count up from zero, so the overview card must sit below.
        XCTAssertLessThan(PhotoStops.overviewEntryId, 0)
    }

    // MARK: - Card date

    func testACardCarriesItsStopsDate() {
        let stops = threeStops()
        let label = PhotoMapView.stopDate(
            of: stops[0],
            timeZone: TimeZone(identifier: "Europe/Berlin")!
        )
        XCTAssertTrue(label.hasPrefix("01."), "expected 01. …, got \(label)")
    }
}

/// Clustering driven by what the map is showing, rather than by the day-span
/// heuristic — zooming in splits stops, zooming out merges them.
final class PhotoStopsZoomTests: XCTestCase {

    private let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        return cal
    }()

    private func photo(id: Int, lat: Double, lon: Double, takenAt: String) -> PhotoWithCuration {
        PhotoWithCuration(
            id: id,
            user_id: 1,
            filename: "photo-\(id).jpg",
            original_name: "photo-\(id).jpg",
            mime_type: "image/jpeg",
            size: 0,
            hash: nil,
            taken_at: takenAt,
            created_at: takenAt,
            latitude: lat,
            longitude: lon,
            location_name: nil,
            location_city: nil,
            location_country: nil,
            ai_quality_score: nil,
            auto_crop: nil,
            curation_status: .visible,
            description: nil,
            keywords: nil
        )
    }

    private func latOffset(_ meters: Double) -> Double { meters / 111_320 }

    /// Four photos on one day, each 500 m from the last.
    private func fourStopsApart() -> [PhotoWithCuration] {
        (0..<4).map { i in
            photo(
                id: i + 1,
                lat: 48.0 + latOffset(Double(i) * 500),
                lon: 11.0,
                takenAt: "2024-06-01T1\(i):00:00.000Z"
            )
        }
    }

    // MARK: - Radii

    func testTheZoomRadiusBecomesTheSeparation() {
        let (include, separation) = PhotoStops.radii(forZoomRadius: 1_200)
        XCTAssertEqual(separation, 1_200, accuracy: 0.001)
        // Same include/separation ratio as the static defaults.
        XCTAssertEqual(
            include / separation,
            PhotoStops.clusterIncludeMeters / PhotoStops.minClusterSeparationMeters,
            accuracy: 0.001
        )
    }

    func testZoomingAllTheWayInStopsAtTheFloor() {
        // Otherwise GPS jitter shatters a burst into single-photo stops.
        let (_, separation) = PhotoStops.radii(forZoomRadius: 1)
        XCTAssertEqual(separation, PhotoStops.minZoomClusterRadiusMeters, accuracy: 0.001)
    }

    // MARK: - Projection

    func testAWiderSpanOverTheSameScreenMeansMoreMetersPerPoint() throws {
        let narrow = try XCTUnwrap(
            PhotoStops.metersPerPoint(longitudeDelta: 0.01, latitude: 48, widthInPoints: 400)
        )
        let wide = try XCTUnwrap(
            PhotoStops.metersPerPoint(longitudeDelta: 0.1, latitude: 48, widthInPoints: 400)
        )
        XCTAssertEqual(wide / narrow, 10, accuracy: 0.01)
    }

    func testADegreeOfLongitudeShrinksTowardsThePoles() throws {
        let equator = try XCTUnwrap(
            PhotoStops.metersPerPoint(longitudeDelta: 1, latitude: 0, widthInPoints: 400)
        )
        let north = try XCTUnwrap(
            PhotoStops.metersPerPoint(longitudeDelta: 1, latitude: 60, widthInPoints: 400)
        )
        // cos(60°) = 0.5.
        XCTAssertEqual(north / equator, 0.5, accuracy: 0.01)
    }

    func testAMapWithNoSizeOrNoSpanHasNoScale() {
        XCTAssertNil(PhotoStops.metersPerPoint(longitudeDelta: 0.01, latitude: 48, widthInPoints: 0))
        XCTAssertNil(PhotoStops.metersPerPoint(longitudeDelta: 0, latitude: 48, widthInPoints: 400))
    }

    func testTheClusterRadiusIsThePinOverlapInMeters() throws {
        let perPoint = try XCTUnwrap(
            PhotoStops.metersPerPoint(longitudeDelta: 0.05, latitude: 48, widthInPoints: 390)
        )
        let radius = try XCTUnwrap(
            PhotoStops.clusterRadius(longitudeDelta: 0.05, latitude: 48, widthInPoints: 390)
        )
        XCTAssertEqual(radius, perPoint * PhotoStops.pinOverlapPoints, accuracy: 0.001)
    }

    // MARK: - Clustering at a radius

    func testZoomedOutTheStopsMergeIntoOne() {
        // A radius wide enough to swallow all four spots.
        let stops = PhotoStops.stops(
            for: fourStopsApart(),
            clusterRadiusMeters: 5_000,
            calendar: calendar
        )
        XCTAssertEqual(stops.count, 1)
        XCTAssertEqual(stops.first?.photos.count, 4)
    }

    func testZoomedInTheyBecomeSeparateStops() {
        // Well below the 500 m gaps.
        let stops = PhotoStops.stops(
            for: fourStopsApart(),
            clusterRadiusMeters: 50,
            calendar: calendar
        )
        XCTAssertEqual(stops.count, 4)
    }

    func testZoomingInNeverLosesAPhoto() {
        let photos = fourStopsApart()
        for radius in [30.0, 100, 300, 700, 2_000, 10_000] {
            let stops = PhotoStops.stops(
                for: photos,
                clusterRadiusMeters: radius,
                calendar: calendar
            )
            let placed = stops.flatMap { $0.photos.map(\.id) }
            XCTAssertEqual(Set(placed), Set(photos.map(\.id)), "radius \(radius)")
            XCTAssertEqual(placed.count, photos.count, "radius \(radius): no duplicates")
        }
    }

    func testTighterRadiiNeverYieldFewerStops() {
        let photos = fourStopsApart()
        var previous = 0
        for radius in [10_000.0, 2_000, 700, 300, 100, 30] {
            let count = PhotoStops.stops(
                for: photos,
                clusterRadiusMeters: radius,
                calendar: calendar
            ).count
            XCTAssertGreaterThanOrEqual(count, previous, "radius \(radius) split fewer than a wider one")
            previous = count
        }
    }

    func testWithoutARadiusTheDaySpanHeuristicStillDecides() {
        let photos = fourStopsApart()
        let heuristic = PhotoStops.stops(for: photos, calendar: calendar)
        let explicit = PhotoStops.stops(
            for: photos,
            clusterRadiusMeters: nil,
            calendar: calendar
        )
        XCTAssertEqual(heuristic.count, explicit.count)
    }

    // MARK: - Anchoring

    func testAPhotoFindsTheStopItLandedIn() throws {
        let stops = PhotoStops.stops(
            for: fourStopsApart(),
            clusterRadiusMeters: 50,
            calendar: calendar
        )
        let stop = try XCTUnwrap(PhotoStops.stop(containing: 3, in: stops))
        XCTAssertTrue(stop.photos.contains { $0.id == 3 })
    }

    func testAnAnchorSurvivesAReclusterEvenThoughIdsDoNot() throws {
        let photos = fourStopsApart()
        let zoomedIn = PhotoStops.stops(for: photos, clusterRadiusMeters: 50, calendar: calendar)
        let zoomedOut = PhotoStops.stops(for: photos, clusterRadiusMeters: 5_000, calendar: calendar)

        // The stop ids genuinely differ between the two passes…
        XCTAssertNotEqual(zoomedIn.count, zoomedOut.count)
        // …but the photo is found in both, which is why the selection anchors
        // on it rather than on an id.
        XCTAssertNotNil(PhotoStops.stop(containing: 4, in: zoomedIn))
        XCTAssertNotNil(PhotoStops.stop(containing: 4, in: zoomedOut))
    }

    func testAPhotoThatIsNotThereAnchorsNothing() {
        let stops = PhotoStops.stops(for: fourStopsApart(), calendar: calendar)
        XCTAssertNil(PhotoStops.stop(containing: 999, in: stops))
    }
}
