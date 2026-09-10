import SwiftUI

/// Afterwards (§8.7).
///
/// Planned against actually visited, and the photos each spot got. The
/// screen is built around the half a tick list would throw away: the
/// **stays nobody planned** stand on their own, above the plan rather
/// than under it, because those are what a trip turns out to have been
/// about.
///
/// Nothing here is a reproach. A skipped stop is not a failure — §5 is
/// built on the assumption that days go differently — so the wording
/// counts rather than scolds.
struct TripReviewView: View {
    let planId: Int

    @State private var review: TripReview?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        List {
            if isLoading && review == nil {
                Section { ProgressView() }
            }

            if let review {
                Section {
                    LabeledContent("Geplant", value: "\(review.totals.planned)")
                    LabeledContent("Abgehakt", value: "\(review.totals.done)")
                    LabeledContent("Ausgelassen", value: "\(review.totals.skipped)")
                    LabeledContent("Ungeplant dazu", value: "\(review.totals.unplanned)")
                    LabeledContent("Fotos", value: "\(review.totals.photos)")
                } header: {
                    Text(review.period)
                }

                if !review.unplanned.isEmpty {
                    Section {
                        ForEach(review.unplanned) { stay in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(stay.displayName)
                                Text(stay.subtitle)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } header: {
                        Text("Nicht geplant, trotzdem passiert")
                    } footer: {
                        Text("Aus dem Reisetagebuch: Orte, an denen ihr wart, ohne dass sie "
                             + "im Plan standen.")
                    }
                }

                Section {
                    ForEach(review.stops) { stop in
                        HStack(alignment: .firstTextBaseline) {
                            Image(systemName: stop.symbolName)
                                .foregroundStyle(stop.tint)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(stop.displayName)
                                Text(stop.subtitle)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if stop.photos > 0 {
                                Label("\(stop.photos)", systemImage: "photo")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Der Plan")
                } footer: {
                    Text("Ausgelassen ist kein Versäumnis — ein Tag, der anders lief, ist der "
                         + "Regelfall, nicht der Fehler.")
                }

                Section {
                    if let recap = review.recap {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(recap.title, systemImage: "sparkles.rectangle.stack")
                            if let subtitle = recap.subtitle {
                                Text(subtitle).font(.footnote).foregroundStyle(.secondary)
                            }
                            Text("\(recap.photos) Fotos")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        // Not a fault: a recap is made of photographs,
                        // and they arrive before it does.
                        Text("Noch kein Rückblick — er entsteht, sobald die Fotos der Reise "
                             + "verarbeitet sind.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Rückblick")
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Danach")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            review = try await APIClient.shared.get("/trip-planner/plans/\(planId)/review")
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct TripReview: Codable, Sendable {
    let startsOn: String?
    let endsOn: String?
    let stops: [TripReviewStop]
    let unplanned: [TripReviewStay]
    let totals: TripReviewTotals
    /// The recap this trip produced, once one exists.
    let recap: TripReviewRecap?

    /// "18.06. – 25.06." — or nothing to say for a trip without dates.
    var period: String {
        guard let startsOn else { return "Die Reise" }
        guard let endsOn, endsOn != startsOn else { return startsOn }
        return "\(startsOn) – \(endsOn)"
    }
}

struct TripReviewRecap: Codable, Sendable {
    let id: Int
    let title: String
    let subtitle: String?
    let photos: Int
}

struct TripReviewTotals: Codable, Sendable {
    let planned: Int
    let done: Int
    let skipped: Int
    let untouched: Int
    let unplanned: Int
    let photos: Int
}

struct TripReviewStop: Codable, Identifiable, Sendable {
    let legIndex: Int
    let dayIndex: Int
    let date: String?
    let osmRef: String
    let name: String?
    /// planned | done | skipped.
    let status: String
    /// True when the visit diary confirms it, whatever the status says.
    let visited: Bool
    let photos: Int

    var id: String { "\(legIndex)-\(dayIndex)-\(osmRef)" }
    var displayName: String { name ?? "Unbenannter Ort" }

    /// The day it belonged to, and what the diary knows on top.
    var subtitle: String {
        let day = date ?? "Tag \(dayIndex + 1)"
        if status == "planned" && visited {
            // Being there and ticking it off are two different records,
            // and the screen says both rather than picking one.
            return "\(day) · wart ihr da, abgehakt ist es nicht"
        }
        return day
    }

    var symbolName: String {
        if status == "done" { return "checkmark.circle.fill" }
        if status == "skipped" { return "minus.circle" }
        return visited ? "mappin.circle.fill" : "circle"
    }

    var tint: Color {
        if status == "done" { return .green }
        if visited { return .accentColor }
        return .secondary
    }
}

struct TripReviewStay: Codable, Identifiable, Sendable {
    let name: String?
    let osmRef: String?
    let lat: Double
    let lon: Double
    let arrivedAt: String
    let photos: Int

    var id: String { "\(osmRef ?? "-")-\(arrivedAt)" }
    var displayName: String { name ?? "Ein Ort ohne Namen" }

    var subtitle: String {
        let day = String(arrivedAt.prefix(10))
        return photos > 0 ? "\(day) · \(photos) Fotos" : day
    }
}
