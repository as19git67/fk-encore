import AVFoundation
import Foundation

/// Background music for a story player, shared by the recaps and the photo
/// slideshow.
///
/// The tracks are the self-hosted recap music (`GET /recaps-music`); a recap
/// additionally arrives with one already suggested. Everything here fails
/// silently: music is never worth an error UI, and a show with no sound is
/// still a show.
@Observable
final class SlideshowMusic: @unchecked Sendable {
    /// A track is loaded and running (drives the mute / change controls).
    private(set) var isPlaying = false
    private(set) var isMuted = false
    /// The full cycle, suggested track first. More than one means the player
    /// can offer "Andere Musik".
    private(set) var tracks: [RecapMusicTrack] = []
    private(set) var currentIndex = 0

    var canChangeTrack: Bool { isPlaying && tracks.count > 1 }
    var currentTrack: RecapMusicTrack? {
        tracks.indices.contains(currentIndex) ? tracks[currentIndex] : nil
    }

    private var player: AVAudioPlayer?
    private let volume: Float

    init(volume: Float = 0.55, muted: Bool = false) {
        self.volume = volume
        self.isMuted = muted
    }

    /// Order the track list so `suggestedId` leads, enabling a wrap-around
    /// cycle. Mirrors the web player's `orderedTrackCycle`. An unknown id —
    /// including the slideshow's "no suggestion" case — leaves the server's
    /// own order intact.
    static func orderedCycle(
        _ tracks: [RecapMusicTrack],
        suggestedId: String?
    ) -> [RecapMusicTrack] {
        guard !tracks.isEmpty else { return [] }
        let start = suggestedId
            .flatMap { id in tracks.firstIndex(where: { $0.id == id }) } ?? 0
        return Array(tracks[start...] + tracks[..<start])
    }

    /// Fetch the cycle and start playing.
    ///
    /// - Parameters:
    ///   - suggestedId: the track to lead the cycle — the recap's own
    ///     suggestion, or for the slideshow the one the user last chose. An
    ///     id no longer on the server simply loses its priority.
    ///   - fallback: played if the list cannot be fetched. A recap already
    ///     holds its suggested track and should not go silent over a failed
    ///     list request; the slideshow has nothing to fall back to.
    @MainActor
    func start(suggestedId: String?, fallback: RecapMusicTrack? = nil) async {
        // Play the caller's own track first. Waiting for the list would leave
        // a recap silent for a round trip it already has the answer to, and a
        // failed list then leaves it with music rather than nothing.
        if let fallback {
            tracks = [fallback]
            currentIndex = 0
            await play(fallback)
        }

        let resp: RecapMusicListResponse? = try? await APIClient.shared.get("/recaps-music")
        let cycle = Self.orderedCycle(resp?.tracks ?? [], suggestedId: suggestedId)
        guard let first = cycle.first else { return }
        tracks = cycle
        currentIndex = 0
        // The fallback already leads the cycle when there was one, so this
        // only fires when nothing is playing yet — no track, or a failed
        // download.
        if !isPlaying { await play(first) }
    }

    /// Step to the next track, wrapping back to the first. Fades the old
    /// player out without deactivating the session so the new track can take
    /// over seamlessly.
    @MainActor
    func next() {
        guard tracks.count > 1 else { return }
        currentIndex = (currentIndex + 1) % tracks.count
        let track = tracks[currentIndex]
        fadeOutCurrent()
        Task { await play(track) }
    }

    func toggleMuted() {
        isMuted.toggle()
        player?.setVolume(isMuted ? 0 : volume, fadeDuration: 0.3)
    }

    /// Long-press pause: holds the music with the slides rather than
    /// restarting it.
    func setPaused(_ paused: Bool) {
        guard let player else { return }
        if paused { player.pause() } else { player.play() }
    }

    func stop() {
        guard let player else { return }
        self.player = nil
        isPlaying = false
        player.setVolume(0, fadeDuration: 0.3)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            player.stop()
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
        }
    }

    /// Download the track and loop it behind the slides, fading in.
    @MainActor
    private func play(_ track: RecapMusicTrack) async {
        do {
            // `track.id` is the raw "<mood>/<filename>" pair; APIClient
            // percent-encodes paths itself, so don't use the pre-encoded url.
            let data = try await APIClient.shared.downloadData("/recaps-music/file/\(track.id)")
            let loaded = try AVAudioPlayer(data: data)
            loaded.numberOfLoops = -1
            loaded.volume = 0
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            try? AVAudioSession.sharedInstance().setActive(true)
            guard !Task.isCancelled else { return }
            loaded.play()
            loaded.setVolume(isMuted ? 0 : volume, fadeDuration: 1.5)
            player = loaded
            isPlaying = true
        } catch {
            // Silent show — intentionally no error surface.
        }
    }

    private func fadeOutCurrent() {
        guard let old = player else { return }
        player = nil
        old.setVolume(0, fadeDuration: 0.3)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { old.stop() }
    }
}
