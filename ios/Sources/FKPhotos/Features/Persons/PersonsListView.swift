import SwiftUI

struct PersonsListView: View {
    @State private var viewModel = PersonsViewModel()

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    private var sortedPersons: [PersonWithFaceCount] {
        viewModel.persons.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
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
                        NavigationLink(value: person.id) {
                            PersonCardView(person: person)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .navigationTitle("Personen")
        .navigationDestination(for: Int.self) { personId in
            PersonDetailView(personId: personId)
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
        }
    }
}
