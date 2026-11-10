import SwiftUI

// The evening light of a spot on the days of its stay
// (reise-planen-und-unterwegs.md, stage 7, step 2): shown in the spot's
// details, with "+ Tag n am Abend" to plan it as a fixed time whose
// reason is the light. The server decides which spots have a light and
// which day to offer (`trip-planner/spot-light.ts`).

struct TripStaySpotLightDay: Codable, Hashable, Sendable {
    let dayIndex: Int
    let date: String
    let fromMinutes: Int
    let toMinutes: Int
    let facade: String?
    let cloudCover: Int?
    let cloudy: Bool
    let past: Bool
}

struct TripStaySpotLightResponse: Codable, Sendable {
    let applies: Bool
    let days: [TripStaySpotLightDay]
    let suggestedDayIndex: Int?
    let onDayIndex: Int?
    let fixedDayIndex: Int?
}

/// Where a spot's details may ask for its light: the trip, the stay, the spot.
struct TripStayLightRef: Hashable, Sendable {
    let planId: Int
    let legIndex: Int
    let osmRef: String
    /// The stay, for the weekday names.
    let startDate: String?
}

enum TripStaySpotLightText {
    /// "ca. 16:05 bis 16:40": from the earliest start to the latest end
    /// over the coming days, rounded to five minutes.
    static func range(_ days: [TripStaySpotLightDay]) -> String? {
        let coming = days.filter { !$0.past }
        guard let from = coming.map(\.fromMinutes).min(), let to = coming.map(\.toMinutes).max() else { return nil }
        return "ca. \(TripClock.format(round5(from))) bis \(TripClock.format(round5(to)))"
    }

    /// "Sa 28.11.: Wolken erwartet, Fr lohnt eher" for a cloudy day, or nil.
    static func cloudNote(_ response: TripStaySpotLightResponse, weekday: (Int) -> String, day: (Int) -> String) -> String? {
        let coming = response.days.filter { !$0.past }
        guard let cloudy = coming.first(where: { $0.cloudy }) else { return nil }
        let better = response.suggestedDayIndex.flatMap { index in
            coming.first(where: { $0.dayIndex == index && !$0.cloudy })
        }
        let tail = better.map { ", \(weekday($0.dayIndex)) lohnt eher" } ?? ""
        return "\(day(cloudy.dayIndex)): Wolken erwartet\(tail)"
    }

    private static func round5(_ minutes: Int) -> Int { (minutes + 2) / 5 * 5 }
}

/// The section in a spot's details. Shows nothing for a spot without a
/// view, without a date, or that is not part of the stay.
struct TripStaySpotLightSection: View {
    let ref: TripStayLightRef
    /// After "+ Tag n am Abend": the trip changed, the caller reloads.
    let onAccepted: () async -> Void

    @State private var light: TripStaySpotLightResponse?
    @State private var accepting = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let light, light.applies, !light.days.isEmpty {
                Section {
                    if let range = TripStaySpotLightText.range(light.days) {
                        LabeledContent("Bestes Licht an euren Tagen", value: range)
                    }
                    if let note = TripStaySpotLightText.cloudNote(light, weekday: weekday, day: dayName) {
                        Label(note, systemImage: "cloud")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let fixed = light.fixedDayIndex {
                        Label("Am \(dayName(fixed)) am Abend eingeplant", systemImage: "sun.horizon.fill")
                            .foregroundStyle(.secondary)
                    }
                    if let target = light.suggestedDayIndex, target != light.fixedDayIndex {
                        Button {
                            Task { await accept(target) }
                        } label: {
                            HStack {
                                Label("+ Tag \(target + 1) am Abend", systemImage: "sun.horizon")
                                if accepting { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(accepting)
                        .contextMenu {
                            ForEach(light.days.filter { !$0.past && $0.dayIndex != target }, id: \.dayIndex) { day in
                                Button("Tag \(day.dayIndex + 1) am Abend (\(dayName(day.dayIndex)))") {
                                    Task { await accept(day.dayIndex) }
                                }
                            }
                        }
                    }
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Label("Abendlicht", systemImage: "sun.horizon")
                } footer: {
                    Text("Übernommen ist der Spot fest am Abend, Grund „Licht“. Langes Drücken wählt einen anderen Tag.")
                }
            }
        }
        .task(id: ref) { await load() }
    }

    private func load() async {
        light = try? await APIClient.shared.get(
            "/trip-planner/plans/\(ref.planId)/legs/\(ref.legIndex)/spot-light",
            query: ["osmRef": ref.osmRef])
    }

    private func accept(_ dayIndex: Int) async {
        struct Body: Encodable {
            let osmRef: String
            let dayIndex: Int
        }
        accepting = true
        defer { accepting = false }
        do {
            let _: TripPlanResponse = try await APIClient.shared.post(
                "/trip-planner/plans/\(ref.planId)/legs/\(ref.legIndex)/spot-light/accept",
                body: Body(osmRef: ref.osmRef, dayIndex: dayIndex))
            errorMessage = nil
            await onAccepted()
            await load()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }

    private func dayName(_ dayIndex: Int) -> String {
        guard let start = ref.startDate,
              let iso = TripCalendar.day(start, plus: dayIndex),
              let date = TripCalendar.date(fromIsoDay: iso)
        else { return "Tag \(dayIndex + 1)" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.dateFormat = "d.M."
        return "\(weekday(dayIndex)) \(formatter.string(from: date))"
    }

    private func weekday(_ dayIndex: Int) -> String {
        guard let start = ref.startDate,
              let iso = TripCalendar.day(start, plus: dayIndex),
              let date = TripCalendar.date(fromIsoDay: iso)
        else { return "Tag \(dayIndex + 1)" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.setLocalizedDateFormatFromTemplate("EEE")
        return formatter.string(from: date).replacingOccurrences(of: ".", with: "")
    }
}
