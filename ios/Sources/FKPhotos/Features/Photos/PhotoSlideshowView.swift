import SwiftUI

/// Story-style full-screen slideshow over the photos of the current view — an
/// album, a selection, or the library.
///
/// Same player the recaps use (`RecapPlayerView`): auto-advancing slides with a
/// segmented progress bar, tap-left/right to seek, long-press to pause,
/// swipe-down or the X button to leave, Ken-Burns motion and a crossfade
/// between slides. Nothing but the photo is on screen; the rules are documented
/// in `docs/photo-slideshow.md`.
///
/// Unlike a recap this show has no fixed pace: it uses the interval the user
/// picked, persisted per device under `Slideshow.intervalDefaultsKey`.
struct PhotoSlideshowView: View {
    private let photos: [PhotoWithCuration]
    private let title: String
    private let subtitle: String?

    @Environment(\.dismiss) private var dismiss

    @State private var store = SlideshowImageStore()
    @State private var plan: [SlideshowSlide] = []
    @State private var playback = SlideshowPlayback()
    @State private var isPaused = false
    /// The interval chooser is open. Owned here rather than by a `Menu`,
    /// because the show has to hold still while it is up — see `isSuspended`.
    @State private var isChoosingInterval = false
    @State private var ticker: Task<Void, Never>?
    /// Consecutive ticks spent waiting for the planner; see `awaitPlan()`.
    @State private var stalledTicks = 0
    @State private var screen: ScreenOrientation = .portrait

    /// Local heart toggles (photo id → status) shadowing the fetched
    /// curation_status; rolled back if the PATCH fails.
    @State private var curationOverrides: [Int: CurationStatus] = [:]
    @State private var favoriteBusy = false

    /// Background music, the same player the recaps use. An album has no
    /// server-suggested track, so the show reuses whatever the user last
    /// picked and otherwise starts at the top of the list.
    @State private var music: SlideshowMusic

    @AppStorage(Slideshow.intervalDefaultsKey)
    private var intervalSeconds: Double = Slideshow.defaultInterval
    @AppStorage(Slideshow.musicMutedDefaultsKey)
    private var musicMuted: Bool = false
    @AppStorage(Slideshow.musicTrackDefaultsKey)
    private var musicTrackId: String = ""

    private let tickStep: Double = 0.05
    /// How long the ticker holds out for a photo that would let the planner
    /// decide a pairing, before showing what it has as a single slide.
    private let planStallGrace: Double = 2.0
    /// How many photos beyond the current slide are fetched ahead of time.
    /// Also what keeps pairing decidable: the planner needs the *next* photo's
    /// size before it can pair the current one.
    private let prefetchAhead = 3

    /// - Parameter startIndex: the photo the show begins with. Everything
    ///   before it is left out — starting a slideshow from the photo on screen
    ///   means "play on from here", not "play the whole album".
    init(
        photos: [PhotoWithCuration],
        startIndex: Int = 0,
        title: String = "",
        subtitle: String? = nil
    ) {
        let start = min(max(startIndex, 0), max(0, photos.count - 1))
        self.photos = photos.isEmpty ? [] : Array(photos[start...])
        self.title = title
        self.subtitle = subtitle
        // @AppStorage is not readable this early, so seed from UserDefaults.
        _music = State(initialValue: SlideshowMusic(muted: Slideshow.storedMusicMuted()))
    }

    // MARK: - Derived state

    private var interval: TimeInterval {
        Slideshow.normalizedInterval(intervalSeconds)
    }

    /// Whether the show is standing still — held by a finger, or by the
    /// interval chooser being open.
    ///
    /// The chooser has to stop the ticker, not just look nice doing it. The
    /// ticker rewrites `playback` twenty times a second, and every write
    /// rebuilds this view; a chooser presented from a view churning that fast
    /// loses the taps on its own rows, which is exactly how the old `Menu`
    /// behaved. A `Menu` has no "is open" state to read, so there was nothing
    /// to hang the pause on — hence a presentation this view owns.
    private var isSuspended: Bool { isPaused || isChoosingInterval }

    /// True once every photo has been assigned to a slide — only then does
    /// running off the last slide mean the show is over.
    private var planComplete: Bool {
        SlideshowPlanner.plannedPhotoCount(plan) >= photos.count
    }

    private var currentSlide: SlideshowSlide? {
        playback.currentSlide(in: plan)
    }

    private func frames(for slide: SlideshowSlide) -> [SlideshowFrame] {
        slide.photoIndices.map { index in
            SlideshowFrame(
                id: photos[index].id,
                image: store.images[index],
                failed: store.failed.contains(index),
                focal: photos[index].auto_crop.map { CGPoint(x: $0.x, y: $0.y) }
            )
        }
    }

    /// Identity of the slide on screen. Changing it is what triggers the
    /// crossfade / slide-in transition in `SlideshowStageView`.
    private func slideKey(_ slide: SlideshowSlide) -> String {
        slide.photoIndices.map { String(photos[$0].id) }.joined(separator: "+")
    }

