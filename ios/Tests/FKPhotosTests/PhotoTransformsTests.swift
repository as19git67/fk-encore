import XCTest
@testable import FKPhotosLib

/// The client half of non-destructive photo edits: what the render endpoint is
/// asked for, what a bundle offers, and how a recipe reads.
final class PhotoTransformsTests: XCTestCase {

    // MARK: - Aspect ratios

    func testARatioKnowsItsShape() {
        XCTAssertEqual(PhotoTransforms.AspectRatio.square.value, 1, accuracy: 0.001)
        XCTAssertEqual(PhotoTransforms.AspectRatio.sixteenNine.value, 16.0 / 9, accuracy: 0.001)
        XCTAssertEqual(PhotoTransforms.AspectRatio.fourFive.value, 0.8, accuracy: 0.001)
    }

    func testPortraitAndLandscapeAreToldApart() {
        XCTAssertTrue(PhotoTransforms.AspectRatio.nineSixteen.isPortrait)
        XCTAssertFalse(PhotoTransforms.AspectRatio.sixteenNine.isPortrait)
        XCTAssertTrue(PhotoTransforms.AspectRatio.square.isSquare)
    }

    func testTheRatiosMatchTheServersSet() {
        // The server rejects anything else, so this list is a contract.
        XCTAssertEqual(
            PhotoTransforms.AspectRatio.allCases.map(\.rawValue),
            ["1:1", "4:5", "5:4", "3:4", "4:3", "16:9", "9:16"]
        )
    }

    // MARK: - Render query

    func testTheOriginalNeedsNothingElse() {
        XCTAssertEqual(PhotoTransforms.renderQuery(.original), ["v": "original"])
    }

    func testASuggestionCarriesItsRatio() {
        XCTAssertEqual(
            PhotoTransforms.renderQuery(.suggested(.fourFive)),
            ["v": "suggested", "ratio": "4:5"]
        )
    }

    func testAUserVariantCarriesTheUserId() {
        XCTAssertEqual(
            PhotoTransforms.renderQuery(.user(id: 7)),
            ["v": "user", "user": "7"]
        )
    }

    func testAWidthIsPassedThroughWhenAskedFor() {
        let query = PhotoTransforms.renderQuery(.original, width: 1200)
        XCTAssertEqual(query["w"], "1200")
    }

    func testNoWidthMeansFullResolution() {
        XCTAssertNil(PhotoTransforms.renderQuery(.original)["w"])
    }

    func testTheRenderPathIsPerPhoto() {
        XCTAssertEqual(PhotoTransforms.renderPath(photoId: 42), "/photos/42/render")
    }

    // MARK: - Fixtures

    private func crop() -> PhotoTransforms.Crop {
        PhotoTransforms.Crop(x: 0.1, y: 0.1, w: 0.8, h: 0.8)
    }

    private func suggestion(ratios: [String]) -> PhotoTransforms.Suggestion {
        var crops: [String: PhotoTransforms.Crop] = [:]
        for ratio in ratios { crops[ratio] = crop() }
        return PhotoTransforms.Suggestion(
            crops: crops,
            exposure: 0.4,
            contrast: 0.1,
            gamma: 1,
            white_point: nil,
            black_point: nil
        )
    }

    private func row(
        id: Int = 1,
        crop: PhotoTransforms.Crop? = nil,
        rotation: Int = 0,
        exposure: Double = 0,
        contrast: Double = 0,
        gamma: Double = 1
    ) -> PhotoTransforms.Row {
        PhotoTransforms.Row(
            id: id,
            photo_id: 5,
            user_id: 3,
            source: .user,
            adopted_from: nil,
            crop: crop,
            rotation: rotation,
            exposure: exposure,
            contrast: contrast,
            gamma: gamma,
            white_point: nil,
            black_point: nil
        )
    }

    private func other(id: Int, name: String) -> PhotoTransforms.Other {
        PhotoTransforms.Other(
            id: id,
            photo_id: 5,
            user_id: id,
            source: .user,
            adopted_from: nil,
            crop: crop(),
            rotation: 0,
            exposure: 0,
            contrast: 0,
            gamma: 1,
            white_point: nil,
            black_point: nil,
            user: .init(id: id, name: name)
        )
    }

    // MARK: - Reading a bundle

    func testOnlyTheRatiosTheAiComposedAreOffered() {
        let bundle = PhotoTransforms.Bundle(
            mine: nil,
            others: [],
            suggestion: suggestion(ratios: ["16:9", "1:1"]),
            model_version: "v1"
        )
        // Listed in the fixed order, not in the order they arrived.
        XCTAssertEqual(
            PhotoTransforms.suggestedRatios(in: bundle).map(\.rawValue),
            ["1:1", "16:9"]
        )
    }

