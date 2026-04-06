import SwiftUI

struct PersonsListView: View {
    @State private var viewModel = PersonsViewModel()

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 140), spacing: 12)
    ]

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
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(viewModel.persons) { person in
                        NavigationLink(value: person.id) {
                            PersonCardView(person: person)
                        }
                    }
                }
                .padding()
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
        VStack(spacing: 8) {
            // Face thumbnail
            if let coverPhotoFilename = person.cover_filename,
               let coverFaceId = person.cover_face_id {
                PhotoThumbnailView(photoId: coverFaceId)
                    .frame(width: 80, height: 80)
                    .clipShape(Circle())
                let _ = coverPhotoFilename // suppress unused
            } else {
                Circle()
                    .fill(.quaternary)
                    .frame(width: 80, height: 80)
                    .overlay {
                        Image(systemName: "person.fill")
                            .font(.title)
                            .foregroundStyle(.secondary)
                    }
            }

            Text(person.name.isEmpty ? "Unbekannt" : person.name)
                .font(.caption.bold())
                .lineLimit(1)
                .foregroundStyle(.primary)

            Text("\(person.faceCount) Fotos")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}
