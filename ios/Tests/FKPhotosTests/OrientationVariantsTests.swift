import XCTest
@testable import FKPhotosLib

/// Portrait and landscape of the same motif: which side a photo is on, which
/// side the lists ask for, when the viewer switches, and how the slideshow
/// takes the fitting side before pairing.
final class OrientationVariantsTests: XCTestCase {

    private func photo(_ id: Int, _ orientation: PhotoOrientation?) -> PhotoWithCuration {
        PhotoWithCuration(
            id: id,
            user_id: 1,
            filename: "p-\(id).jpg",
            original_name: "p-\(id).jpg",
            mime_type: "image/jpeg",
            size: 100,
            hash: nil,
            taken_at: nil,
            created_at: "2026-01-15T08:00:00.000Z",
            latitude: nil,
            longitude: nil,
            location_name: nil,
            location_city: nil,
            location_country: nil,
            ai_quality_score: nil,
            ai_quality_details: nil,
            auto_crop: nil,
            curation_status: .visible,
            description: nil,
            keywords: nil,
            orientation: orientation
        )
    }

    private let pair = OrientationVariants(portrait: 2, landscape: 1, portrait_ids: [11, 12], landscape_ids: [21])

    // MARK: - Sides

    func testSideAndCounterparts() {
        XCTAssertEqual(pair.side(of: 12), .portrait)
        XCTAssertEqual(pair.side(of: 21), .landscape)
        XCTAssertNil(pair.side(of: 99))
        XCTAssertEqual(pair.counterpartIds(of: 12), [21])
        XCTAssertEqual(pair.counterpartIds(of: 21), [11, 12])
        XCTAssertEqual(pair.counterpartIds(of: 99), [])
    }

    func testIndexByPhotoIdOnlyHoldsFormatGroups() {
        let withPair = AlbumGroupReview.Group(
            id: 1, cover_photo_id: 21, member_count: 3, photo_ids: [21, 11, 12],
            reviewed_at: nil, ai_picked_photo_ids: nil, ai_picked_confidence: nil,
            orientation_variants: nil, variants: pair
        )
        let plain = AlbumGroupReview.Group(
            id: 2, cover_photo_id: 31, member_count: 2, photo_ids: [31, 32],
            reviewed_at: nil, ai_picked_photo_ids: nil, ai_picked_confidence: nil
        )
        let index = OrientationVariantRules.byPhotoId(groups: [withPair, plain])
        XCTAssertEqual(Set(index.keys), [11, 12, 21])
        XCTAssertEqual(index[11], pair)
    }

    func testDecodesGroupWithAndWithoutVariants() throws {
        let json = """
        {"groups":[
          {"id":1,"cover_photo_id":21,"member_count":3,"photo_ids":[21,11,12],"reviewed_at":null,
           "orientation_variants":"auto",
           "variants":{"portrait":2,"landscape":1,"portrait_ids":[11,12],"landscape_ids":[21]}},
          {"id":2,"cover_photo_id":31,"member_count":2,"photo_ids":[31,32],"reviewed_at":null}
        ]}
        """
        let response = try JSONDecoder().decode(AlbumGroupReview.ListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.groups[0].variants, pair)
        XCTAssertEqual(response.groups[0].orientation_variants, "auto")
        XCTAssertNil(response.groups[1].variants)
    }

    func testPhotoDecodesOrientationAndTolerateItsAbsence() throws {
        let with = """
        {"id":1,"user_id":1,"filename":"a.jpg","original_name":"a.jpg","mime_type":"image/jpeg","size":1,
         "created_at":"2026-01-01T00:00:00.000Z","curation_status":"visible","orientation":"portrait"}
        """
        XCTAssertEqual(try JSONDecoder().decode(PhotoWithCuration.self, from: Data(with.utf8)).orientation, .portrait)
        let without = """
        {"id":1,"user_id":1,"filename":"a.jpg","original_name":"a.jpg","mime_type":"image/jpeg","size":1,
         "created_at":"2026-01-01T00:00:00.000Z","curation_status":"visible"}
        """
        XCTAssertNil(try JSONDecoder().decode(PhotoWithCuration.self, from: Data(without.utf8)).orientation)
    }

