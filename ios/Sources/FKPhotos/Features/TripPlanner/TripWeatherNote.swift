import SwiftUI


// Rain over a day of the stay (reise-planen-und-unterwegs.md, stage 7,
// step 1): the note above the day, the sheet "Tage tauschen?" and the
// two calls behind them. The rules live on the server
// (`trip-planner/stay-weather.ts`); this only draws what it says.

struct TripWeatherSpot: Codable, Hashable, Sendable {
    let osmRef: String
    let name: String
}

struct TripWeatherStay: Codable, Hashable, Sendable {
    let osmRef: String
    let name: String
    let dayIndex: Int
    let because: String
}

struct TripWeatherSwap: Codable, Hashable, Sendable {
    let withDayIndex: Int
    let gets: [TripWeatherSpot]
    let gives: [TripWeatherSpot]
    let stays: [TripWeatherStay]
}

struct TripWeatherOutdoorMove: Codable, Hashable, Sendable {
    let toDayIndex: Int
    let moves: [TripWeatherSpot]
}

struct TripWeatherNote: Codable, Hashable, Identifiable, Sendable {
    let dayIndex: Int
    /// 1 showers, 2 rain.
    let wetness: Int
    let rainFromMinutes: Int?
    let temperatureC: Int?
    let outdoor: [TripWeatherSpot]
    let drierDayIndex: Int?
    let drierWetness: Int?
    let swap: TripWeatherSwap?
    let outdoorMove: TripWeatherOutdoorMove?

    var id: Int { dayIndex }
}

struct TripWeatherNotesResponse: Codable, Sendable {
    let notes: [TripWeatherNote]
    let degraded: Bool
}

struct TripWeatherNoteApplyResponse: Decodable, Sendable {
    let plan: TripPlan
    let sentence: String
    let opId: Int
}

/// The words of a note, kept apart from the view so they can be tested.
enum TripWeatherText {
    /// "Fr" for the day of the stay, or "Tag 3" without a date.
    static func weekday(_ dayIndex: Int, in leg: TripLeg) -> String {
        guard let start = leg.startDate,
              let iso = TripCalendar.day(start, plus: dayIndex),
              let date = TripCalendar.date(fromIsoDay: iso)
        else { return "Tag \(dayIndex + 1)" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.setLocalizedDateFormatFromTemplate("EEE")
        return formatter.string(from: date).replacingOccurrences(of: ".", with: "")
    }

    /// "Fr 27.11." or "Tag 3".
    static func day(_ dayIndex: Int, in leg: TripLeg) -> String {
        guard let start = leg.startDate,
              let iso = TripCalendar.day(start, plus: dayIndex),
              let date = TripCalendar.date(fromIsoDay: iso)
        else { return "Tag \(dayIndex + 1)" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.dateFormat = "d.M."
        return "\(weekday(dayIndex, in: leg)) \(formatter.string(from: date))"
    }

    /// "Regen an einem Tag mit 3 Spots draußen".
    static func title(_ note: TripWeatherNote) -> String {
        let what = note.wetness >= 2 ? "Regen" : "Schauer"
        let count = note.outdoor.count
        return count == 1
            ? "\(what) an einem Tag mit einem Spot draußen"
            : "\(what) an einem Tag mit \(count) Spots draußen"
    }

    /// "Fr 27.11. wird trocken, dort ist alles drinnen." or why nothing helps.
    static func subtitle(_ note: TripWeatherNote, leg: TripLeg) -> String {
        var parts: [String] = []
        if let from = note.rainFromMinutes {
            parts.append("ab \(TripClock.format(from)) Uhr")
        }
        guard let drier = note.drierDayIndex else {
            parts.append("kein trockenerer Tag in diesem Aufenthalt")
            return parts.joined(separator: ", ").capitalizedFirst + "."
        }
        let weather = note.drierWetness == 0 ? "wird trocken" : "wird trockener"
        let inside = note.swap != nil ? ", dort ist alles drinnen" : ""
        parts.append("\(day(drier, in: leg)) \(weather)\(inside)")
        return parts.joined(separator: ", ").capitalizedFirst + "."
    }

    static func names(_ spots: [TripWeatherSpot]) -> String {
        spots.isEmpty ? "nichts" : spots.map(\.name).joined(separator: ", ")
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// The note at the top of a day: what is wrong and the two ways out.
struct TripWeatherNoteCard: View {
    let note: TripWeatherNote
    let leg: TripLeg
    let busy: Bool
    let swap: () -> Void
    let moveOutdoor: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: note.wetness >= 2 ? "cloud.rain" : "cloud.drizzle")
                    .foregroundStyle(.blue)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(TripWeatherText.title(note))
                        .font(.subheadline.weight(.semibold))
                    Text(TripWeatherText.subtitle(note, leg: leg))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if note.swap != nil || note.outdoorMove != nil {
                HStack(spacing: 12) {
                    if let target = note.swap?.withDayIndex {
                        Button("Mit \(TripWeatherText.weekday(target, in: leg)) tauschen", action: swap)
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    if note.outdoorMove != nil {
                        Button("Nur draußen verschieben", action: moveOutdoor)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    if busy { ProgressView() }
                }
                .disabled(busy)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.1), in: .rect(cornerRadius: 10))
    }
}

/// "Tage tauschen?": which day gets what, and what stays, before anything moves.
struct TripWeatherSwapSheet: View {
    let note: TripWeatherNote
    let leg: TripLeg
    let confirm: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            if let swap = note.swap {
                List {
                    Section("\(TripWeatherText.day(note.dayIndex, in: leg)) bekommt") {
                        Text(TripWeatherText.names(swap.gets))
                    }
                    Section("\(TripWeatherText.day(swap.withDayIndex, in: leg)) bekommt") {
                        Text(TripWeatherText.names(swap.gives))
                    }
                    if !swap.stays.isEmpty {
                        Section {
                            ForEach(swap.stays, id: \.osmRef) { stay in
                                Label("\(stay.name) · \(stay.because)", systemImage: "pin.fill")
                            }
                        } header: {
                            Text("Bleibt am Tag")
                        } footer: {
                            Text("Ein Spot mit fester Zeit bleibt an seinem Datum. Die Uhrzeiten rechnet die App neu.")
                        }
                    }
                    Section {
                        Button("Tauschen") {
                            confirm()
                            dismiss()
                        }
                        .frame(maxWidth: .infinity)
                        .fontWeight(.semibold)
                    } footer: {
                        Text("Rückgängig unter „Änderungen“.")
                            .frame(maxWidth: .infinity)
                    }
                }
                .navigationTitle("Tage tauschen?")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Abbrechen") { dismiss() }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .opaqueSheetBackground()
    }
}

/// The two calls, so the view only says when.
enum TripWeatherAPI {
    static func notes(planId: Int, legIndex: Int) async -> [TripWeatherNote] {
        let response: TripWeatherNotesResponse? = try? await APIClient.shared.get(
            "/trip-planner/plans/\(planId)/legs/\(legIndex)/weather-notes")
        return response?.notes ?? []
    }

    static func apply(planId: Int, legIndex: Int, dayIndex: Int, kind: String) async throws -> TripWeatherNoteApplyResponse {
        struct Body: Encodable {
            let dayIndex: Int
            let kind: String
        }
        return try await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/legs/\(legIndex)/weather-notes/apply",
            body: Body(dayIndex: dayIndex, kind: kind))
    }

    static func undo(planId: Int, opId: Int) async throws {
        let _: TripJournal = try await APIClient.shared.post(
            "/trip-planner/plans/\(planId)/ops/undo", body: TripUndoRequest(opId: opId))
    }
}
