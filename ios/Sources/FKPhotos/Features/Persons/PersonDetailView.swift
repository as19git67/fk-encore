import SwiftUI

struct PersonDetailView: View {
    let personId: Int
    @State private var person: Person?
    @State private var photos: [PhotoWithCuration] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollView {
            if isLoading {
                ProgressView()
                    .padding(.top, 100)
            } else if photos.isEmpty {
                ContentUnavailableView {
                    Label("Keine Fotos", systemImage: "person.crop.rectangle")
                } description: {
                    Text("Keine Fotos für diese Person gefunden.")
                }
            } else {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(photos) { photo in
                        NavigationLink(value: photo.id) {
                            PhotoThumbnailView(photoId: photo.id)
                                .aspectRatio(1, contentMode: .fill)
                                .clipped()
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .navigationTitle(person?.name ?? "Person")
        .navigationBarTitleDisplayMode(.large)
        .navigationDestination(for: Int.self) { photoId in
            PhotoDetailView(photoId: photoId)
        }
        .task {
            await loadPerson()
        }
    }

    private func loadPerson() async {
        isLoading = true
        do {
            struct PersonResponse: Codable {
                let id: Int
                let name: String
                let photos: [PhotoWithCuration]?
            }
            let response: PersonResponse = try await APIClient.shared.get("/persons/\(personId)")
            person = Person(
                id: response.id,
                user_id: 0,
                name: response.name,
                cover_face_id: nil,
                cover_filename: nil,
                cover_bbox: nil,
                created_at: "",
                updated_at: ""
            )
            photos = response.photos ?? []
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
