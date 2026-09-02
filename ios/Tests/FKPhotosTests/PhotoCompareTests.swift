import XCTest
@testable import FKPhotosLib

/// The geometry behind comparing two near-duplicate shots: where the photo
/// sits, which face to zoom to, and how to match the two zooms.
final class PhotoCompareTests: XCTestCase {

    private func bbox(
        x: Double = 0.4, y: Double = 0.4, w: Double = 0.2, h: Double = 0.2
    ) -> PhotoCompare.BBox {
        PhotoCompare.BBox(x: x, y: y, width: w, height: h)
    }

    /// A viewport whose aspect matches the photo's, so nothing is letterboxed.
    private func snugViewport() -> PhotoCompare.Viewport {
        PhotoCompare.Viewport(width: 400, height: 300, photoWidth: 4000, photoHeight: 3000)
    }

    // MARK: - Bboxes

    func testANormalBoxIsUsable() {
        XCTAssertTrue(bbox().isUsable)
    }

    func testAnEmptyOrInvertedBoxIsNot() {
        XCTAssertFalse(PhotoCompare.BBox(x: 0.1, y: 0.1, width: 0, height: 0.2).isUsable)
        XCTAssertFalse(PhotoCompare.BBox(x: 0.1, y: 0.1, width: -0.2, height: 0.2).isUsable)
    }

    func testADetectorMayOverhangTheEdgeSlightly() {
        // Real detectors do this; a box just past the edge is still a face.
        XCTAssertTrue(PhotoCompare.BBox(x: -0.05, y: 0.1, width: 0.2, height: 0.2).isUsable)
        XCTAssertFalse(PhotoCompare.BBox(x: -0.5, y: 0.1, width: 0.2, height: 0.2).isUsable)
    }

    func testNonsenseIsNotAUsableBox() {
        XCTAssertFalse(PhotoCompare.BBox(x: .nan, y: 0.1, width: 0.2, height: 0.2).isUsable)
        XCTAssertFalse(PhotoCompare.BBox(x: 0.1, y: 0.1, width: .infinity, height: 0.2).isUsable)
    }

    // MARK: - Contained rect

    func testAMatchingAspectFillsTheViewport() {
        let rect = PhotoCompare.containedRect(in: snugViewport())
        XCTAssertEqual(rect.width, 400, accuracy: 0.001)
        XCTAssertEqual(rect.height, 300, accuracy: 0.001)
        XCTAssertEqual(rect.offsetX, 0, accuracy: 0.001)
        XCTAssertEqual(rect.offsetY, 0, accuracy: 0.001)
    }

    func testAWidePhotoIsLetterboxedTopAndBottom() {
        let viewport = PhotoCompare.Viewport(
            width: 400, height: 400, photoWidth: 4000, photoHeight: 2000
        )
        let rect = PhotoCompare.containedRect(in: viewport)
        XCTAssertEqual(rect.width, 400, accuracy: 0.001)
        XCTAssertEqual(rect.height, 200, accuracy: 0.001)
        XCTAssertEqual(rect.offsetX, 0, accuracy: 0.001)
        XCTAssertEqual(rect.offsetY, 100, accuracy: 0.001, "centred vertically")
    }

    func testATallPhotoIsLetterboxedLeftAndRight() {
        let viewport = PhotoCompare.Viewport(
            width: 400, height: 400, photoWidth: 2000, photoHeight: 4000
        )
        let rect = PhotoCompare.containedRect(in: viewport)
        XCTAssertEqual(rect.width, 200, accuracy: 0.001)
        XCTAssertEqual(rect.height, 400, accuracy: 0.001)
        XCTAssertEqual(rect.offsetX, 100, accuracy: 0.001)
    }

    // MARK: - Zoom

    func testAFaceEndsUpAtTheTargetFraction() throws {
        // A 0.2-wide face in a 400×300 viewport: the target is 0.4 of the
        // smaller axis (300) = 120 pt.
        let result = try XCTUnwrap(
            PhotoCompare.zoom(to: bbox(), in: snugViewport())
        )
        XCTAssertEqual(Double(result.faceScreen.width), 120, accuracy: 0.5)
    }

