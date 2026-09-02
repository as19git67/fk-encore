import CoreGraphics
import Foundation

/// Flinging a photo out of the comparison to discard it.
///
/// A port of the web's `frontend/src/utils/compareSwipe.ts` (#1021, stage B).
/// Two photos are on screen and the buttons for "drop this one" are small;
/// throwing the loser off the edge is the gesture that fits a phone.
///
/// The one rule that carries the whole design: a discard fling must never
/// point **at the partner photo**. Swiping the two together reads as "shove
/// these into each other", which says nothing about which one to drop, so the
/// forbidden direction depends on how the pair is stacked — vertically in
/// portrait, side by side in landscape.
///
/// Pure: deltas in, a direction out.
enum CompareSwipe {

    /// How far a drag has to travel to count as a decisive fling rather than a
    /// stray finger. The web's 64 px, so both clients ask the same of a
    /// gesture.
    static let minTravel: Double = 64

    /// How long the tile takes to leave the screen before the decision lands.
    static let animationDuration: Double = 0.2

    /// How far past the edge a discarded tile is thrown, as a fraction of the
    /// screen. The web's `110vw` / `110vh`: the overshoot keeps the tile out of
    /// sight for the whole animation rather than resting exactly on the border.
    static let offscreenOvershoot: Double = 1.1

    enum Direction: String, Sendable {
        case left, right, up, down
    }

    /// The direction pointing at the other photo of the pair — the one a
    /// discard must not go.
    ///
    /// Portrait stacks the pair, so the first photo's partner is below it;
    /// landscape puts them side by side, so it is to its right.
    static func partnerDirection(indexInPair: Int, isPortrait: Bool) -> Direction {
        if isPortrait { return indexInPair == 0 ? .down : .up }
        return indexInPair == 0 ? .right : .left
    }

    /// The dominant direction of a drag, or nil when it was too short to mean
    /// anything.
    ///
    /// A diagonal is resolved to whichever axis moved further; a perfect
    /// diagonal counts as horizontal, matching the web.
    static func flingDirection(dx: Double, dy: Double, minTravel: Double = minTravel) -> Direction? {
        guard dx.isFinite, dy.isFinite else { return nil }
        let absX = abs(dx)
        let absY = abs(dy)
        guard max(absX, absY) >= minTravel else { return nil }
        if absX >= absY { return dx < 0 ? .left : .right }
        return dy < 0 ? .up : .down
    }

    /// The direction to discard the photo at `indexInPair`, or nil when the
    /// gesture is not a discard — too short, or aimed at the partner.
    static func discardDirection(
        indexInPair: Int,
        isPortrait: Bool,
        dx: Double,
        dy: Double,
        minTravel: Double = minTravel
    ) -> Direction? {
        guard let direction = flingDirection(dx: dx, dy: dy, minTravel: minTravel) else {
            return nil
        }
        guard direction != partnerDirection(indexInPair: indexInPair, isPortrait: isPortrait) else {
            return nil
        }
        return direction
    }

    /// The offset that carries a tile off the screen in the given direction.
    ///
    /// Measured against the **screen**, not the pane: a pane is half the
    /// screen, so a pane-sized throw would leave the tile sitting in the other
    /// half.
    static func offscreenOffset(_ direction: Direction, screen: CGSize) -> CGSize {
        let width = Double(screen.width) * offscreenOvershoot
        let height = Double(screen.height) * offscreenOvershoot
        switch direction {
        case .left: return CGSize(width: -width, height: 0)
        case .right: return CGSize(width: width, height: 0)
        case .up: return CGSize(width: 0, height: -height)
        case .down: return CGSize(width: 0, height: height)
        }
    }
}