    func testAPhotoWithNoFaceOffersNoRatios() {
        // The server produces no crops without a subject to compose around.
        let bundle = PhotoTransforms.Bundle(
            mine: nil,
            others: [],
            suggestion: suggestion(ratios: []),
            model_version: "v1"
        )
        XCTAssertTrue(PhotoTransforms.suggestedRatios(in: bundle).isEmpty)
    }

    func testNothingLoadedYetOffersNothing() {
        XCTAssertTrue(PhotoTransforms.suggestedRatios(in: nil).isEmpty)
        XCTAssertTrue(PhotoTransforms.adoptable(in: nil).isEmpty)
        XCTAssertFalse(PhotoTransforms.hasOwnRecipe(nil))
    }

    func testAnUnknownRatioFromTheServerIsIgnored() {
        // A future server ratio must not crash the picker.
        let bundle = PhotoTransforms.Bundle(
            mine: nil,
            others: [],
            suggestion: suggestion(ratios: ["21:9", "1:1"]),
            model_version: "v1"
        )
        XCTAssertEqual(PhotoTransforms.suggestedRatios(in: bundle).map(\.rawValue), ["1:1"])
    }

    func testOtherPeoplesVersionsAreListedByName() {
        let bundle = PhotoTransforms.Bundle(
            mine: nil,
            others: [other(id: 2, name: "Zoe"), other(id: 3, name: "anna")],
            suggestion: nil,
            model_version: nil
        )
        XCTAssertEqual(
            PhotoTransforms.adoptable(in: bundle).map(\.user.name),
            ["anna", "Zoe"],
            "sorted case-insensitively, so the list does not reshuffle"
        )
    }

    func testAnOwnRecipeIsRecognised() {
        let bundle = PhotoTransforms.Bundle(
            mine: row(crop: crop()),
            others: [],
            suggestion: nil,
            model_version: nil
        )
        XCTAssertTrue(PhotoTransforms.hasOwnRecipe(bundle))
    }

    // MARK: - What to display

    func testAPhotoWithoutAnOwnRecipeShowsTheOriginal() {
        let bundle = PhotoTransforms.Bundle(
            mine: nil,
            others: [other(id: 2, name: "Zoe")],
            suggestion: suggestion(ratios: ["1:1"]),
            model_version: "v1"
        )
        // Neither a suggestion nor someone else's version stands in for the
        // photo — both are proposals.
        XCTAssertEqual(PhotoTransforms.displayVariant(for: bundle, userId: 3), .original)
    }

    func testAnOwnRecipeIsWhatGetsShown() {
        let bundle = PhotoTransforms.Bundle(
            mine: row(crop: crop()),
            others: [],
            suggestion: nil,
            model_version: nil
        )
        XCTAssertEqual(PhotoTransforms.displayVariant(for: bundle, userId: 3), .user(id: 3))
    }

    func testWithoutASignedInUserThereIsNoRecipeToRender() {
        let bundle = PhotoTransforms.Bundle(
            mine: row(crop: crop()),
            others: [],
            suggestion: nil,
            model_version: nil
        )
        XCTAssertEqual(PhotoTransforms.displayVariant(for: bundle, userId: nil), .original)
    }

    // MARK: - Summary

    func testAnUntouchedRecipeSaysSo() {
        XCTAssertEqual(PhotoTransforms.summary(of: row()), "Unverändert")
    }

    func testACropOnlyRecipeMentionsOnlyTheCrop() {
        XCTAssertEqual(PhotoTransforms.summary(of: row(crop: crop())), "Zugeschnitten")
    }

    func testNeutralValuesAreLeftOut() {
        // 0 EV and 0 % contrast say nothing, so they are not written.
        let summary = PhotoTransforms.summary(of: row(crop: crop(), exposure: 0, contrast: 0))
        XCTAssertFalse(summary.contains("EV"))
        XCTAssertFalse(summary.contains("Kontrast"))
    }

    func testExposureIsWrittenWithItsSign() {
        let up = PhotoTransforms.summary(of: row(exposure: 0.5))
        XCTAssertTrue(up.contains("+0,5 EV"), "got \(up)")
        let down = PhotoTransforms.summary(of: row(exposure: -1.5))
        XCTAssertTrue(down.contains("-1,5 EV"), "got \(down)")
    }