    func testACentredFaceNeedsNoShift() throws {
        let centred = bbox(x: 0.4, y: 0.4, w: 0.2, h: 0.2)  // centre at (0.5, 0.5)
        let result = try XCTUnwrap(PhotoCompare.zoom(to: centred, in: snugViewport()))
        XCTAssertEqual(Double(result.offset.width), 0, accuracy: 0.001)
        XCTAssertEqual(Double(result.offset.height), 0, accuracy: 0.001)
    }

    func testAFaceInTheCornerIsPulledToTheCentre() throws {
        let viewport = snugViewport()
        let corner = bbox(x: 0.0, y: 0.0, w: 0.2, h: 0.2)  // centre at (0.1, 0.1)
        let result = try XCTUnwrap(PhotoCompare.zoom(to: corner, in: viewport))

        // Where the face centre sits before the transform…
        let rect = PhotoCompare.containedRect(in: viewport)
        let faceX = rect.offsetX + 0.1 * rect.width
        let faceY = rect.offsetY + 0.1 * rect.height
        // …and where it lands after scaling about the centre and shifting.
        let centerX = viewport.width / 2, centerY = viewport.height / 2
        let landedX = centerX + (faceX - centerX) * result.zoom + Double(result.offset.width)
        let landedY = centerY + (faceY - centerY) * result.zoom + Double(result.offset.height)
        XCTAssertEqual(landedX, centerX, accuracy: 0.01)
        XCTAssertEqual(landedY, centerY, accuracy: 0.01)
    }

    func testATinyFaceDoesNotBlowUpPastTheCeiling() throws {
        let tiny = bbox(x: 0.49, y: 0.49, w: 0.005, h: 0.005)
        let result = try XCTUnwrap(
            PhotoCompare.zoom(to: tiny, in: snugViewport(), maxZoom: 6)
        )
        XCTAssertEqual(result.zoom, 6, accuracy: 0.001)
    }

    func testAFaceFillingTheFrameIsNotZoomedOut() throws {
        // Below 1× the photo would shrink, which is not a zoom-to-face.
        let huge = bbox(x: 0, y: 0, w: 1, h: 1)
        let result = try XCTUnwrap(PhotoCompare.zoom(to: huge, in: snugViewport()))
        XCTAssertEqual(result.zoom, 1, accuracy: 0.001)
    }

    func testAnExplicitZoomIsUsedAsGiven() throws {
        let result = try XCTUnwrap(
            PhotoCompare.zoom(to: bbox(), in: snugViewport(), zoom: 2.5)
        )
        XCTAssertEqual(result.zoom, 2.5, accuracy: 0.001)
    }

    func testAnExplicitZoomIsStillClamped() throws {
        let result = try XCTUnwrap(
            PhotoCompare.zoom(to: bbox(), in: snugViewport(), zoom: 99, maxZoom: 6)
        )
        XCTAssertEqual(result.zoom, 6, accuracy: 0.001)
    }

    func testNothingUsableMeansNoZoom() {
        XCTAssertNil(
            PhotoCompare.zoom(
                to: PhotoCompare.BBox(x: 0.1, y: 0.1, width: 0, height: 0.2),
                in: snugViewport()
            )
        )
        XCTAssertNil(
            PhotoCompare.zoom(
                to: bbox(),
                in: PhotoCompare.Viewport(width: 0, height: 300, photoWidth: 4000, photoHeight: 3000)
            )
        )
    }

    // MARK: - Synced zoom

    func testTwoFacesComeOutTheSameSizeOnScreen() throws {
        // The whole point: two differently-sized faces, matched. Both stay
        // above 1x — a face already larger than the target cannot be matched
        // downward, since that would shrink the photo below its own size.
        let a = (bbox: bbox(x: 0.3, y: 0.3, w: 0.2, h: 0.35), viewport: snugViewport())
        let b = (bbox: bbox(x: 0.45, y: 0.45, w: 0.1, h: 0.1), viewport: snugViewport())
        let result = PhotoCompare.syncedZoom(a, b)
        let first = try XCTUnwrap(result.first)
        let second = try XCTUnwrap(result.second)
        XCTAssertEqual(
            Double(first.faceScreen.width),
            Double(second.faceScreen.width),
            accuracy: 0.5
        )
    }

