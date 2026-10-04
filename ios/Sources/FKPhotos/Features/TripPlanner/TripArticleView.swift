import SwiftUI

/// The article behind a spot, read in the app (§25, stage C).
///
/// "Artikel lesen" used to open Safari, and where the article was
/// Italian the footer said so and left the reading to iOS. Now the
/// text comes from the server: the German article where one exists,
/// otherwise the local one with a translation by the llm-service that
/// takes a while on a local model — so the original is shown first,
/// marked as such, and the screen asks again until the translation is
/// there. The pictures come the way a route's do (§4.7): a strip at
/// the top, each with whose it is.
///
/// Said every time, at the bottom: Wikipedia, the licence, and that a
/// translation is a machine's.
struct TripArticleView: View {
    let url: URL
    /// What the row called the place, as the title while the article loads.
    var placeName: String? = nil

    @State private var article: TripSpotArticle?
    @State private var errorMessage: String?
    @State private var isLoading = true
    @State private var shownPhoto: TripRoutePhoto?

    /// How often to ask while the translation runs, and for how long.
    private static let pollSeconds: UInt64 = 6
    private static let pollRounds = 40

    var body: some View {
        Group {
            if let article {
                content(article)
            } else if isLoading {
                ProgressView("Artikel wird geladen …")
            } else {
                ContentUnavailableView(
                    "Kein Artikel",
                    systemImage: "book.closed",
                    description: Text(errorMessage ?? "Zu diesem Ort gibt es keinen Artikel."),
                )
            }
        }
        .navigationTitle(article?.title ?? placeName ?? "Wikipedia")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Link(destination: article.flatMap { URL(string: $0.sourceUrl) } ?? url) {
                    Label("Auf Wikipedia öffnen", systemImage: "safari")
                }
            }
        }
        .sheet(item: $shownPhoto) { photo in
            TripRoutePhotoView(photo: photo)
        }
        .task { await load() }
    }

    private func content(_ article: TripSpotArticle) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !article.photos.isEmpty {
                    photoStrip(article.photos)
                }
                VStack(alignment: .leading, spacing: 12) {
                    if let description = article.description {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    translationBanner(article)
                    ForEach(article.sections) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            if let heading = section.heading {
                                Text(heading)
                                    .font(section.level <= 2 ? .title3.weight(.semibold) : .headline)
                                    .padding(.top, section.level <= 2 ? 8 : 2)
                            }
                            Text(section.text)
                                .font(.body)
                                .textSelection(.enabled)
                        }
                    }
                    if article.truncated, let source = URL(string: article.sourceUrl) {
                        Link(destination: source) {
                            Label("Weiterlesen auf Wikipedia", systemImage: "arrow.up.right.square")
                        }
                        .padding(.top, 4)
                    }
                    attribution(article)
                }
                .padding(.horizontal)
            }
            .padding(.vertical)
        }
    }

    /// Where the text stands with its language: the original while
    /// the translation runs, the original when it failed, and nothing
    /// at all for a German article, which needs no excuse.
    @ViewBuilder
    private func translationBanner(_ article: TripSpotArticle) -> some View {
        if article.isPending {
            HStack(spacing: 8) {
                ProgressView()
                Text("Übersetzung läuft — bis dahin der Artikel auf "
                     + "\(languageName(article.sourceLanguage)).")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 10))
        } else if article.translationFailed {
            Label("Die Übersetzung ist gerade nicht möglich — der Artikel auf "
                  + "\(languageName(article.sourceLanguage)). Auf Wikipedia bietet iOS „Übersetzen“ an.",
                  systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: 10))
        }
    }

    private func attribution(_ article: TripSpotArticle) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Divider().padding(.vertical, 6)
            Text(article.isTranslated
                 ? "\(article.attribution) · maschinell übersetzt aus dem "
                   + "\(languageName(article.sourceLanguage, dative: true)) durch den eigenen KI-Dienst"
                 : article.attribution)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("Text und Bilder unter \(article.license); Fotos mit ihren Urhebern am Bild.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func photoStrip(_ photos: [TripRoutePhoto]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 10) {
                ForEach(photos) { photo in
                    Button {
                        shownPhoto = photo
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            AsyncImage(url: URL(string: photo.thumbUrl)) { phase in
                                switch phase {
                                case .success(let image):
                                    image.resizable().scaledToFill()
                                case .failure:
                                    Image(systemName: "photo")
                                        .foregroundStyle(.secondary)
                                default:
                                    ProgressView()
                                }
                            }
                            .frame(width: 220, height: 160)
                            .background(.quaternary)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            Text(photo.credit)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .frame(width: 220, alignment: .leading)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Bild aus dem Artikel")
                }
            }
            .padding(.horizontal, 16)
        }
        .frame(height: 186)
    }

    /// "Italienisch" for "it" — the system's word, or the code when it
    /// has none.
    private func languageName(_ code: String, dative: Bool = false) -> String {
        let name = Locale.current.localizedString(forLanguageCode: code) ?? code
        return dative ? "\(name)en" : name
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            var current: TripSpotArticle = try await fetch()
            article = current
            // A translation under way: ask again, quietly, until it is
            // there or it is clear it will not be.
            var rounds = 0
            while current.isPending, rounds < Self.pollRounds {
                try await Task.sleep(nanoseconds: Self.pollSeconds * 1_000_000_000)
                current = try await fetch()
                article = current
                rounds += 1
            }
        } catch is CancellationError {
            // Left the screen; nothing to say.
        } catch {
            if article == nil { errorMessage = TripErrorText.describe(error) }
        }
    }

    private func fetch() async throws -> TripSpotArticle {
        try await APIClient.shared.get("/trip-planner/wikipedia/article", query: ["url": url.absoluteString])
    }
}