    func testContrastIsWrittenAsAPercentage() {
        let summary = PhotoTransforms.summary(of: row(contrast: 0.2))
        XCTAssertTrue(summary.contains("Kontrast +20 %"), "got \(summary)")
    }

    func testGammaIsNeutralAtOneNotZero() {
        XCTAssertFalse(PhotoTransforms.summary(of: row(gamma: 1)).contains("Gamma"))
        XCTAssertTrue(PhotoTransforms.summary(of: row(gamma: 1.2)).contains("Gamma"))
    }

    func testARotationIsNamedInDegrees() {
        XCTAssertTrue(PhotoTransforms.summary(of: row(rotation: 90)).contains("90°"))
    }

    func testEveryPartOfARecipeMakesTheLine() {
        let summary = PhotoTransforms.summary(
            of: row(crop: crop(), rotation: 90, exposure: 0.5, contrast: 0.2, gamma: 1.2)
        )
        for part in ["Zugeschnitten", "90°", "EV", "Kontrast", "Gamma"] {
            XCTAssertTrue(summary.contains(part), "\(part) missing from \(summary)")
        }
    }

    // MARK: - Wire format

    func testABundleDecodes() throws {
        let json = """
        {
          "mine": {
            "id": 9, "photo_id": 5, "user_id": 3, "source": "user",
            "adopted_from": null,
            "crop": {"x": 0.1, "y": 0.05, "w": 0.8, "h": 0.9},
            "rotation": 90, "exposure": 0.5, "contrast": 0.2, "gamma": 1.1,
            "white_point": null, "black_point": 0.02,
            "applied_at": null,
            "created_at": "2024-01-01T00:00:00.000Z",
            "updated_at": "2024-01-02T00:00:00.000Z"
          },
          "others": [{
            "id": 10, "photo_id": 5, "user_id": 4, "source": "adopted",
            "adopted_from": 9, "crop": null,
            "rotation": 0, "exposure": 0, "contrast": 0, "gamma": 1,
            "white_point": null, "black_point": null,
            "applied_at": null,
            "created_at": "2024-01-01T00:00:00.000Z",
            "updated_at": "2024-01-01T00:00:00.000Z",
            "user": {"id": 4, "name": "Testperson"}
          }],
          "suggestion": {
            "crops": {"1:1": {"x": 0, "y": 0.1, "w": 1, "h": 0.8}},
            "exposure": -0.3, "contrast": 0.15, "gamma": 1
          },
          "model_version": "v3"
        }
        """.data(using: .utf8)!

        let bundle = try JSONDecoder().decode(PhotoTransforms.Bundle.self, from: json)
        XCTAssertEqual(bundle.mine?.rotation, 90)
        XCTAssertEqual(bundle.mine?.crop?.w, 0.8)
        XCTAssertEqual(bundle.mine?.black_point, 0.02)
        XCTAssertEqual(bundle.others.first?.user.name, "Testperson")
        XCTAssertEqual(bundle.others.first?.source, .adopted)
        XCTAssertNil(bundle.others.first?.crop)
        XCTAssertEqual(bundle.suggestion?.crops["1:1"]?.h, 0.8)
        XCTAssertNil(bundle.suggestion?.white_point)
        XCTAssertEqual(bundle.model_version, "v3")
    }

    func testAnUneditedPhotoDecodes() throws {
        let json = """
        {"mine": null, "others": [], "suggestion": null, "model_version": null}
        """.data(using: .utf8)!
        let bundle = try JSONDecoder().decode(PhotoTransforms.Bundle.self, from: json)
        XCTAssertNil(bundle.mine)
        XCTAssertTrue(bundle.others.isEmpty)
        XCTAssertFalse(PhotoTransforms.hasOwnRecipe(bundle))
    }

    func testTheRequestsCarryWhatTheServerExpects() throws {
        let fromSuggestion = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(PhotoTransforms.FromSuggestionRequest(ratio: "4:5"))
        ) as? [String: Any]
        XCTAssertEqual(fromSuggestion?["ratio"] as? String, "4:5")

        let adopt = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(PhotoTransforms.AdoptRequest(from_transform_id: 9))
        ) as? [String: Any]
        XCTAssertEqual(adopt?["from_transform_id"] as? Int, 9)
    }

    func testTheDeleteResultDecodes() throws {
        let json = #"{"deleted": true}"#.data(using: .utf8)!
        let result = try JSONDecoder().decode(PhotoTransforms.DeleteResult.self, from: json)
        XCTAssertTrue(result.deleted)
    }
}