    private func status(of photo: PhotoWithCuration) -> CurationStatus {
        curationOverrides[photo.id] ?? photo.curation_status
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if photos.isEmpty {
                emptyState
            } else {
                player
            }
        }
        .statusBarHidden(true)
        .task {
            store.reset(filenames: photos.map(\.filename))
            store.prefetch(around: 0, ahead: prefetchAhead)
            startTicker()
            guard !photos.isEmpty else { return }
            await music.start(suggestedId: Slideshow.storedMusicTrackId(musicTrackId))
        }
        .onDisappear {
            ticker?.cancel()
            music.stop()
        }
        .onChange(of: isSuspended) { _, suspended in
            music.setPaused(suspended)
        }
        // Both choices are the user's, and they outlive this one show.
        .onChange(of: music.isMuted) { _, muted in musicMuted = muted }
        .onChange(of: music.currentTrack?.id) { _, id in
            if let id { musicTrackId = id }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Text("Hier gibt es nichts abzuspielen.")
                .foregroundStyle(.white)
            Button("Schließen") { dismiss() }.tint(.white)
        }
        .padding()
    }

    private var player: some View {
        GeometryReader { geo in
            let orientation = ScreenOrientation(size: geo.size)
            // The reader ignores the safe area so the photo is full-bleed;
            // the chrome has to be put back inside it by hand.
            let chrome = SlideshowChromeInsets(safeArea: geo.safeAreaInsets)
            ZStack(alignment: .top) {
                Group {
                    if let slide = currentSlide {
                        SlideshowStageView(
                            frames: frames(for: slide),
                            screen: orientation,
                            duration: interval + 1.0
                        )
                        .id(slideKey(slide))
                    } else {
                        ProgressView().tint(.white)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .clipped()

                // Tap zones: left third = back, right two-thirds = forward.
                HStack(spacing: 0) {
                    Color.clear
                        .frame(width: geo.size.width / 3)
                        .contentShape(Rectangle())
                        .onTapGesture { playback.previous() }
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture { goNext() }
                }

                topOverlay(chrome)

                caption
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, 92 + chrome.bottom)

                favoriteButton
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(.trailing, 16 + chrome.trailing)
                    .padding(.bottom, 28 + chrome.bottom)
            }
            // Pin the player to the screen. A `ZStack` grows to its widest
            // child, so an overlay that cannot fit — the progress strip, once —
            // would otherwise drag the photo out of the frame with it.
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            .clipped()
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onEnded { value in
                        if value.translation.height > 80 { dismiss() }
                    }
            )
            .onLongPressGesture(minimumDuration: 0.2, pressing: { pressing in
                isPaused = pressing
            }, perform: {})
            .onAppear {
                screen = orientation
                extendPlan()
            }
            .onChange(of: orientation) { _, new in
                screen = new
                replanForOrientationChange()
            }
        }
        .ignoresSafeArea()
        // Newly arrived images unlock pairing decisions for the photos after
        // the one on screen, so the plan grows as the show runs.
        .onChange(of: store.images.count) { _, _ in extendPlan() }
        .onChange(of: store.failed.count) { _, _ in extendPlan() }
        .onChange(of: playback.slideIndex) { _, _ in
            if let slide = currentSlide {
                store.prefetch(around: slide.first, ahead: prefetchAhead)
            }
        }
    }

    // MARK: - Overlays

    private func topOverlay(_ chrome: SlideshowChromeInsets) -> some View {
        VStack(spacing: 8) {
            SlideshowProgressTrack(
                photoCount: photos.count,
                fill: { playback.fillFraction(forPhotoAt: $0, plan: plan) },
                overall: playback.overallFraction(
                    plan: plan,
                    photoCount: photos.count
                )
            )

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    if !title.isEmpty {
                        Text(title)
                            .font(.headline)
                            .foregroundStyle(.white)
                            .lineLimit(1)
                    }
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(1)
                    }
                }
                Spacer()
                Button { isChoosingInterval = true } label: {
                    Image(systemName: "timer")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .padding(8)
                }
                .accessibilityLabel("Intervall")
                .confirmationDialog(
                    "Bildwechsel",
                    isPresented: $isChoosingInterval,
                    titleVisibility: .visible
                ) {
                    ForEach(Slideshow.intervalOptions, id: \.self) { option in
                        Button(Slideshow.label(for: option, current: intervalSeconds)) {
                            intervalSeconds = option
                        }
                    }
                    Button("Abbrechen", role: .cancel) {}
                }

                if music.isPlaying {
                    Button { music.toggleMuted() } label: {
                        Image(systemName: music.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .padding(8)
                    }
                    .accessibilityLabel(music.isMuted ? "Musik einschalten" : "Musik stummschalten")
                }
                if music.canChangeTrack {
                    Button { music.next() } label: {
                        Image(systemName: "forward.fill")
                            .font(.headline)
                            .foregroundStyle(.white)
                            .padding(8)
                    }
                    .accessibilityLabel("Andere Musik")
                }

                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .padding(8)
                }
                .accessibilityLabel("Schließen")
            }
        }
        .padding(.leading, chrome.leading)
        .padding(.trailing, chrome.trailing)
        .padding(.top, chrome.top)
        .background(
            LinearGradient(
                colors: [.black.opacity(0.55), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        )
    }

    /// Description of the photo on screen. On a pair the first one that has a
    /// description wins — two captions would fight for the same strip.
    @ViewBuilder
    private var caption: some View {
        if let slide = currentSlide,
           let text = slide.photoIndices
            .compactMap({ Slideshow.caption(photos[$0].description) })
            .first {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.white)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.black.opacity(0.6), in: Capsule())
                .padding(.horizontal, 24)
                // Never swallow a tap meant for the photo underneath.
                .allowsHitTesting(false)
        }
    }

    /// Marks everything on the current slide as a favourite — on a pair both
    /// photos, since the tap means "this, on screen, now".
    private var favoriteButton: some View {
        let slidePhotos = (currentSlide?.photoIndices ?? []).map { photos[$0] }
        let allFavorite = !slidePhotos.isEmpty
            && slidePhotos.allSatisfy { status(of: $0) == .favorite }
        return Button { toggleFavorite(allFavorite: allFavorite) } label: {
            Image(systemName: allFavorite ? "heart.fill" : "heart")
                .font(.title2)
                .foregroundStyle(allFavorite ? .red : .white)
                .padding(12)
                .background(.black.opacity(0.45), in: Circle())
        }
        .disabled(favoriteBusy || slidePhotos.isEmpty)
        .accessibilityLabel(allFavorite ? "Favorit entfernen" : "Als Favorit markieren")
    }

    private func toggleFavorite(allFavorite: Bool) {
        guard let slide = currentSlide, !favoriteBusy else { return }
        let targets = slide.photoIndices.map { photos[$0] }
        let next: CurationStatus = allFavorite ? .visible : .favorite
        let previous = targets.map { status(of: $0) }
        for photo in targets { curationOverrides[photo.id] = next }
        favoriteBusy = true
        Task { @MainActor in
            defer { favoriteBusy = false }
            struct Body: Encodable { let status: CurationStatus }
            struct Response: Decodable { let success: Bool }
            for (photo, old) in zip(targets, previous) {
                do {
                    let _: Response = try await APIClient.shared.patch(
                        "/photos/\(photo.id)/curation",
                        body: Body(status: next)
                    )
                } catch {
                    curationOverrides[photo.id] = old
                }
            }
        }
    }

    // MARK: - Planning

    /// Commit slides for the photos whose shape is now known. `force` also
    /// commits an undecidable photo as a single slide, which is what breaks a
    /// stall when a download is slow.
    private func extendPlan(force: Bool = false) {
        let extended = SlideshowPlanner.extend(
            plan: plan,
            orientations: store.orientations,
            screen: screen,
            force: force
        )
        if extended != plan { plan = extended }
    }

    /// Turning the phone changes which photos are worth pairing. Slides already
    /// shown keep their numbering — only the unplayed tail is rebuilt.
    private func replanForOrientationChange() {
        let keep = min(playback.slideIndex + 1, plan.count)
        plan = Array(plan.prefix(keep))
        extendPlan()
    }

    /// Counts a tick spent waiting for the planner and reports whether the wait
    /// has gone on long enough to stop holding out for a pairing partner.
    private func awaitPlan() -> Bool {
        stalledTicks += 1
        guard Double(stalledTicks) * tickStep >= planStallGrace else { return false }
        stalledTicks = 0
        return true
    }

    // MARK: - Playback control

    private func startTicker() {
        ticker?.cancel()
        ticker = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(tickStep))
                if Task.isCancelled { return }
                if isSuspended { continue }

                guard let slide = currentSlide else {
                    // Nothing planned to show yet. Planning waits for the next
                    // photo's size before it can pair the current one, so give
                    // that a moment before falling back to a single slide.
                    extendPlan()
                    if awaitPlan() { extendPlan(force: true) }
                    continue
                }
                // Buffering gate: hold progress while a photo of this slide is
                // still downloading, so it gets its full screen time once it
                // appears (failed photos count as settled and advance).
                guard slide.photoIndices.allSatisfy({ store.isSettled($0) }) else { continue }

                playback.tick(
                    delta: tickStep,
                    perSlide: interval,
                    slideCount: plan.count,
                    planComplete: planComplete
                )
                if playback.finished {
                    dismiss()
                    return
                }
                // Parked at the end of the planned slides with photos left:
                // the plan has to give, or the show would hang here.
                if playback.progress >= 1 && !planComplete {
                    if awaitPlan() { extendPlan(force: true) }
                } else {
                    stalledTicks = 0
                }
            }
        }
    }

    private func goNext() {
        if !planComplete { extendPlan(force: true) }
        playback.next(slideCount: plan.count, planComplete: planComplete)
        if playback.finished { dismiss() }
    }
}
