import SwiftUI

/// How much an idea matters (ideas plan, stage 3): Muss, Will, Wenn Zeit.
/// Said by the travellers; the app never sets it on its own.
enum TripIdeaPriority: String, CaseIterable, Identifiable, Sendable {
    case must, want, maybe

    var id: String { rawValue }

    init(raw: String?) {
        self = TripIdeaPriority(rawValue: raw ?? "") ?? .want
    }

    var label: String {
        switch self {
        case .must: "Muss"
        case .want: "Will"
        case .maybe: "Wenn Zeit"
        }
    }

    var systemImage: String {
        switch self {
        case .must: "exclamationmark.circle.fill"
        case .want: "circle"
        case .maybe: "clock"
        }
    }
}

/// What an idea row says beside its name: priority, ticket, closed
/// days, unclear hours. One view, so the list and the day read the same.
struct TripIdeaChips: View {
    let priority: TripIdeaPriority
    var ticket: String? = nil
    /// Dates of the stay on which it is closed (YYYY-MM-DD).
    var closedOn: [String] = []
    /// Closed on the date of the day this stop is on.
    var closedThatDay = false
    var openingHours: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            // Will is the ordinary case and says nothing.
            if priority != .want {
                chip(priority.label, systemImage: priority.systemImage,
                     tint: priority == .must ? .orange : .secondary)
            }
            if let ticket {
                chip("Ticket \(ticket)", systemImage: "ticket", tint: .accentColor)
            }
            if closedThatDay {
                chip("an diesem Tag geschlossen", systemImage: "door.left.hand.closed", tint: .red)
            } else if !closedOn.isEmpty {
                chip("geschlossen \(closedOn.map(Self.shortDate).joined(separator: ", "))",
                     systemImage: "door.left.hand.closed", tint: .secondary)
            } else if let openingHours, !TripOpeningHours.isReadable(openingHours) {
                chip("Öffnungszeiten unklar", systemImage: "questionmark.circle", tint: .secondary)
            }
        }
        .font(.caption)
    }

    private func chip(_ text: String, systemImage: String, tint: Color) -> some View {
        Label(text, systemImage: systemImage)
            .foregroundStyle(tint)
            .lineLimit(1)
    }

    /// "Mo 7.9." from "2026-09-07".
    static func shortDate(_ iso: String) -> String {
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return iso }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let date = calendar.date(from: components) else { return iso }
        let weekday = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][calendar.component(.weekday, from: date) - 1]
        return "\(weekday) \(parts[2]).\(parts[1])."
    }
}

/// Whether the server could read a place's opening hours. The same
/// rule as `opening-hours.ts`: only plain weekday and hour forms.
enum TripOpeningHours {
    static func isReadable(_ spec: String) -> Bool {
        let text = spec.trimmingCharacters(in: .whitespaces)
        if text == "24/7" { return true }
        if text.isEmpty || text.contains("||") || text.contains("\"") || text.contains("[") { return false }
        let day = "(Mo|Tu|We|Th|Fr|Sa|Su|PH)"
        let selector = "\(day)(-\(day))?(,\(day)(-\(day))?)*"
        let time = "\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}"
        let body = "(off|closed|\(time)(,\(time))*)"
        let rule = "^((\(selector))(\\s+\(body))?|\(body))$"
        for part in text.split(separator: ";") {
            let piece = part.trimmingCharacters(in: .whitespaces)
            if piece.isEmpty { continue }
            if piece.range(of: rule, options: [.regularExpression, .caseInsensitive]) == nil { return false }
        }
        return true
    }

    /// "Di–So 10–18 · Mo geschlossen" from "Tu-Su 10:00-18:00; Mo off",
    /// in German day names. Hours it cannot read come back as written.
    static func display(_ spec: String) -> String {
        let text = spec.trimmingCharacters(in: .whitespaces)
        if text == "24/7" { return "immer geöffnet" }
        guard isReadable(text) else { return text }
        let days = ["Mo": "Mo", "Tu": "Di", "We": "Mi", "Th": "Do", "Fr": "Fr", "Sa": "Sa", "Su": "So", "PH": "Feiertag"]
        return text.split(separator: ";").map { part in
            var piece = part.trimmingCharacters(in: .whitespaces)
            for (english, german) in days {
                piece = piece.replacingOccurrences(of: english, with: german, options: .caseInsensitive)
            }
            piece = piece.replacingOccurrences(of: "off", with: "geschlossen", options: .caseInsensitive)
            piece = piece.replacingOccurrences(of: "closed", with: "geschlossen", options: .caseInsensitive)
            piece = piece.replacingOccurrences(of: ":00", with: "")
            piece = piece.replacingOccurrences(of: "(^|[\\s,-])0(\\d)", with: "$1$2", options: .regularExpression)
            piece = piece.replacingOccurrences(of: "\\s*-\\s*", with: "–", options: .regularExpression)
            piece = piece.replacingOccurrences(of: ",", with: ", ")
            return piece
        }
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }
}

extension TripIdeaPriority {
    /// The other two priorities as actions, for every way of looking at
    /// an idea: its row, its detail, the map's sheet (one list, §8.4).
    static func actions(
        current: TripIdeaPriority,
        set: @escaping @MainActor (TripIdeaPriority) async -> Void,
    ) -> [TripPinSheetAction] {
        allCases.filter { $0 != current }.map { priority in
            TripPinSheetAction(id: "priority-\(priority.rawValue)", title: "Priorität: \(priority.label)",
                               systemImage: priority.systemImage, closes: false, group: .plan,
                               submenu: .priority) {
                await set(priority)
            }
        }
    }
}