    func testTheSmallerFaceSetsTheCommonSize() throws {
        // Matching upward would push the other face past its viewport.
        let a = (bbox: bbox(x: 0.3, y: 0.3, w: 0.2, h: 0.35), viewport: snugViewport())
        let b = (bbox: bbox(x: 0.45, y: 0.45, w: 0.1, h: 0.1), viewport: snugViewport())

        let independentA = try XCTUnwrap(PhotoCompare.zoom(to: a.bbox, in: a.viewport))
        let independentB = try XCTUnwrap(PhotoCompare.zoom(to: b.bbox, in: b.viewport))
        let smaller = min(independentA.faceScreen.width, independentB.faceScreen.width)

        let synced = try XCTUnwrap(PhotoCompare.syncedZoom(a, b).first)
        XCTAssertEqual(Double(synced.faceScreen.width), Double(smaller), accuracy: 0.5)
    }

    func testMatchingAcrossDifferentViewportsStillWorks() throws {
        // Portrait phone: the two photos get differently shaped halves.
        let a = (
            bbox: bbox(x: 0.4, y: 0.4, w: 0.2, h: 0.2),
            viewport: PhotoCompare.Viewport(width: 390, height: 300, photoWidth: 4000, photoHeight: 3000)
        )
        let b = (
            bbox: bbox(x: 0.4, y: 0.4, w: 0.2, h: 0.2),
            viewport: PhotoCompare.Viewport(width: 390, height: 420, photoWidth: 3000, photoHeight: 4000)
        )
        let result = PhotoCompare.syncedZoom(a, b)
        let first = try XCTUnwrap(result.first)
        let second = try XCTUnwrap(result.second)
        XCTAssertEqual(
            Double(first.faceScreen.width),
            Double(second.faceScreen.width),
            accuracy: 0.5
        )
    }

    func testOneUnusableSideLeavesTheOtherAlone() {
        let a = (bbox: bbox(), viewport: snugViewport())
        let b = (
            bbox: PhotoCompare.BBox(x: 0, y: 0, width: 0, height: 0),
            viewport: snugViewport()
        )
        let result = PhotoCompare.syncedZoom(a, b)
        XCTAssertNotNil(result.first)
        XCTAssertNil(result.second)
    }

    // MARK: - Picking a face

    func testANamedFaceBeatsAnUnnamedOne() throws {
        let faces = [
            PhotoCompare.Candidate(bbox: bbox(w: 0.5, h: 0.5), quality: 0.9),
            PhotoCompare.Candidate(bbox: bbox(w: 0.1, h: 0.1), personId: 7, quality: 0.1),
        ]
        let picked = try XCTUnwrap(PhotoCompare.primaryFace(in: faces))
        XCTAssertEqual(picked.personId, 7, "a tagged person is who the photo is of")
    }

    func testAmongUnnamedFacesQualityDecides() throws {
        let faces = [
            PhotoCompare.Candidate(bbox: bbox(w: 0.2, h: 0.2), quality: 0.2),
            PhotoCompare.Candidate(bbox: bbox(w: 0.2, h: 0.2), quality: 0.8),
        ]
        let picked = try XCTUnwrap(PhotoCompare.primaryFace(in: faces))
        XCTAssertEqual(picked.quality, 0.8)
    }

    func testIgnoredFacesAreNeverPicked() {
        let faces = [
            PhotoCompare.Candidate(bbox: bbox(w: 0.5, h: 0.5), personId: 7, ignored: true)
        ]
        XCTAssertNil(PhotoCompare.primaryFace(in: faces))
    }

    func testNoFacesMeansNoPick() {
        XCTAssertNil(PhotoCompare.primaryFace(in: []))
    }

