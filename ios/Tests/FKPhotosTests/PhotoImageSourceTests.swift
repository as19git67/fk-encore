import XCTest
@testable import FKPhotosLib

/// Where a photo's pixels come from, and — the part that actually bit — under
/// which cache key.
final class PhotoImageSourceTests: XCTestCase {

    func testWithoutARecipeThePlainFileIsUsed() {
        let request = PhotoImageSource.request(
            photoId: 12, filename: "2024/a.jpg", userId: 3, hasRecipe: false
        )
        XCTAssertEqual(request.path, "/photos/file/2024/a.jpg")
        XCTAssertTrue(request.query.isEmpty)
    }

    /// The key photos are already cached under on people's phones. Changing it
    /// would silently throw away every cached thumbnail on update.
    func testTheOriginalKeepsItsOldCacheKey() {
        let request = PhotoImageSource.request(
            photoId: 12, filename: "2024/a.jpg", userId: 3, hasRecipe: false
        )
        XCTAssertEqual(request.cacheKey, "photo-2024/a.jpg")
    }

    func testWithARecipeTheRenderRouteIsUsed() {
        let request = PhotoImageSource.request(
            photoId: 12, filename: "2024/a.jpg", userId: 3, hasRecipe: true
        )
        XCTAssertEqual(request.path, "/photos/12/render")
        XCTAssertEqual(request.query["v"], "user")
        XCTAssertEqual(request.query["user"], "3")
    }

    /// The bug this whole change exists for: a photo cached before its recipe
    /// existed must not keep winning afterwards. `ImageCache` is disk-backed,
    /// so the same key would survive a relaunch.
    func testGainingARecipeChangesTheCacheKey() {
        let before = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 3, hasRecipe: false
        )
        let after = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 3, hasRecipe: true
        )
        XCTAssertNotEqual(before.cacheKey, after.cacheKey)
    }

    /// Editing an already-edited photo leaves the URL unchanged, and the route
    /// answers `immutable` — so the revision has to travel in the query as
    /// well as in the key, or URLSession serves the old bytes.
    func testEditingAgainChangesBothTheKeyAndTheURL() {
        let first = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 3, hasRecipe: true, revision: 1
        )
        let second = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 3, hasRecipe: true, revision: 2
        )
        XCTAssertNotEqual(first.cacheKey, second.cacheKey)
        XCTAssertNotEqual(first.query["rev"], second.query["rev"])
    }

    /// Recipes are per user, so two people looking at the same photo must not
    /// share one cache entry.
    func testTwoUsersDoNotShareACacheEntry() {
        let mine = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 3, hasRecipe: true
        )
        let yours = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 4, hasRecipe: true
        )
        XCTAssertNotEqual(mine.cacheKey, yours.cacheKey)
    }

    /// A cover row knows a filename and nothing else. Without an id there is
    /// nothing to render, so it stays on the original — as it always was.
    func testAPhotoKnownOnlyByFilenameStaysOriginal() {
        let request = PhotoImageSource.request(
            photoId: nil, filename: "cover.jpg", userId: 3, hasRecipe: true
        )
        XCTAssertEqual(request.path, "/photos/file/cover.jpg")
        XCTAssertEqual(request.cacheKey, "photo-cover.jpg")
    }

    /// Signed out, or before the user is known: no recipe can be rendered.
    func testWithoutAUserThereIsNoRecipeToRender() {
        let request = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: nil, hasRecipe: true
        )
        XCTAssertEqual(request.path, "/photos/file/a.jpg")
    }

    func testAWidthIsCarriedAndKeptOutOfTheUnsizedKey() {
        let sized = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 3, hasRecipe: true, width: 400
        )
        let unsized = PhotoImageSource.request(
            photoId: 12, filename: "a.jpg", userId: 3, hasRecipe: true
        )
        XCTAssertEqual(sized.query["w"], "400")
        XCTAssertNil(unsized.query["w"])
        XCTAssertNotEqual(sized.cacheKey, unsized.cacheKey)
    }
}
