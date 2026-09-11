import SwiftUI

/// „Soll ich daraus einen Nachmittag machen?" (§20.2, §20.3)
///
/// The point where the collection stops being a shopping list. §20.2 is
/// precise about the difference: with several entries close together the
/// question is not *„willst du zu diesem?"* but *„soll ich daraus einen
/// Nachmittag machen?"* — and the answer to that is a day plan, which
/// the solver has computed all along. A pool plus an anchor plus a time
/// budget *is* the planner's input; all that was missing was the
/// occasion.
///
/// The screen shows the proposal and writes nothing. Accepting is a
/// second, deliberate step, and it produces an ordinary one-day trip
/// (§20.3) — not a new kind of object with its own rules.
struct TripIdeasOutingView: View {
    @State var model: TripIdeasViewModel
    /// Set when accepting produced a trip, so the caller can open it.
    @Binding var openPlanId: Int?

    @State private var date = Date()
    @State private var title = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            if let error = model.outingError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }

            if model.isProposing {
                HStack { ProgressView(); Text("Wird gerechnet…") }
            } else if let outing = model.outing {
                if let refusal = outing.refusal {
                    ContentUnavailableView(
                        "Kein Ausflug",
                        systemImage: "figure.walk.motion",
                        description: Text(refusal),
                    )
                } else {
                    Section {
                        ForEach(outing.stops) { stop in
                            row(stop)
                        }
                    } header: {
                        Text("Der Vorschlag")
                    } footer: {
                        Text(outing.summary)
                    }

                    Section("Als Reise übernehmen") {
                        DatePicker("Tag", selection: $date, displayedComponents: .date)
                        TextField("Name (optional)", text: $title)
                        Button {
                            Task { await accept() }
                        } label: {
                            if model.isAcceptingOuting {
                                HStack { ProgressView(); Text("Wird angelegt…") }
                            } else {
                                Text("Ausflug anlegen")
                            }
                        }
                        .disabled(model.isAcceptingOuting)
                    }
                }
            }
        }
        .navigationTitle("Ausflug")
        .task {
            if model.outing == nil { await model.proposeOuting() }
        }
    }

    private func accept() async {
        // The date is a calendar day, and `toLocalIsoDate`'s reason for
        // existing applies here too: a UTC slice would book the outing
        // for yesterday east of Greenwich.
        let day = TripIdeasOutingView.isoDay(date)
        if let planId = await model.acceptOuting(
            date: day,
            title: title.trimmingCharacters(in: .whitespaces),
        ) {
            openPlanId = planId
            dismiss()
        }
    }

    /// The local calendar day, never a UTC slice of an instant.
    static func isoDay(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    @ViewBuilder
    private func row(_ stop: TripOutingStop) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(stop.displayName)
                // Marked, both ways: §20.2 wants "von uns" and
                // "gefunden" to stay apart, because a day made only of
                // fresh finds is not the day the collection promised.
                if stop.fromIdeas {
                    Image(systemName: "lightbulb.fill")
                        .font(.caption)
                        .foregroundStyle(.tint)
                        .accessibilityLabel("Aus eurem Vorrat")
                }
            }
            Text(subtitle(stop))
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func subtitle(_ stop: TripOutingStop) -> String {
        var parts = ["\(stop.dwellMinutes) Min. dort"]
        if stop.travelMinutes > 0 {
            parts.insert("\(stop.travelMinutes) Min. Weg", at: 0)
        }
        if let addedBy = stop.addedBy, !addedBy.isEmpty {
            parts.append("von \(addedBy)")
        }
        return parts.joined(separator: " · ")
    }
}