    // MARK: - Which side a list asks for

    func testVariantModeFollowsTheScreenUnlessEverythingIsWanted() {
        XCTAssertEqual(VariantMode.forScreen(.portrait, showVariants: false, selecting: false), .portrait)
        XCTAssertEqual(VariantMode.forScreen(.landscape, showVariants: false, selecting: false), .landscape)
        XCTAssertEqual(VariantMode.forScreen(.portrait, showVariants: true, selecting: false), .all)
        XCTAssertEqual(VariantMode.forScreen(.portrait, showVariants: false, selecting: true), .all)
    }

    // MARK: - Viewer

    func testSwitchesSideOnRotationOnlyWhenItHelpsAndNothingIsPinned() {
        XCTAssertTrue(OrientationVariantRules.shouldSwitchSide(
            shown: .landscape, counterpart: .portrait, screen: .portrait, pinned: false))
        XCTAssertFalse(OrientationVariantRules.shouldSwitchSide(
            shown: .landscape, counterpart: .portrait, screen: .portrait, pinned: true))
        XCTAssertFalse(OrientationVariantRules.shouldSwitchSide(
            shown: .landscape, counterpart: .portrait, screen: .landscape, pinned: false))
        XCTAssertFalse(OrientationVariantRules.shouldSwitchSide(
            shown: .landscape, counterpart: nil, screen: .portrait, pinned: false))
        XCTAssertFalse(OrientationVariantRules.shouldSwitchSide(
            shown: .landscape, counterpart: .square, screen: .portrait, pinned: false))
    }

    func testLabels() {
        XCTAssertEqual(OrientationVariantRules.label(for: .portrait), "Hochformat")
        XCTAssertEqual(OrientationVariantRules.label(for: .landscape), "Querformat")
        XCTAssertEqual(OrientationVariantRules.label(for: nil), "Andere Seite")
    }

    // MARK: - Slideshow

    private var variants: [Int: OrientationVariants] {
        [11: pair, 12: pair, 21: pair]
    }

    func testSlideshowCollectsEachCounterpartOnce() {
        let ids = SlideshowVariants.counterpartIds(
            photos: [photo(21, .landscape), photo(40, nil), photo(11, .portrait)],
            variants: variants
        )
        XCTAssertEqual(ids, [11, 12, 21])
    }

    func testSlideshowDropsTheOtherSideOfAnEarlierPhoto() {
        let kept = SlideshowVariants.dropCounterparts(
            photos: [photo(21, .landscape), photo(11, .portrait), photo(40, nil), photo(12, .portrait)],
            variants: variants
        )
        XCTAssertEqual(kept.map(\.id), [21, 40])
    }

    func testSlideshowSubstitutesTheFittingSideInPlace() {
        let sequence = [photo(21, .landscape), photo(40, nil), photo(50, .landscape)]
        let fetched = [11: photo(11, .portrait), 12: photo(12, .portrait)]

        let portraitScreen = SlideshowVariants.substitute(
            photos: sequence, counterparts: fetched, variants: variants, screen: .portrait
        )
        // The landscape frame gives way to the best-ranked portrait frame; the
        // unmeasured photo and the one without a counterpart stay put.
        XCTAssertEqual(portraitScreen.map(\.id), [11, 40, 50])

        let landscapeScreen = SlideshowVariants.substitute(
            photos: sequence, counterparts: fetched, variants: variants, screen: .landscape
        )
        XCTAssertEqual(landscapeScreen.map(\.id), [21, 40, 50])
    }

    func testSlideshowKeepsThePhotoWhenNoFetchedCounterpartFits() {
        let out = SlideshowVariants.substitute(
            photos: [photo(21, .landscape)], counterparts: [:], variants: variants, screen: .portrait
        )
        XCTAssertEqual(out.map(\.id), [21])
    }
}
