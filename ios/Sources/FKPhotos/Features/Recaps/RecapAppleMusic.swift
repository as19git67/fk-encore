import Foundation
import MusicKit

/// A playlist from the user's own library, offered in the recap player's
/// "Playlist wählen" sheet.
struct RecapLibraryPlaylist: Identifiable, Sendable {
    let id: String
    let name: String
}

/// Apple Music behind a recap, for users with their own subscription.
///
/// What plays is decided by `RecapAppleMusicPlan`; this class only asks
/// MusicKit. It uses `ApplicationMusicPlayer`, so the Music app's own queue
/// stays as it was. Like `SlideshowMusic`, everything fails silently: when
/// anything is missing (no access, no subscription, no network, nothing
/// found) `start` answers false and the player plays the self-hosted music.
///
/// MusicKit gives an app no volume control, so muting pauses the music and
/// there is no fade.
@MainActor
@Observable
final class RecapAppleMusic {
    /// Apple Music carries this recap; the player hides the self-hosted
    /// controls.
    private(set) var isActive = false
    private(set) var isMuted = false
    /// Where the music comes from, shown under the recap's title, e.g.
    /// "Apple Music · deine Mediathek, Juli 2023".
    private(set) var sourceLabel: String?

    private var isPaused = false
    private var player: ApplicationMusicPlayer { ApplicationMusicPlayer.shared }

    // MARK: - Access

    /// Whether the user switched Apple Music on and iOS still allows it.
    static var isUsable: Bool {
        AppleMusicPreferences.enabled && MusicAuthorization.currentStatus == .authorized
    }

    /// Ask iOS for access to Apple Music and the music library.
    static func requestAccess() async -> MusicAuthorization.Status {
        let current = MusicAuthorization.currentStatus
        if current != .notDetermined { return current }
        return await MusicAuthorization.request()
    }

    /// Whether the account may play catalog music (an active subscription).
    static func canPlayCatalog() async -> Bool {
        guard MusicAuthorization.currentStatus == .authorized else { return false }
        guard let subscription = try? await MusicSubscription.current else { return false }
        return subscription.canPlayCatalogContent
    }

    // MARK: - Start

    /// Pick and start the music for a recap. Answers false when Apple Music
    /// cannot carry it; nothing plays then.
    func start(
        recapId: Int,
        mood: RecapMusicMood?,
        periodStart: String?,
        periodEnd: String?
    ) async -> Bool {
        guard Self.isUsable, await Self.canPlayCatalog() else { return false }

        if let chosen = AppleMusicPreferences.playlistId(forRecap: recapId),
           let playlist = await libraryPlaylist(id: chosen) {
            return await play(
                ApplicationMusicPlayer.Queue(for: [playlist]),
                label: "Apple Music · \(playlist.name)"
            )
        }

        if let window = RecapAppleMusicPlan.libraryWindow(periodStart: periodStart, periodEnd: periodEnd) {
            let songs = await librarySongs(in: window)
            if !songs.isEmpty {
                let period = RecapAppleMusicPlan.periodLabel(periodStart: periodStart, periodEnd: periodEnd)
                let label = period.map { "Apple Music · deine Mediathek, \($0)" }
                    ?? "Apple Music · deine Mediathek"
                return await play(ApplicationMusicPlayer.Queue(for: songs.shuffled()), label: label)
            }
        }

        if let mood, let playlist = await moodPlaylist(mood) {
            return await play(
                ApplicationMusicPlayer.Queue(for: [playlist]),
                label: "Apple Music · \(playlist.name)"
            )
        }
        return false
    }

    /// Play a library playlist the user just chose in the player, or with nil
    /// go back to the automatic pick. The choice is kept for this recap.
    func choose(
        playlistId: String?,
        recapId: Int,
        mood: RecapMusicMood?,
        periodStart: String?,
        periodEnd: String?
    ) async -> Bool {
        AppleMusicPreferences.setPlaylistId(playlistId, forRecap: recapId)
        return await start(recapId: recapId, mood: mood, periodStart: periodStart, periodEnd: periodEnd)
    }

    // MARK: - Controls

    /// "Andere Musik": the next song of the queue.
    func next() {
        guard isActive else { return }
        Task { try? await player.skipToNextEntry() }
    }

    func toggleMuted() {
        guard isActive else { return }
        isMuted.toggle()
        apply()
    }

    /// Long-press pause and sheets over the player hold the music with the
    /// slides.
    func setPaused(_ paused: Bool) {
        guard isActive else { return }
        isPaused = paused
        apply()
    }

    func stop() {
        guard isActive else { return }
        isActive = false
        sourceLabel = nil
        player.stop()
    }

    // MARK: - Library

    /// The user's library playlists, by name.
    func libraryPlaylists() async -> [RecapLibraryPlaylist] {
        guard MusicAuthorization.currentStatus == .authorized else { return [] }
        let request = MusicLibraryRequest<Playlist>()
        guard let response = try? await request.response() else { return [] }
        return response.items
            .map { RecapLibraryPlaylist(id: $0.id.rawValue, name: $0.name) }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    // MARK: - Private

    private func play(_ queue: ApplicationMusicPlayer.Queue, label: String) async -> Bool {
        player.queue = queue
        player.state.shuffleMode = .songs
        player.state.repeatMode = .all
        do {
            try await player.prepareToPlay()
            if !isMuted && !isPaused { try await player.play() }
        } catch {
            isActive = false
            sourceLabel = nil
            return false
        }
        isActive = true
        sourceLabel = label
        return true
    }

    private func apply() {
        if isMuted || isPaused {
            player.pause()
        } else {
            Task { try? await player.play() }
        }
    }

    private func libraryPlaylist(id: String) async -> Playlist? {
        var request = MusicLibraryRequest<Playlist>()
        request.filter(matching: \.id, equalTo: MusicItemID(id))
        return try? await request.response().items.first
    }

    /// Library songs added inside `window`, newest first. The library is read
    /// in batches from the newest addition backwards and stops once it is
    /// past the window, at most `maxBatches` deep.
    private func librarySongs(in window: DateInterval) async -> [Song] {
        let batchSize = 200
        let maxBatches = 50
        var request = MusicLibraryRequest<Song>()
        request.sort(by: \.libraryAddedDate, ascending: false)
        request.limit = batchSize
        guard var batch = try? await request.response().items else { return [] }
        var collected: [Song] = []
        for _ in 0..<maxBatches {
            collected.append(contentsOf: batch)
            let oldest = batch.last?.libraryAddedDate
            if let oldest, oldest < window.start { break }
            guard batch.hasNextBatch,
                  let following = try? await batch.nextBatch(limit: batchSize)
            else { break }
            batch = following
        }
        return RecapAppleMusicPlan.librarySongs(collected, addedAt: \.libraryAddedDate, in: window)
    }

    /// A playlist Apple Music curates for the mood, found by catalog search.
    private func moodPlaylist(_ mood: RecapMusicMood) async -> Playlist? {
        for term in mood.catalogSearchTerms {
            var request = MusicCatalogSearchRequest(term: term, types: [Playlist.self])
            request.limit = 10
            guard let playlists = try? await request.response().playlists else { continue }
            if let curated = playlists.first(where: { $0.curatorName == "Apple Music" }) {
                return curated
            }
            if let any = playlists.first { return any }
        }
        return nil
    }
}