    func testThePersonsLargestFaceIsTheOneToLineUp() throws {
        let faces = [
            PhotoCompare.Candidate(bbox: bbox(x: 0.1, y: 0.1, w: 0.1, h: 0.1), personId: 7),
            PhotoCompare.Candidate(bbox: bbox(x: 0.5, y: 0.5, w: 0.3, h: 0.3), personId: 7),
            PhotoCompare.Candidate(bbox: bbox(w: 0.9, h: 0.9), personId: 8),
        ]
        let picked = try XCTUnwrap(PhotoCompare.face(forPerson: 7, in: faces))
        XCTAssertEqual(picked.bbox.width, 0.3, accuracy: 0.001)
    }

    func testAPersonWhoIsNotInThisShotHasNoFace() {
        let faces = [PhotoCompare.Candidate(bbox: bbox(), personId: 7)]
        XCTAssertNil(PhotoCompare.face(forPerson: 99, in: faces))
    }

    // MARK: - Tapping a face

    func testATapInsideAFacePicksIt() throws {
        let faces = [
            PhotoCompare.Candidate(bbox: bbox(x: 0.0, y: 0.0, w: 0.2, h: 0.2), personId: 1),
            PhotoCompare.Candidate(bbox: bbox(x: 0.7, y: 0.7, w: 0.2, h: 0.2), personId: 2),
        ]
        let picked = try XCTUnwrap(
            PhotoCompare.face(at: CGPoint(x: 0.75, y: 0.75), in: faces)
        )
        XCTAssertEqual(picked.personId, 2)
    }

    func testOverlappingFacesResolveToTheTightest() throws {
        // A group shot behind one face: the small box is the one meant.
        let faces = [
            PhotoCompare.Candidate(bbox: bbox(x: 0.0, y: 0.0, w: 1.0, h: 1.0), personId: 1),
            PhotoCompare.Candidate(bbox: bbox(x: 0.4, y: 0.4, w: 0.1, h: 0.1), personId: 2),
        ]
        let picked = try XCTUnwrap(
            PhotoCompare.face(at: CGPoint(x: 0.45, y: 0.45), in: faces)
        )
        XCTAssertEqual(picked.personId, 2)
    }

    func testATapNearAFaceStillPicksIt() throws {
        let faces = [PhotoCompare.Candidate(bbox: bbox(x: 0.4, y: 0.4, w: 0.1, h: 0.1), personId: 3)]
        // Just outside the box but well within the near radius.
        let picked = try XCTUnwrap(
            PhotoCompare.face(at: CGPoint(x: 0.52, y: 0.45), in: faces)
        )
        XCTAssertEqual(picked.personId, 3)
    }

    func testATapOnEmptyBackgroundFallsBackToThePrimaryFace() throws {
        let faces = [PhotoCompare.Candidate(bbox: bbox(x: 0.0, y: 0.0, w: 0.1, h: 0.1), personId: 5)]
        // Far corner, well past the near radius — but doing nothing would be
        // worse than zooming to the obvious subject.
        let picked = try XCTUnwrap(
            PhotoCompare.face(at: CGPoint(x: 0.95, y: 0.95), in: faces)
        )
        XCTAssertEqual(picked.personId, 5)
    }

    func testATapOutsideTheImageFallsBackToo() throws {
        let faces = [PhotoCompare.Candidate(bbox: bbox(), personId: 5)]
        let picked = try XCTUnwrap(
            PhotoCompare.face(at: CGPoint(x: 5, y: -2), in: faces)
        )
        XCTAssertEqual(picked.personId, 5)
    }

    // MARK: - Tap coordinates

    func testATapMapsToImageCoordinates() throws {
        let point = try XCTUnwrap(
            PhotoCompare.imageCoordinates(of: CGPoint(x: 200, y: 150), in: snugViewport())
        )
        XCTAssertEqual(Double(point.x), 0.5, accuracy: 0.001)
        XCTAssertEqual(Double(point.y), 0.5, accuracy: 0.001)
    }

