import SwiftUI

/// The popup behind a numbered pin on the day map (§8.3).
///
/// Half a screen, not a whole one: you tapped a dot on a map, so the
/// map must stay visible behind the answer. Everything in it comes from
/// `TripPinDetail`, which is where the question "what may this honestly
/// say" was settled — this file only decides where the lines sit.
struct TripPinDetailSheet: View {
    let detail: TripPinDetail
    /// "Not this one, and not next time either" (§5), from the map.
    ///
    /// Passed in rather than reached for: the sheet knows which spot
    /// was tapped and nothing about plans, and the map above it is a
    /// pure function of its inputs. Nil where nobody can act — a shared
    /// plan, a preview — and then the section is simply absent instead
    /// of a button that fails when pressed.
    var onHide: (@MainActor () async -> Void)?
    /// The stop itself, for the full detail screen. The sheet used to
    /// be a second, thinner version of it with one action; now it is
    /// the short answer with the long one a tap away.
    var stop: TripStop? = nil
    var mode: TripTransportMode = .foot

    @State private var hiding = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Wann") {
                        VStack(alignment: .trailing, spacing: 2) {
                            if let blockText = detail.blockText {
                                Text(blockText)
                            }
                            Text(detail.dwellText).foregroundStyle(.secondary)
                        }
                        .multilineTextAlignment(.trailing)
                    }
                    if let travelText = detail.travelText {
                        LabeledContent("Hinweg", value: travelText)
                    }
                    LabeledContent("Status", value: detail.statusLabel)
                    LabeledContent("Art", value: detail.category)
                }

                if detail.isPhotoStop || detail.isPinned || detail.note != nil {
                    Section {
                        if detail.isPhotoStop {
                            Label("Fotostopp — hierher kommt ihr wegen des Lichts",
                                  systemImage: "camera")
                        }
                        if detail.isPinned {
                            Label("Fester Punkt — bleibt, wo er ist", systemImage: "pin")
                        }
                        if let note = detail.note {
                            Text(note)
                        }
                    }
                }

                if let onHide {
                    Section {
                        Button(role: .destructive) {
                            hiding = true
                            Task {
                                await onHide()
                                hiding = false
                                dismiss()
                            }
                        } label: {
                            if hiding {
                                ProgressView()
                            } else {
                                Label("Für diese Reise ausblenden", systemImage: "eye.slash")
                            }
                        }
                        .disabled(hiding)
                    } footer: {
                        // The same sentence as in the pool, because it
                        // is the same "no": it holds for the whole trip
                        // and it can be taken back.
                        Text("Der Planer schlägt ihn auf dieser Reise nicht mehr vor, auch "
                             + "beim nächsten Neuplanen nicht. Rückgängig bei den Kandidaten unter "
                             + "„Ausgeblendet“.")
                    }
                }

                if let stop {
                    Section {
                        NavigationLink {
                            TripSpotDetailView(spot: TripSpotDetail(stop), mode: mode)
                        } label: {
                            Label("Alle Details", systemImage: "info.circle")
                        }
                    }
                }

                Section {
                    Button {
                        openURL(mapsURL)
                    } label: {
                        Label("In Karten öffnen", systemImage: "map")
                    }
                    if let wikipediaUrl = detail.wikipediaUrl {
                        Link(destination: wikipediaUrl) {
                            Label("Wikipedia", systemImage: "book")
                        }
                    }
                    if let sourceUrl = detail.sourceUrl {
                        Link(destination: sourceUrl) {
                            Label("Woher der Fund stammt", systemImage: "link")
                        }
                    }
                }
            }
            .navigationTitle("\(detail.number). \(detail.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
            }
            .safeAreaInset(edge: .top) {
                if let localName = detail.localName {
                    // The name on the sign, where it is not the name
                    // above: you are looking for that one when you stand
                    // in front of it (§10.4).
                    Text(localName)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                        .padding(.bottom, 4)
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    private var mapsURL: URL {
        TripPinDetail.mapsURL(for: detail)
    }
}
