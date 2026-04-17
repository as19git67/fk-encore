import SwiftUI

struct PhotoMonthGridView: View {
    let year: Int
    let month: Int

    @State private var photos: [PhotoWithCuration] = []
    @State private var curationOverrides: [Int: CurationStatus] = [:]
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var selectedIndex = 0
    @State private var isFullscreenPresented = false
    @State private var scrollTarget: Int?
    @State private var showUpload = false

    private let columns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    private static let titleFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "LLLL yyyy"
        return f
    }()

    private var title: String {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = 1
        guard let date = Calendar.current.date(from: components) else { return "\(month)/\(year)" }
        return Self.titleFormatter.string(from: date).capitalized
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if isLoading && photos.isEmpty {
                    ProgressView()
                        .padding(.top, 100)
                } else if let error = errorMessage, photos.isEmpty {
                    ContentUnavailableView {
                        Label("Fehler", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Erneut versuchen") { Task { await loadPhotos() } }
                    }
                } else if photos.isEmpty {
                    ContentUnavailableView {
                        Label("Keine Fotos", systemImage: "photo.on.rectangle.angled")
                    } description: {
                        Text("Keine Fotos in diesem Monat.")
                    }
                } else {
                    LazyVGrid(columns: columns, spacing: 2) {
                        ForEach(photos.indices, id: \.self) { index in
                            let photo = photos[index]
                            let isFav = (curationOverrides[photo.id] ?? photo.curation_status) == .favorite
                            Button {
                                selectedIndex = index
                                isFullscreenPresented = true
                            } label: {
                                PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
                                    .overlay(alignment: .bottomTrailing) {
                                        Button {
                                            toggleFavorite(photo)
                                        } label: {
                                            Image(systemName: isFav ? "heart.fill" : "heart")
                                                .font(.caption)
                                                .foregroundStyle(isFav ? Color.red : Color.white)
                                                .shadow(color: .black.opacity(0.5), radius: 1.5)
                                                .padding(5)
                                        }
                                        .buttonStyle(.plain)
                                    }
                            }
                            .buttonStyle(.plain)
                            .id(photo.id)
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }
            .onChange(of: scrollTarget) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .center) }
                scrollTarget = nil
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showUpload = true } label: {
                    Image(systemName: "photo.badge.plus")
                }
            }
        }
        .navigationDestination(isPresented: $isFullscreenPresented) {
            PhotoFullscreenView(photos: photos, currentIndex: $selectedIndex)
        }
        .onChange(of: isFullscreenPresented) { _, isPresented in
            if !isPresented, !photos.isEmpty {
                let idx = min(selectedIndex, photos.count - 1)
                let photoId = photos[idx].id
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    scrollTarget = photoId
                }
            }
        }
        .sheet(isPresented: $showUpload) {
            PhotoUploadView { Task { await loadPhotos() } }
        }
        .refreshable { await loadPhotos() }
        .task { await loadPhotos() }
    }

    private func toggleFavorite(_ photo: PhotoWithCuration) {
        let current = curationOverrides[photo.id] ?? photo.curation_status
        let next: CurationStatus = current == .favorite ? .visible : .favorite
        curationOverrides[photo.id] = next
        Task {
            struct Body: Codable { let status: CurationStatus }
            struct Response: Codable { let success: Bool }
            if (try? await APIClient.shared.patch(
                "/photos/\(photo.id)/curation",
                body: Body(status: next)
            ) as Response) == nil {
                curationOverrides[photo.id] = current
            }
        }
    }

    private func loadPhotos() async {
        isLoading = true
        errorMessage = nil
        do {
            let response: ListPhotosResponse = try await APIClient.shared.get(
                "/photos/search/date",
                query: ["year": "\(year)", "month": "\(month)"]
            )
            photos = response.photos.reversed()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
