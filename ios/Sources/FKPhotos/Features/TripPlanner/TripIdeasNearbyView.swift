import SwiftUI

/// „Ist hier etwas von uns in der Nähe?" (§20.2)
///
/// The point at which the collection stops being a list. §20 is blunt
/// about it: *„Eine Ideensammlung, die nur eine Liste ist, wird gelesen,
/// bis sie zu lang ist, und danach nie wieder."* The use comes from the
/// collection speaking up.
///
/// This screen is the half somebody **asks** for. It deliberately does
/// not count as having been told: the server's quiet week starts when an
/// entry is *offered*, and spending that week because a person looked at
/// a list would make the rule punish curiosity. The other half — the
/// collection announcing itself out of the location loop (§7.1) — is
/// still missing, and it is the half that needs the rule.
struct TripIdeasNearbyView: View {
    @State var model: TripIdeasViewModel

    var body: some View {
        List {
            if let error = model.nearbyError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }

            if model.isLoadingNearby {
                HStack { ProgressView(); Text("Wird gesucht…") }
            } else if model.nearby.isEmpty && model.nearbyError == nil {
                ContentUnavailableView(
                    "Hier nichts von euch",
                    systemImage: "location.magnifyingglass",
                    description: Text(quietSentence
                                      ?? "Im Umkreis von fünf Kilometern liegt nichts aus eurem Vorrat."),
                )
            }

            ForEach(model.nearby) { idea in
                row(idea)
                    .swipeActions(edge: .trailing) {
                        Button {
                            Task { await model.dismissNearby(idea) }
                        } label: {
                            Label("Nicht jetzt", systemImage: "clock.badge.xmark")
                        }
                        .tint(.orange)
                    }
            }

            // Said as a number and never as a list: the count is honest
            // about what was held back, the list would be the nagging
            // the rule exists to prevent (§6.4).
            if !model.nearby.isEmpty, let sentence = quietSentence {
                Text(sentence).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("In der Nähe")
        .task { await model.loadNearby() }
        .refreshable { await model.loadNearby() }
    }

    private var quietSentence: String? {
        guard model.quietNearby > 0 else { return nil }
        return model.quietNearby == 1
            ? "Eine weitere Idee liegt hier, ist aber gerade still."
            : "\(model.quietNearby) weitere Ideen liegen hier, sind aber gerade still."
    }

    @ViewBuilder
    private func row(_ idea: TripNearIdea) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(idea.displayName)
                Spacer()
                Text(idea.distanceText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let subtitle = idea.subtitle {
                Text(subtitle).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}
