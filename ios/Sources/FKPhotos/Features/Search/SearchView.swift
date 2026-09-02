import SwiftUI

struct SearchView: View {
    @State private var viewModel = SearchViewModel()

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // Search bar
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                    TextField("Fotos suchen...", text: $viewModel.query)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                        .onSubmit {
                            Task { await viewModel.search() }
                        }
                    if !viewModel.query.isEmpty {
                        Button {
                            viewModel.clear()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
                .background(.quaternary)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)

                // What the server made of the query. Only drawn once a search
                // has actually returned something to report.
                if !viewModel.isSearching && !viewModel.chips.isEmpty {
                    SearchParseChips(chips: viewModel.chips)
                        .padding(.horizontal)
                }

                // Results
                if viewModel.isSearching {
                    ProgressView("Suche...")
                        .padding(.top, 48)
                } else if viewModel.hasSearched && viewModel.results.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Ergebnisse", systemImage: "magnifyingglass")
                    } description: {
                        Text("Keine Fotos für \"\(viewModel.query)\" gefunden.")
                    }
                } else if !viewModel.results.isEmpty {
                    Text("\(viewModel.results.count) Ergebnis(se)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)

                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(viewModel.results) { photo in
                            NavigationLink(value: photo.id) {
                                PhotoThumbnailView(filename: photo.filename)
                                    .aspectRatio(1, contentMode: .fill)
                                    .clipped()
                            }
                        }
                    }
                    .padding(.horizontal, 2)
                }
                // Nothing below the field before a search: the example
                // queries that used to sit here read as results rather than
                // as suggestions, and an empty field explains itself.

                if let error = viewModel.errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                        .padding(.horizontal)
                }
            }
        }
        .navigationTitle("Suche")
        .navigationDestination(for: Int.self) { photoId in
            PhotoDetailView(photoId: photoId)
        }
    }
}

/// The "Verstanden als:" row — the web's `NaturalSearchBar` chips, wrapped so
/// a long parse scrolls sideways instead of squeezing the labels.
struct SearchParseChips: View {
    let chips: [NaturalSearch.Chip]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Text("Verstanden als:")
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 2)
                ForEach(chips) { chip in
                    Label(chip.label, systemImage: chip.systemImage)
                        .labelStyle(.titleAndIcon)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(.quaternary, in: Capsule())
                        .italic(chip.kind == .semantic)
                }
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
