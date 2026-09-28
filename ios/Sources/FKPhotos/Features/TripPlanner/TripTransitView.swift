import SwiftUI

/// The journey between two legs, with a beginning and an end that each
/// have a date and a time (§22.7).
///
/// The leg before ends with the departure and the leg after begins with
/// the arrival — the server moves both, and every leg after them. By
/// car, bike or on foot within one day the journey is planned: one block
/// "Unterwegs" with the places worth a stop on the way. By train, or
/// over several days, it stays a frame that says where the group is.
///
/// Changing a journey changes it in place: the server frames both
/// neighbours by the new moments and re-plans the journey, and a
/// refusal leaves everything as it was.
struct TripTransitView: View {
    @State var viewModel: TripPlannerViewModel
    /// The leg the journey leaves from, by position.
    let afterLegIndex: Int
    /// The journey being changed, or nil for a new one.
    let existing: TripLeg?
    /// What the planner suggested, to open with (§22.7).
    var suggested: TripTransitSuggestion? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var depart = Date()
    @State private var arrive = Date()
    @State private var mode: TripTransportMode = .car
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var legs: [TripLeg] { viewModel.plan?.legs.sorted(by: { $0.position < $1.position }) ?? [] }
    private var from: TripLeg? { legs.first { $0.position == afterLegIndex } }
    /// The leg the journey reaches: the one after it, skipping the
    /// journey itself when it is being changed.
    private var to: TripLeg? {
        legs.first { $0.position > afterLegIndex && !$0.isTransit }
    }
    private var home: TripHome? { viewModel.plan?.home }
    /// The two ends in words: a place, or home at either end (§22.7).
    private var fromTitle: String { from?.anchorTitle ?? home?.displayLabel ?? "–" }
    private var toTitle: String { to?.anchorTitle ?? home?.displayLabel ?? "–" }
    private var kindWord: String {
        from == nil ? "Anreise" : to == nil ? "Heimreise" : "Weiterreise"
    }
    /// Home at an end that has no place; a journey needs both ends.
    private var hasBothEnds: Bool { (from != nil || home != nil) && (to != nil || home != nil) }

    var body: some View {
        Form {
            Section {
                LabeledContent("Von", value: fromTitle)
                LabeledContent("Nach", value: toTitle)
            }
            Section {
                DatePicker("Abfahrt", selection: $depart, displayedComponents: [.date, .hourAndMinute])
                DatePicker("Ankunft", selection: $arrive, in: depart..., displayedComponents: [.date, .hourAndMinute])
            } footer: {
                Text(TripTransitPlanning.frameSentence(from: from?.displayTitle, to: to?.displayTitle))
            }
            Section {
                Picker("Unterwegs", selection: $mode) {
                    ForEach(TripTransportMode.allCases, id: \.self) { mode in
                        Label(mode.label, systemImage: mode.systemImage).tag(mode)
                    }
                }
            } footer: {
                Text(TripTransitPlanning.sentence(mode: mode, depart: depart, arrive: arrive))
            }
        }
        .navigationTitle(existing == nil ? kindWord : "\(kindWord) ändern")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(errorMessage, dismiss: { errorMessage = nil })
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    Task { await save() }
                } label: {
                    if isSaving { ProgressView() } else { Text("Sichern") }
                }
                .disabled(isSaving || arrive <= depart || !hasBothEnds)
            }
        }
        .onAppear(perform: prefill)
    }

    /// The journey as it is, or — for a new one — setting off at ten on
    /// the last day of the leg being left, and arriving at four.
    private func prefill() {
        if let existing, let first = existing.startDate,
           let departMinutes = existing.departMinutes, let endMinutes = existing.endMinutes,
           let lastDay = TripCalendar.day(first, plus: existing.days.count - 1) {
            depart = TripTransitPlanning.moment(first, minutes: departMinutes) ?? depart
            arrive = TripTransitPlanning.moment(lastDay, minutes: endMinutes) ?? arrive
            mode = existing.transportMode
            return
        }
        if let suggested,
           let departMinutes = TripTransitPlanning.minutes(fromClock: suggested.departAt),
           let arriveMinutes = TripTransitPlanning.minutes(fromClock: suggested.arriveAt) {
            depart = TripTransitPlanning.moment(suggested.departDate, minutes: departMinutes) ?? depart
            arrive = TripTransitPlanning.moment(suggested.arriveDate, minutes: arriveMinutes) ?? arrive
            mode = TripTransportMode(raw: suggested.mode)
            return
        }
        if let from, let start = from.startDate,
           let lastDay = TripCalendar.day(start, plus: max(0, from.days.count - 1)) {
            depart = TripTransitPlanning.moment(lastDay, minutes: 10 * 60) ?? depart
            arrive = TripTransitPlanning.moment(lastDay, minutes: 16 * 60) ?? arrive
        } else if let to, let start = to.startDate {
            // From home: the day the first place begins, arriving when
            // it expects the group.
            depart = TripTransitPlanning.moment(start, minutes: 8 * 60) ?? depart
            arrive = TripTransitPlanning.moment(start, minutes: to.arriveMinutes ?? 14 * 60) ?? arrive
        }
        mode = to?.transportMode == .car || from?.transportMode == .car ? .car : (to?.transportMode ?? from?.transportMode ?? .car)
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let body = TripTransitPlanning.body(afterLegIndex: afterLegIndex, depart: depart,
                                                arrive: arrive, mode: mode)
            let response: TripPlanResponse
            if let existing {
                response = try await APIClient.shared.patch(
                    "/trip-planner/plans/\(viewModel.planId)/transits/\(existing.position)",
                    body: body.change)
            } else {
                response = try await APIClient.shared.post(
                    "/trip-planner/plans/\(viewModel.planId)/transits", body: body)
            }
            viewModel.replace(with: response)
            dismiss()
        } catch {
            errorMessage = TripErrorText.describe(error)
        }
    }
}

