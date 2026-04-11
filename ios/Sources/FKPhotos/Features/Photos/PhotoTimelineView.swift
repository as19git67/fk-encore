import SwiftUI

// MARK: - Timeline root (year grid)

struct PhotoTimelineView: View {
    @State private var years: [TimelineYear] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var showUpload = false

    private let columns = [
        GridItem(.flexible(), spacing: 2),
        GridItem(.flexible(), spacing: 2),
    ]

    var body: some View {
        ScrollView {
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
                LazyVGrid(columns: columns, spacing: 2) {
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
        .navigationTitle("Fotos")
        .navigationDestination(for: TimelineYear.self) { year in
            PhotoYearView(year: year)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showUpload = true } label: {
                    Image(systemName: "photo.badge.plus")
                }
            }
        }
        .sheet(isPresented: $showUpload) {
            PhotoUploadView { Task { await loadTimeline() } }
        }
        .refreshable { await loadTimeline() }
        .task { await loadTimeline() }
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
        .navigationDestination(for: PhotoMonthRef.self) { ref in
            PhotoMonthGridView(year: ref.year, month: ref.month)
        }
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
