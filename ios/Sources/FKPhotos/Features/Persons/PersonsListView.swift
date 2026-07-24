import SwiftUI

/// Typed navigation value for a person. Deliberately not a raw `Int`: since
/// Etappe 1a the Personen-Grid is pushed inside the "Alben" NavigationStack,
/// which already registers `navigationDestination(for: Int.self)` for album
/// IDs. A raw `Int` person link would resolve to `AlbumDetailView` instead of
/// `PersonDetailView`. Wrapping the id keeps the two destinations distinct.
struct PersonRef: Hashable {
    let id: Int
}

/// Navigation value that opens the Personen-Grid as a special "album" entry
/// from `AlbumsListView` (alongside „Alle Fotos" and „iOS Mediathek").
struct PersonsRef: Hashable {}

struct PersonsListView: View {
    @State private var viewModel = PersonsViewModel()

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    private var sortedPersons: [PersonWithFaceCount] {
        viewModel.persons
            .filter { $0.faceCount > 1 }
            .sorted {
                let aUnnamed = $0.name == "Unbenannt"
                let bUnnamed = $1.name == "Unbenannt"
                if aUnnamed != bUnnamed { return bUnnamed }
                return $0.faceCount > $1.faceCount
            }
    }

    var body: some View {
        ScrollView {
            if viewModel.isLoading && viewModel.persons.isEmpty {
                ProgressView()
                    .padding(.top, 100)
            } else if viewModel.persons.isEmpty {
                ContentUnavailableView {
                    Label("Keine Personen", systemImage: "person.2")
                } description: {
                    Text("Personen werden automatisch erkannt.")
                }
            } else {
                LazyVGrid(columns: columns, spacing: 8) {
                    ForEach(sortedPersons) { person in
                        NavigationLink(value: PersonRef(id: person.id)) {
                            PersonCardView(person: person)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .navigationTitle("Personen")
        .navigationDestination(for: PersonRef.self) { ref in
            PersonDetailView(personId: ref.id)
        }
        .refreshable {
            await viewModel.loadPersons()
        }
        .task {
            await viewModel.loadPersons()
        }
    }
}

struct PersonCardView: View {
    let person: PersonWithFaceCount

    var body: some View {
        VStack(spacing: 4) {
            if let filename = person.cover_filename {
                PhotoThumbnailView(filename: filename)
            } else {
                Color(.quaternarySystemFill)
                    .aspectRatio(1, contentMode: .fill)
                    .overlay {
                        Image(systemName: "person.fill")
                            .font(.title)
                            .foregroundStyle(.secondary)
                    }
                    .clipped()
            }

            Text(person.name.isEmpty ? "Unbekannt" : person.name)
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(.primary)
                .padding(.horizontal, 2)

            Text("\(person.faceCount) Fotos")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 2)
        }
    }
}
