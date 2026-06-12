import SwiftUI

// MARK: - Timeline root (year grid or filtered flat grid)

struct PhotoTimelineView: View {
    @State private var years: [TimelineYear] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showUpload = false
    @State private var filterSort = FilterSortViewModel(persistenceKey: "photos.filterSort")

    // Used only in filtered mode
    @State private var photosVM = PhotosViewModel()
    @State private var fullscreenIndex = 0
    @State private var fullscreenNav: FullscreenNav? = nil
    @State private var scrollTarget: Int?

    private let tileColumns = [
        GridItem(.flexible(), spacing: 2),
        GridItem(.flexible(), spacing: 2),
    ]

    private let gridColumns = [
        GridItem(.adaptive(minimum: 100, maximum: 150), spacing: 2)
    ]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if filterSort.activeCount > 0 {
                    filteredContent
                } else {
                    timelineContent
                }
            }
            .onChange(of: scrollTarget) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .center) }
                scrollTarget = nil
            }
        }
        .navigationTitle("Fotos")
        .navigationDestination(item: $fullscreenNav) { _ in
            PhotoFullscreenView(photos: photosVM.photos, currentIndex: $fullscreenIndex)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                FilterSortButton(viewModel: filterSort)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showUpload = true } label: {
                    Image(systemName: "photo.badge.plus")
                }
            }
        }
        .sheet(isPresented: $filterSort.isMenuPresented) {
            FilterSortMenuView(viewModel: filterSort)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showUpload) {
            PhotoUploadView { Task { await reload() } }
        }
        .onChange(of: fullscreenNav) { _, nav in
            if nav == nil, !photosVM.photos.isEmpty {
                let idx = min(fullscreenIndex, photosVM.photos.count - 1)
                let photoId = photosVM.photos[idx].id
                Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    scrollTarget = photoId
                }
            }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .task(id: filterSort.applyToken) {
            if filterSort.activeCount > 0 {
                await photosVM.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort)
            }
        }
    }

    @ViewBuilder
    private var timelineContent: some View {
        if isLoading && years.isEmpty {
            ProgressView()
                .padding(.top, 100)
        } else if let error = errorMessage, years.isEmpty {
            ContentUnavailableView {
                Label("Fehler", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Erneut versuchen") { Task { await loadTimeline() } }
            }
        } else if years.isEmpty {
            ContentUnavailableView {
                Label("Keine Fotos", systemImage: "photo.on.rectangle.angled")
            } description: {
                Text("Lade Fotos hoch, um loszulegen.")
            }
        } else {
            LazyVGrid(columns: tileColumns, spacing: 2) {
                ForEach(years) { year in
                    NavigationLink(value: year) {
                        TimelineTileView(
                            title: String(year.year),
                            subtitle: "\(year.count) Fotos",
                            coverFilename: year.cover_filename
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var filteredContent: some View {
        if photosVM.isLoading && photosVM.photos.isEmpty {
            ProgressView("Fotos laden...")
                .padding(.top, 100)
        } else if let error = photosVM.errorMessage, photosVM.photos.isEmpty {
            ContentUnavailableView {
                Label("Fehler", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Erneut versuchen") {
                    Task { await photosVM.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort) }
                }
            }
        } else if photosVM.photos.isEmpty {
            ContentUnavailableView {
                Label("Keine Fotos", systemImage: "photo.on.rectangle.angled")
            } description: {
                Text("Keine Fotos entsprechen dem Filter.")
            }
        } else {
            LazyVGrid(columns: gridColumns, spacing: 2) {
                ForEach(photosVM.photos) { photo in
                    Button {
                        fullscreenIndex = photosVM.photos.firstIndex(where: { $0.id == photo.id }) ?? 0
                        fullscreenNav = FullscreenNav(startIndex: fullscreenIndex)
                    } label: {
                        PhotoThumbnailView(filename: photo.filename, autoCrop: photo.auto_crop)
                    }
                    .buttonStyle(.plain)
                    .id(photo.id)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func reload() async {
        await loadTimeline()
        if filterSort.activeCount > 0 {
            await photosVM.loadPhotos(filter: filterSort.appliedFilter, sort: filterSort.appliedSort)
        }
    }

    private func loadTimeline() async {
        isLoading = true
        errorMessage = nil
        do {
            let response: PhotoTimelineResponse = try await APIClient.shared.get("/photos/timeline")
            years = response.years
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private struct FullscreenNav: Hashable {
        let startIndex: Int
    }
}

// MARK: - Year detail (month grid)

struct PhotoYearView: View {
    let year: TimelineYear

    private let columns = [
        GridItem(.flexible(), spacing: 2),
        GridItem(.flexible(), spacing: 2),
    ]

    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "LLLL"
        return f
    }()

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(year.months) { month in
                    NavigationLink(value: PhotoMonthRef(year: year.year, month: month.month)) {
                        TimelineTileView(
                            title: Self.monthName(month.month),
                            subtitle: "\(month.count) Fotos",
                            coverFilename: month.cover_filename
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationTitle(String(year.year))
        .navigationBarTitleDisplayMode(.large)
    }

    private static func monthName(_ month: Int) -> String {
        var components = DateComponents()
        components.month = month
        components.day = 1
        components.year = 2000
        guard let date = Calendar.current.date(from: components) else { return "\(month)" }
        return monthFormatter.string(from: date).capitalized
    }
}

// MARK: - Shared tile

struct TimelineTileView: View {
    let title: String
    let subtitle: String
    let coverFilename: String?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let filename = coverFilename {
                PhotoThumbnailView(filename: filename)
                    .aspectRatio(1, contentMode: .fill)
            } else {
                Rectangle()
                    .fill(.quaternary)
                    .aspectRatio(1, contentMode: .fill)
                    .overlay {
                        Image(systemName: "photo.on.rectangle.angled")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                    }
            }

            // Gradient scrim
            LinearGradient(
                colors: [.clear, .black.opacity(0.6)],
                startPoint: .center,
                endPoint: .bottom
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.title2).fontWeight(.bold)
                    .foregroundStyle(.white)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.85))
            }
            .padding(10)
        }
        .clipped()
    }
}

// MARK: - Navigation value type

struct PhotoMonthRef: Hashable {
    let year: Int
    let month: Int
}

struct AllPhotosRef: Hashable {}
