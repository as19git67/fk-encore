import XCTest
@testable import F4milAssistant

/// A proposal card as the server writes it into a `proposal` block
/// (assistant/proposals.ts `ProposalRow`), read on the phone.
final class ProposalTests: XCTestCase {
    private let pendingRow = #"""
    {"kind":"proposal","tool":"create_album","rows":[{"proposal_id":7,"tool":"create_album","summary":"Album „Sommer“ mit 3 Fotos anlegen","count":3,"status":"pending","result_summary":null,"result_route":null,"result_download":null,"error":null,"letter":null,"text_document":null,"collage":null,"continuation":"die Fotos mit „Urlaub“ taggen","display":{"title":"Album „Sommer“ mit 3 Fotos anlegen","subtitle":"Wartet auf Bestätigung"}}],"title":"Vorschlag"}
    """#

    func testAProposalBlockReadsAsCards() throws {
        let block = try JSONDecoder().decode(ResultBlock.self, from: Data(pendingRow.utf8))
        let cards = block.proposals
        XCTAssertEqual(cards.count, 1)
        let card = try XCTUnwrap(cards.first)
        XCTAssertEqual(card.id, 7)
        XCTAssertEqual(card.tool, "create_album")
        XCTAssertEqual(card.count, 3)
        XCTAssertTrue(card.isPending)
        XCTAssertEqual(card.statusLabel, "Wartet auf Bestätigung")
        XCTAssertEqual(card.continuation, "die Fotos mit „Urlaub“ taggen")
        XCTAssertNil(card.letter)
    }

    func testOtherBlocksHaveNoCards() throws {
        let block = try JSONDecoder().decode(ResultBlock.self, from: Data(#"{"kind":"albums","tool":"list_albums","rows":[{"id":1,"name":"A"}]}"#.utf8))
        XCTAssertTrue(block.proposals.isEmpty)
    }

    func testAnExecutedRowNamesItsResult() throws {
        let json = #"{"proposal_id":9,"tool":"transaction_report","summary":"Bericht erstellen","count":null,"status":"executed","result_summary":"Bericht mit 12 Buchungen erstellt","result_route":"/finanzen/berichte/4","result_download":"/finance/reports/4/pdf","error":null,"letter":null,"text_document":null,"collage":null,"continuation":null}"#
        let card = try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
        XCTAssertTrue(card.isExecuted)
        XCTAssertEqual(card.statusLabel, "Ausgeführt")
        XCTAssertEqual(card.result_route, "/finanzen/berichte/4")
        XCTAssertEqual(card.result_download, "/finance/reports/4/pdf")
        XCTAssertNil(card.count)
    }

    func testALetterWithGapsHoldsExecution() throws {
        let json = #"{"proposal_id":3,"tool":"render_letter","summary":"Brief entwerfen","count":null,"status":"pending","result_summary":null,"result_route":null,"result_download":null,"error":null,"letter":{"sender":"Max Beispiel, Beispielstraße 1, 12345 Musterstadt","recipient":"Beispiel GmbH","subject":"Kündigung Vertrag [[Vertragsnummer]]","body":"Hiermit kündige ich zum [[Datum]].\nVertrag [[Vertragsnummer]].","attachments":[],"photos":[],"destinations":["document"],"gaps":["Vertragsnummer","Datum"]},"text_document":null,"collage":null,"continuation":null}"#
        let card = try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
        // Distinct, in order of appearance across subject and body.
        XCTAssertEqual(card.letterGaps, ["Vertragsnummer", "Datum"])
    }

    func testGapsAreReadFromTheTextOnly() {
        XCTAssertEqual(LetterGaps.gaps(in: "ohne Lücke"), [])
        XCTAssertEqual(LetterGaps.gaps(in: "[[ A ]] und [[B]]", "[[A]]"), ["A", "B"])
        // A bracket pair spanning a line break is no gap.
        XCTAssertEqual(LetterGaps.gaps(in: "[[Zeile\nUmbruch]]"), [])
    }

    func testACollageRowCarriesItsPhotosAndResult() throws {
        let json = ##"{"proposal_id":5,"tool":"create_photo_collage","summary":"Collage aus 2 Fotos","count":null,"status":"executed","result_summary":"Collage erstellt","result_route":"/fotos/galerie?photoId=99","result_download":null,"error":null,"letter":null,"text_document":null,"collage":{"photos":[{"id":1,"filename":"a.jpg","auto_crop":null},{"id":2,"filename":"b.jpg","auto_crop":{"x":0.5,"y":0.5}}],"layout":"grid-2","text":"Sommer","text_position":"bottom","text_size":"medium","text_color":"##ffffff","album_name":null,"result":{"photo_id":99,"filename":"c.jpg"}},"continuation":null}"##
        let card = try JSONDecoder().decode(Proposal.self, from: Data(json.utf8))
        let collage = try XCTUnwrap(card.collage)
        XCTAssertEqual(collage.photos.map(\.filename), ["a.jpg", "b.jpg"])
        XCTAssertEqual(collage.photos[0].thumbnail, DisplayThumbnail(kind: "photo", id: 1, filename: "a.jpg"))
        XCTAssertEqual(collage.result?.thumbnail.filename, "c.jpg")
    }

    func testTheContinuationQuestionReadsAsOnTheWeb() {
        XCTAssertEqual(
            ProposalEffects.continuationQuestion(summary: "Album „Sommer“ angelegt. ", continuation: "die Fotos taggen"),
            "Die Karte ist ausgeführt: Album „Sommer“ angelegt. Mach jetzt weiter: die Fotos taggen"
        )
    }
}
