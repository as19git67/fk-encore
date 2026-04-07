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
                            viewModel.query = ""
                            viewModel.results = []
                            viewModel.hasSearched = false
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
                } else {
                    // Search suggestions
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Suchvorschläge")
                            .font(.headline)
                            .padding(.horizontal)

                        SearchSuggestionButton(icon: "text.magnifyingglass", label: "Natürliche Sprache") {
                            viewModel.query = "Sonnenuntergang am Meer"
                            Task { await viewModel.search() }
                        }
                        SearchSuggestionButton(icon: "mappin", label: "Nach Ort suchen") {
                            viewModel.query = "Zürich"
                            Task { await viewModel.search() }
                        }
                        SearchSuggestionButton(icon: "building.columns", label: "Sehenswürdigkeiten") {
                            viewModel.query = "Eiffelturm"
                            Task { await viewModel.search() }
                        }
                    }
                    .padding(.top, 24)
                }

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

struct SearchSuggestionButton: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .frame(width: 24)
                    .foregroundStyle(.blue)
                Text(label)
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }
}
