import SwiftUI

/// Anonymized opinion counters drawn over a thumbnail in a shared album
/// (issue #760). Mirrors the web grid: a heart with "3/5" for favorites and an
/// eye-slash with the hide count, the latter only once somebody actually hid
/// the photo so a clean album stays visually quiet.
///
/// Deliberately shows counts, never names — the whole point of the feature is
/// that you see "2 von 4 haben es ausgeblendet", not "Max hat dein Foto
/// ausgeblendet" (see `docs/album-photo-views.md`).
struct CurationStatsBadges: View {
    let stats: PhotoCurationStats

    var body: some View {
        if stats.hasSignal {
            HStack(spacing: 4) {
                if stats.favCount > 0 {
                    badge(
                        systemImage: "heart.fill",
                        text: countText(stats.favCount),
                        tint: .pink
                    )
                }
                if stats.hideCount > 0 {
                    badge(
                        systemImage: "eye.slash.fill",
                        text: countText(stats.hideCount),
                        tint: .secondary
                    )
                }
            }
            .padding(4)
        }
    }

    /// "3/5" when the participant count is known, otherwise a bare "3".
    private func countText(_ value: Int) -> String {
        stats.memberCount > 0 ? "\(value)/\(stats.memberCount)" : "\(value)"
    }

    private func badge(systemImage: String, text: String, tint: Color) -> some View {
        HStack(spacing: 2) {
            Image(systemName: systemImage)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(tint)
            Text(text)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(.ultraThinMaterial, in: Capsule())
    }
}

/// The "Meinungen" block from the web's photo detail sidebar: how many
/// participants favorited or hid this photo, as share-of-group bars.
///
/// The AI quality score is deliberately *not* part of this block — the
/// fullscreen viewer already renders it under "Bewertung", and the AI's vote
/// is anonymized into these counters anyway (it is counted as an ordinary
/// participant, see `docs/album-photo-views.md`).
struct OpinionsSection: View {
    let stats: PhotoCurationStats

    /// Nobody has voted yet — callers use this to skip the section header too.
    static func isEmpty(_ stats: PhotoCurationStats?) -> Bool {
        guard let stats else { return true }
        return !stats.hasSignal || stats.memberCount == 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            opinionRow(
                label: "Favorisiert",
                systemImage: "heart.fill",
                tint: .pink,
                count: stats.favCount,
                total: stats.memberCount
            )
            if stats.hideCount > 0 {
                opinionRow(
                    label: "Ausgeblendet",
                    systemImage: "eye.slash.fill",
                    tint: .secondary,
                    count: stats.hideCount,
                    total: stats.memberCount
                )
            }
            Text("Anonymisiert – wer wie entschieden hat, ist nicht sichtbar.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func opinionRow(
        label: String,
        systemImage: String,
        tint: Color,
        count: Int,
        total: Int
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(label, systemImage: systemImage)
                    .font(.subheadline)
                    .foregroundStyle(tint == .secondary ? Color.secondary : tint)
                Spacer()
                Text("\(count) von \(total)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            ProgressView(value: Double(count), total: Double(max(1, total)))
                .tint(tint)
        }
    }
}

/// Stepper sheet behind `AlbumViewMode.custom`. Two thresholds are enough to
/// express every preset the backend knows, so the sheet stays a single screen
/// instead of a filter builder.
struct AlbumViewConfigSheet: View {
    @Binding var config: AlbumViewConfig
    let memberCount: Int
    let onApply: () -> Void
    @Environment(\.dismiss) private var dismiss

    private var upperBound: Int { max(1, memberCount) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper(value: $config.favMin, in: 0...upperBound) {
                        LabeledContent("Mindestens Favoriten", value: "\(config.favMin)")
                    }
                    Stepper(value: $config.hideMax, in: 0...upperBound) {
                        LabeledContent("Höchstens ausgeblendet", value: "\(config.hideMax)")
                    }
                } header: {
                    Text("Schwellenwerte")
                } footer: {
                    Text(memberCount > 0
                         ? "Dieses Album hat \(memberCount) Teilnehmende (die KI-Bewertung zählt als eine Stimme)."
                         : "Zeigt Fotos, die genügend Zustimmung und wenig Ablehnung haben.")
                }

                Section {
                    Button("Auf Gruppen-Highlights zurücksetzen") {
                        config = .default
                    }
                }
            }
            .navigationTitle("Eigene Ansicht")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Anwenden") {
                        config = config.clamped(memberCount: memberCount)
                        onApply()
                        dismiss()
                    }
                }
            }
        }
    }
}
