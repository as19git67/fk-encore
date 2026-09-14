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
///
/// Reached from two places: the nearby list, where the anchor is the
/// phone, and a group in the collection, where the anchor is the
/// group's middle. `anchor` says which, and the proposal on hand is only
/// shown when it was computed for the same one.
struct TripIdeasOutingView: View {
    @State var model: TripIdeasViewModel
    /// Set when accepting produced a trip, so the caller can open it.
    @Binding var openPlanId: Int?
    /// Where the outing starts, when it is not where the phone is.
    var anchor: TripCoordinate? = nil

    @State private var date = Date()
    @State private var title = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            // How big an outing: two hours, the afternoon, the day. A
            // change recomputes — a budget shown next to a proposal it
            // was not computed with would be a lie in a segmented
            // control.
            Section {
                Picker("Zeit", selection: budget) {
                    ForEach(TripOutingBudget.allCases) { size in
                        Text(size.label).tag(size)
                    }
                }
                .pickerStyle(.segmented)
            } footer: {
                Text(anchor == nil
                     ? "Von hier aus, mit euren Ideen im Umkreis von 25 km."
                     : "Rund um diese Gruppe, mit euren Ideen im Umkreis von 25 km.")
            }


            if model.isProposing {
                HStack { ProgressView(); Text("Wird gerechnet…") }
            } else if let outing = model.outing, model.hasOuting(around: anchor) {
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
            } else if model.outingError == nil {
                // Nothing on hand and nothing failed: the first request
                // has not run, or ran for another anchor. Said, with the
                // way to change it — a blank list under a title reads as
                // "the app is stuck".
                ContentUnavailableView {
                    Label("Noch nichts gerechnet", systemImage: "figure.walk.motion")
                } description: {
                    Text("Der Vorschlag wird aus euren Ideen und der Umgebung gerechnet.")
                } actions: {
                    Button("Ausflug vorschlagen") {
                        Task { await model.proposeOuting(around: anchor) }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .navigationTitle("Ausflug")
        .plannerErrorBanner(model.outingError, retry: { await model.proposeOuting() }, dismiss: { model.outingError = nil })
        .task {
            if !model.hasOuting(around: anchor) { await model.proposeOuting(around: anchor) }
        }
        .onChange(of: model.outingBudgetMinutes) { _, _ in
            Task { await model.proposeOuting(around: anchor) }
        }
        .refreshable { await model.proposeOuting(around: anchor) }
    }

    /// The picker's binding onto the model's minute budget.
    ///
    /// The model keeps minutes because that is what the server takes;
    /// the picker shows sizes because that is what people choose. A
    /// minute count that is not one of the three sizes reads as the
    /// default rather than as nothing selected.
    private var budget: Binding<TripOutingBudget> {
        Binding(
            get: { TripOutingBudget(rawValue: model.outingBudgetMinutes) ?? .halfDay },
            set: { model.outingBudgetMinutes = $0.rawValue },
        )
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
                        .accessibilityLabel("Aus euren Ideen")
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