    func testALetterboxStripeIsNotPartOfThePhoto() {
        // A 400×400 viewport showing a 2:1 photo letterboxes 100 pt top and
        // bottom; a tap up there points at nothing.
        let viewport = PhotoCompare.Viewport(
            width: 400, height: 400, photoWidth: 4000, photoHeight: 2000
        )
        XCTAssertNil(PhotoCompare.imageCoordinates(of: CGPoint(x: 200, y: 20), in: viewport))
        XCTAssertNotNil(PhotoCompare.imageCoordinates(of: CGPoint(x: 200, y: 200), in: viewport))
    }

    func testTheLetterboxOffsetIsAccountedFor() throws {
        let viewport = PhotoCompare.Viewport(
            width: 400, height: 400, photoWidth: 4000, photoHeight: 2000
        )
        // The photo occupies y 100…300, so y=100 is its top edge.
        let point = try XCTUnwrap(
            PhotoCompare.imageCoordinates(of: CGPoint(x: 0, y: 100), in: viewport)
        )
        XCTAssertEqual(Double(point.y), 0, accuracy: 0.001)
    }

    // MARK: - Matching the two panes

    func testTheSamePersonInBothPhotosLinesUpOnThatPerson() {
        let left = [
            PhotoCompare.Candidate(bbox: bbox(x: 0.1, y: 0.1, w: 0.1, h: 0.1), personId: 7),
            PhotoCompare.Candidate(bbox: bbox(x: 0.5, y: 0.5, w: 0.3, h: 0.3), personId: 9)
        ]
        let right = [
            PhotoCompare.Candidate(bbox: bbox(x: 0.6, y: 0.2, w: 0.1, h: 0.1), personId: 7)
        ]
        let matched = PhotoCompare.matchedBoxes(personId: 7, first: left, second: right)
        XCTAssertEqual(matched?.first.x, 0.1)
        XCTAssertEqual(matched?.second.x, 0.6)
    }

    /// The reported bug: the person is only in one of the two photos, so the
    /// pair used to resolve to nothing and neither pane zoomed — while the
    /// toolbar still offered „Ganzes Bild". Each side falls back to its own
    /// subject instead.
    func testAPersonMissingFromTheOtherPhotoFallsBackToEachPrimaryFace() {
        let left = [PhotoCompare.Candidate(bbox: bbox(x: 0.1, y: 0.1, w: 0.2, h: 0.2), personId: 7)]
        let right = [PhotoCompare.Candidate(bbox: bbox(x: 0.6, y: 0.6, w: 0.3, h: 0.3))]
        let matched = PhotoCompare.matchedBoxes(personId: 7, first: left, second: right)
        XCTAssertEqual(matched?.first.x, 0.1)
        XCTAssertEqual(matched?.second.x, 0.6)
    }

    func testAnUnnamedTapUsesEachPhotosPrimaryFace() {
        let left = [
            PhotoCompare.Candidate(bbox: bbox(x: 0.1, y: 0.1, w: 0.1, h: 0.1), quality: 0.2),
            PhotoCompare.Candidate(bbox: bbox(x: 0.4, y: 0.4, w: 0.3, h: 0.3), quality: 0.9)
        ]
        let right = [PhotoCompare.Candidate(bbox: bbox(x: 0.7, y: 0.7, w: 0.2, h: 0.2))]
        let matched = PhotoCompare.matchedBoxes(personId: nil, first: left, second: right)
        XCTAssertEqual(matched?.first.x, 0.4)
        XCTAssertEqual(matched?.second.x, 0.7)
    }

    /// A photo with no usable face at all still has nothing to zoom to, and
    /// that has to stay a nil — the caller shows the plain fit.
    func testNoUsableFaceOnOneSideMatchesNothing() {
        let left = [PhotoCompare.Candidate(bbox: bbox(), personId: 7)]
        let right: [PhotoCompare.Candidate] = []
        XCTAssertNil(PhotoCompare.matchedBoxes(personId: 7, first: left, second: right))
        XCTAssertNil(PhotoCompare.matchedBoxes(personId: nil, first: left, second: right))
    }
}
