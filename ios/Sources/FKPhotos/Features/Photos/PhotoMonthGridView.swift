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
    @State private var isSelecting = false
    @State private var selectedIds: Set<Int> = []
    @State private var shareManager = PhotoShareManager()

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
                            PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
                                .overlay(alignment: .topLeading) {
                                    if isSelecting {
                                        SelectionCheckmark(isSelected: selectedIds.contains(photo.id))
                                            .padding(4)
                                    }
                                }
                                .overlay(alignment: .bottomTrailing) {
                                    if !isSelecting {
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
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    if isSelecting {
                                        toggleSelection(photo.id)
                                    } else {
                                        selectedIndex = index
                                        isFullscreenPresented = true
                                    }
                                }
                                .onLongPressGesture {
                                    if !isSelecting {
                                        isSelecting = true
                                        selectedIds = [photo.id]
                                    }
                                }
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
        .navigationTitle(isSelecting ? "\(selectedIds.count) ausgewählt" : title)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if isSelecting {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") {
                        isSelecting = false
                        selectedIds = []
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        let filenames = photos.filter { selectedIds.contains($0.id) }.map(\.filename)
                        Task { await shareManager.share(filenames: filenames) }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .disabled(selectedIds.isEmpty || shareManager.isLoading)
                }
            } else {
                ToolbarItem(placement: .primaryAction) {
                    Button { isSelecting = true } label: {
                        Image(systemName: "checkmark.circle")
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { showUpload = true } label: {
                        Image(systemName: "photo.badge.plus")
                    }
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
        .sheet(isPresented: $shareManager.isPresented) {
            ActivityView(images: shareManager.images)
        }
        .overlay {
            if shareManager.isLoading {
                ZStack {
                    Color.black.opacity(0.3).ignoresSafeArea()
                    ProgressView("Fotos laden…")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    private func toggleSelection(_ id: Int) {
        if selectedIds.contains(id) {
            selectedIds.remove(id)
            if selectedIds.isEmpty { isSelecting = false }
        } else {
            selectedIds.insert(id)
        }
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
