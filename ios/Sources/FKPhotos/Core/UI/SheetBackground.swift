import SwiftUI

extension View {
    /// Gives a sheet the same solid background at every height.
    ///
    /// From iOS 26 the system draws a sheet at a partial detent
    /// (`.medium`) as translucent glass and turns it opaque only at
    /// `.large`, so the same sheet changed colour while it was pulled up
    /// and the content behind it showed through at half height. Every
    /// sheet with a partial detent calls this next to its
    /// `presentationDetents`, so half and full look alike.
    func opaqueSheetBackground() -> some View {
        presentationBackground(Color(uiColor: .systemBackground))
    }
}
