import XCTest
@testable import F4milAssistant

/// The chart rides on the block as the server derived it (assistant/charts.ts).
final class BlockChartTests: XCTestCase {
    func testABlockCarriesItsChartWithGapsInALine() throws {
        let json = #"{"kind":"performance","tool":"portfolio_performance","rows":[],"chart":{"type":"line","labels":["02.01.2026","03.01.2026"],"series":[{"name":"Depotwert","values":[100.5,null]}],"format":"money","unit":"EUR"}}"#
        let block = try JSONDecoder().decode(ResultBlock.self, from: Data(json.utf8))
        XCTAssertEqual(block.chart?.type, "line")
        XCTAssertEqual(block.chart?.labels.count, 2)
        XCTAssertEqual(block.chart?.series.first?.values, [100.5, nil])
        XCTAssertNil(block.chart?.caption)
    }

    func testABlockWithoutAChartStillDecodes() throws {
        let block = try JSONDecoder().decode(ResultBlock.self, from: Data(#"{"kind":"documents","tool":"search_documents","rows":[]}"#.utf8))
        XCTAssertNil(block.chart)
    }

    func testValuesReadAsMoneyOrWithTheirUnit() {
        let kwh = BlockChart(type: "bar", labels: [], series: [], format: "number", unit: "kWh")
        XCTAssertEqual(kwh.formatted(1234.5), "1.234,5 kWh")
        let eur = BlockChart(type: "pie", labels: [], series: [], format: "money", unit: "EUR")
        XCTAssertTrue(eur.formatted(12.5).contains("12,50"))
    }
}
