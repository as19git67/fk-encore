import Charts
import SwiftUI

/// A chart beside an answer (documentation/plans/assistent-diagramme.md):
/// draws the block's `chart` as the server derived it from the tool's rows.
/// The rows under it stay the table view of the same numbers.
struct ChartView: View {
    let chart: BlockChart
    @Environment(\.colorScheme) private var colorScheme

    /// The eight categorical slots of the data-viz reference palette, in
    /// fixed order, a light and a dark step each — the same as the web app.
    /// A pie has at most eight slices (`MAX_SLICES` on the server).
    private static let light: [UInt32] = [0x2a78d6, 0xeb6834, 0x1baf7a, 0xeda100, 0xe87ba4, 0x008300, 0x6250d6, 0xe34948]
    private static let dark: [UInt32] = [0x3987e5, 0xd95926, 0x199e70, 0xc98500, 0xd55181, 0x0ca30c, 0x9085e9, 0xe66767]

    private func color(_ index: Int) -> Color {
        let slots = colorScheme == .dark ? Self.dark : Self.light
        return Color(hex: slots[index % slots.count])
    }

    /// „Übrige“ is not an entity of its own: grey, not a ninth hue.
    private var restColor: Color { .gray }

    private struct Point: Identifiable {
        let id: String
        let series: String
        let seriesIndex: Int
        let index: Int
        let label: String
        let value: Double
    }

    private var points: [Point] {
        chart.series.enumerated().flatMap { s, series in
            series.values.enumerated().compactMap { i, value in
                guard let value, i < chart.labels.count else { return nil }
                return Point(id: "\(s)-\(i)", series: series.name, seriesIndex: s, index: i, label: chart.labels[i], value: value)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            content
                .frame(height: chart.type == "pie" ? 180 : 170)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Diagramm"))
                .accessibilityValue(Text(spokenSummary))
            if let caption = chart.caption {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var content: some View {
        switch chart.type {
        case "pie": pie
        case "bar": bars
        default: lines
        }
    }

    private var pie: some View {
        Chart(points) { p in
            SectorMark(angle: .value("Wert", p.value), angularInset: 1)
                .foregroundStyle(by: .value("Anteil", p.label))
        }
        .chartForegroundStyleScale(domain: chart.labels, range: chart.labels.enumerated().map { i, label in
            label == "Übrige" ? restColor : color(i)
        })
        .chartLegend(position: .trailing, alignment: .center)
    }

    private var bars: some View {
        Chart(points) { p in
            BarMark(x: .value("Zeitraum", p.label), y: .value("Wert", p.value))
                .foregroundStyle(color(p.seriesIndex))
                .cornerRadius(4)
        }
        .chartXScale(domain: chart.labels)
        .chartYAxis { valueAxis }
    }

    private var lines: some View {
        Chart(points) { p in
            LineMark(x: .value("Datum", p.index), y: .value("Wert", p.value), series: .value("Reihe", p.series))
                .foregroundStyle(by: .value("Reihe", p.series))
                .lineStyle(StrokeStyle(lineWidth: 2, dash: p.seriesIndex > 0 ? [6, 4] : []))
                .interpolationMethod(.monotone)
        }
        .chartForegroundStyleScale(domain: chart.series.map(\.name), range: chart.series.indices.map { color($0) })
        .chartLegend(chart.series.count > 1 ? .visible : .hidden)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let i = value.as(Int.self), chart.labels.indices.contains(i) {
                        Text(chart.labels[i])
                    }
                }
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis { valueAxis }
    }

    private var valueAxis: some AxisContent {
        AxisMarks(values: .automatic(desiredCount: 4)) { value in
            AxisGridLine()
            AxisValueLabel {
                if let v = value.as(Double.self) { Text(chart.formatted(v)) }
            }
        }
    }

    /// What VoiceOver reads instead of the drawing: each slice or the first
    /// and last value of each line.
    private var spokenSummary: String {
        if chart.type == "pie" || chart.type == "bar" {
            let values = chart.series.first?.values ?? []
            return zip(chart.labels, values).compactMap { label, v in v.map { "\(label): \(chart.formatted($0))" } }
                .prefix(12).joined(separator: ", ")
        }
        return chart.series.compactMap { s in
            guard let first = s.values.firstIndex(where: { $0 != nil }),
                  let last = s.values.lastIndex(where: { $0 != nil }),
                  let a = s.values[first], let b = s.values[last] else { return nil }
            return "\(s.name) von \(chart.formatted(a)) am \(chart.labels[first]) auf \(chart.formatted(b)) am \(chart.labels[last])"
        }.joined(separator: "; ")
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}
