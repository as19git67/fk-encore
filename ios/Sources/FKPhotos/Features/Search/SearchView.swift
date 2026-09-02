import SwiftUI

/// Searching the photo library.
///
/// The field is the system one (`.searchable`) rather than a hand-built row:
/// it puts the magnifier inside the field where iOS expects it, and brings the
/// clear button, the „Abbrechen" button and the collapse-on-scroll behaviour
/// with it — three things the hand-built version either lacked or had to
/// reimplement.
struct SearchView: View {
    @State private var viewModel = SearchViewModel()

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
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
                        Text("Keine Fotos für „\(viewModel.parsedQuery)“ gefunden.")
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
                                PhotoThumbnailView(filename: photo.filename, photoId: photo.id)
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
        .searchable(
            text: $viewModel.query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Fotos suchen"
        )
        #if os(iOS)
        .textInputAutocapitalization(.never)
        #endif
        .autocorrectionDisabled()
        // The search runs on submit, not per keystroke: every query is a
        // round trip through the embedding service, and searching for each
        // half-typed word would spend that on nothing.
        .onSubmit(of: .search) {
            Task { await viewModel.search() }
        }
        // Clearing the field (its own × button, or „Abbrechen") empties the
        // results with it. Without this the grid would keep showing hits for
        // a query no longer on screen.
        .onChange(of: viewModel.query) { _, text in
            if text.isEmpty { viewModel.clear() }
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