/// The arithmetic behind the journey screen, apart so it can be tested.
enum TripTransitPlanning {
    struct Body: Encodable, Equatable {
        let afterLegIndex: Int
        let departDate: String
        let departAt: String
        let arriveDate: String
        let arriveAt: String
        let mode: String

        /// The same moments for changing a journey, which is addressed
        /// by its own position in the path rather than its neighbour's.
        var change: Change {
            Change(departDate: departDate, departAt: departAt, arriveDate: arriveDate,
                   arriveAt: arriveAt, mode: mode)
        }
    }

    struct Change: Encodable, Equatable {
        let departDate: String
        let departAt: String
        let arriveDate: String
        let arriveAt: String
        let mode: String
    }

    static func body(afterLegIndex: Int, depart: Date, arrive: Date, mode: TripTransportMode,
                     timeZone: TimeZone = .current) -> Body {
        Body(
            afterLegIndex: afterLegIndex,
            departDate: TripCalendar.isoDay(depart, timeZone: timeZone),
            departAt: TripClock.format(minutes(of: depart, timeZone: timeZone)),
            arriveDate: TripCalendar.isoDay(arrive, timeZone: timeZone),
            arriveAt: TripClock.format(minutes(of: arrive, timeZone: timeZone)),
            mode: mode.rawValue,
        )
    }

    /// A day and a time as one moment on this phone's clock.
    static func moment(_ isoDay: String, minutes: Int, timeZone: TimeZone = .current) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = isoDay.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(
            year: parts[0], month: parts[1], day: parts[2], hour: minutes / 60, minute: minutes % 60))
    }

    /// "10:00" to 600.
    static func minutes(fromClock text: String) -> Int? {
        let parts = text.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0..<24).contains(parts[0]), (0..<60).contains(parts[1]) else { return nil }
        return parts[0] * 60 + parts[1]
    }

    static func minutes(of date: Date, timeZone: TimeZone = .current) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }

    /// What the two moments do to the neighbours: a place at each end,
    /// or home at one of them (§22.7).
    static func frameSentence(from: String?, to: String?) -> String {
        switch (from, to) {
        case let (from?, to?):
            return "„\(from)“ endet mit der Abfahrt, „\(to)“ beginnt mit der Ankunft. "
                + "Alle Etappen danach verschieben sich mit."
        case let (nil, to?):
            return "„\(to)“ beginnt mit der Ankunft. Alle Etappen danach verschieben sich mit."
        case let (from?, nil):
            return "„\(from)“ endet mit der Abfahrt."
        default:
            return "Abfahrt und Ankunft der Reise."
        }
    }

    /// What will happen to the journey, said before it is saved.
    static func sentence(mode: TripTransportMode, depart: Date, arrive: Date,
                         timeZone: TimeZone = .current) -> String {
        let sameDay = TripCalendar.isoDay(depart, timeZone: timeZone)
            == TripCalendar.isoDay(arrive, timeZone: timeZone)
        switch (mode, sameDay) {
        case (.transit, _):
            return "Mit Bahn oder Bus wird nichts hineingeplant — die Weiterreise sagt nur, wo ihr seid."
        case (_, false):
            return "Über mehrere Tage wird nichts hineingeplant. Für eine Übernachtung unterwegs "
                + "lieber eine eigene Etappe anlegen."
        default:
            return "Der Planer sucht Orte am Weg, deren Umweg noch in die Zeit passt, "
                + "und plant sie in einen Block „Unterwegs“."
        }
    }
}

/// The planner's one suggestion for a journey (§22.7), as the server
/// sends it. Writes nothing until it is accepted.
struct TripTransitSuggestion: Codable, Sendable, Equatable {
    let afterLegIndex: Int
    let fromTitle: String
    let toTitle: String
    let departDate: String
    let departAt: String
    let arriveDate: String
    let arriveAt: String
    let mode: String
    let driveMinutes: Int
    let sentence: String

    /// A "no" is remembered on this phone: nothing was written that
    /// could be taken back, so there is nothing to tell the server.
    static func dismissKey(planId: Int, afterLegIndex: Int) -> String {
        "trip.transitSuggestion.dismissed.\(planId).\(afterLegIndex)"
    }
}

struct TripTransitSuggestionResponse: Codable, Sendable {
    let suggestion: TripTransitSuggestion?
}
