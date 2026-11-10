import SwiftUI

/// Why a spot has a fixed time (reise-planen-und-unterwegs.md, stage 3):
/// the ticket for 14:00, the sunset, the table at eight, the concert, the
/// boat that leaves. Every pinned spot is a hard time for the day order,
/// whatever the reason; the reason is what the card says next to the
/// clock, so nobody moves the table at eight thinking it was a guess.
enum TripPinReason: String, CaseIterable, Identifiable, Sendable {
    case ticket, light, reservation, event, departure

    var id: String { rawValue }

    init?(raw: String?) {
        guard let raw, let reason = TripPinReason(rawValue: raw) else { return nil }
        self = reason
    }

    var label: String {
        switch self {
        case .ticket: "Ticket"
        case .light: "Licht"
        case .reservation: "Reservierung"
        case .event: "Ereignis"
        case .departure: "Abfahrt"
        }
    }

    var systemImage: String {
        switch self {
        case .ticket: "ticket"
        case .light: "sun.horizon"
        case .reservation: "fork.knife"
        case .event: "star"
        case .departure: "ferry"
        }
    }
}

/// "Ticket 14:00" — the reason and the hour, as one chip on a spot card.
struct TripPinChip: View {
    let reason: TripPinReason?
    let startMinutes: Int

    var body: some View {
        Label("\(reason?.label ?? "Fest") \(TripClock.format(startMinutes))",
              systemImage: reason?.systemImage ?? "pin.fill")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.orange.opacity(0.15), in: .capsule)
            .foregroundStyle(.orange)
            .accessibilityLabel("Feste Zeit \(TripClock.format(startMinutes))\(reason.map { ", \($0.label)" } ?? "")")
    }
}
