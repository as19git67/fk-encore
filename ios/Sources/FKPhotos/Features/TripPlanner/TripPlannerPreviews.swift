#if DEBUG
import SwiftUI

/// Made-up trips for Xcode's canvas (Editor › Canvas): every place,
/// name and time here is invented. The previews show the screens of
/// reise-planen-und-unterwegs with data, without a server; anything a
/// screen loads on its own fails quietly in the canvas.
enum TripPlannerPreviewData {
    static func stop(_ row: Int, _ name: String, category: String, dwell: Int, eta: Int?,
                     priority: String = "want", hours: String? = nil) -> String {
        """
        { "rowId": \(row), "osmRef": "node:\(row)", "name": "\(name)",
          "lat": 48.13\(row), "lon": 11.57\(row), "category": "\(category)",
          "dwellMinutes": \(dwell),
          "travelFromPrevious": { "minutes": 9, "distanceM": 700, "travelClass": "short_walk" },
          "status": "planned", "pinned": false, "note": null, "sourceUrl": null, "title": null,
          "localName": null, "wikipediaUrl": null, "photoStop": false,
          "priority": "\(priority)"\(hours.map { ", \"openingHours\": \"\($0)\"" } ?? "")\(eta.map { ", \"etaMinutes\": \($0)" } ?? "") }
        """
    }

    static func day(_ index: Int, planned: Int, _ stops: [String]) -> String {
        """
        { "id": \(index + 1), "dayIndex": \(index), "detailed": true, "fixpoints": [],
          "window": { "startMinutes": 540, "endMinutes": 1140 }, "plannedMinutes": \(planned),
          "blocks": [ { "id": "day", "rowId": \(index + 1), "label": "Tag", "kind": "spots",
                        "budgetMinutes": 600, "usedMinutes": \(planned), "startMinutes": 540,
                        "stops": [\(stops.joined(separator: ","))] } ] }
        """
    }

    static let idea = """
        { "osmRef": "node:90", "name": "Beispielmarkt", "lat": 48.139, "lon": 11.579,
          "category": "market", "dwellMinutes": 45, "score": 10, "reasons": [],
          "origin": "manual", "note": "Samstags mit Bauernmarkt", "sourceUrl": null,
          "unmatched": false, "title": null, "localName": null, "wikipediaUrl": null,
          "photoStop": false, "priority": "maybe", "openingHours": "Sa 08:00-14:00" }
        """

    static let legJSON = """
        { "id": 1, "position": 0, "title": "Inselhafen",
          "anchor": { "lat": 48.137, "lon": 11.575 },
          "anchorRadiusM": null, "anchorLabel": "Hotel Beispiel", "arriveMinutes": 750,
          "mode": "foot", "regionDb": "nom_beispiel", "startDate": "2026-11-27",
          "days": [
            \(day(0, planned: 150, [
                stop(1, "Kathedrale", category: "worship", dwell: 60, eta: 825, priority: "must",
                     hours: "Tu-Su 10:00-18:00; Mo off"),
                stop(2, "Beispielmuseum", category: "museum", dwell: 90, eta: 930),
            ])),
            \(day(1, planned: 540, [stop(3, "Aussicht am Hafen", category: "viewpoint", dwell: 30, eta: 1040)])),
            \(day(2, planned: 0, []))
          ],
          "pool": [\(idea)] }
        """

    static var leg: TripLeg? {
        try? JSONDecoder().decode(TripLeg.self, from: Data(legJSON.utf8))
    }

    static var plan: TripPlan? {
        guard let leg else { return nil }
        return TripPlan(id: 1, ownerId: 1, title: "Inselhafen im November", constraints: nil, legs: [leg])
    }

    static var firstStop: TripStop? {
        leg.flatMap { TripStayPlan.stops(of: $0.days[0]).first }
    }

    static let actions: [TripPinSheetAction] = [
        TripPinSheetAction(id: "done", title: "Erledigt", systemImage: "checkmark", group: .status) {},
        TripPinSheetAction(id: "move", title: "Auf einen anderen Tag", systemImage: "calendar") {},
        TripPinSheetAction(id: "toPool", title: "Zurück zu den Ideen", systemImage: "tray.and.arrow.down") {},
    ]
}

#Preview("Aufenthalt planen") {
    if let plan = TripPlannerPreviewData.plan {
        NavigationStack {
            TripStayPlanView(viewModel: .preview(plan), stopActions: { _ in TripPlannerPreviewData.actions },
                             openDay: { _ in })
        }
    } else {
        Text("Beispieldaten passen nicht mehr zum Modell")
    }
}

#Preview("Spot-Details") {
    if let leg = TripPlannerPreviewData.leg, let stop = TripPlannerPreviewData.firstStop {
        Color.clear.sheet(isPresented: .constant(true)) {
            NavigationStack {
                TripSpotDetailView(spot: TripSpotDetailContext.detail(stop, dayIndex: 0, leg: leg, pin: nil),
                                   bar: .planned(TripPlannerPreviewData.actions)) { _ in EmptyView() }
            }
            .presentationDetents([.medium, .large])
        }
    } else {
        Text("Beispieldaten passen nicht mehr zum Modell")
    }
}

#Preview("Neue Reise") {
    NavigationStack {
        TripNewPlanView { _ in }
    }
}
#endif
