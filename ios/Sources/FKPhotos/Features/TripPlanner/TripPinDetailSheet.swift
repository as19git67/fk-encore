import SwiftUI

/// The popup behind a numbered pin on the day map (§8.3).
///
/// Half a screen, not a whole one: you tapped a dot on a map, so the
/// map must stay visible behind the answer. Everything in it comes from
/// `TripPinDetail`, which is where the question "what may this honestly
/// say" was settled — this file only decides where the lines sit.
struct TripPinDetailSheet: View {
    let detail: TripPinDetail

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
