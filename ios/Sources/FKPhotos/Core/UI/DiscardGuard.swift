import SwiftUI

/// Keeps an edit sheet from losing its edits to a swipe.
///
/// A sheet in which something is changed and then saved closes only
/// through its own buttons as soon as it holds a change: a swipe down
/// does nothing, "Abbrechen" asks „Änderungen verwerfen?“ first. Without
/// a change the sheet closes as before, by swipe or by "Abbrechen".
///
/// The modifier brings the sheet's "Abbrechen" itself (the
/// `.cancellationAction` of its toolbar), so it is applied inside the
/// sheet's navigation stack and the sheet drops its own cancel button.
/// "Speichern"/"Fertig" stays the sheet's: it closes the sheet with
/// `dismiss()`, which the guard never stops.
///
/// Two ways to say what a change is:
/// - `discardGuard(hasChanges:)` when the sheet already knows
///   (a view model's `isDirty`).
/// - `discardGuard(tracking:)` with the edited values: the guard keeps
///   the values it first sees and compares. A sheet that fills its form
///   from the server passes `ready` once that is done, so filling in
///   is not taken for an edit.
///
/// A sheet that edits something that already exists hands `changed`
/// to the tracking guard and greys its "Sichern" while it is false:
/// with nothing changed there is nothing to save. A sheet that adds
/// something new leaves it out — there "Hinzufügen" depends on the
/// entry being complete, not on an edit.
extension View {
    func discardGuard(
        hasChanges: Bool,
        busy: Bool = false,
        cancelTitle: String = "Abbrechen",
        onCancel: (() -> Void)? = nil
    ) -> some View {
        modifier(DiscardGuard(hasChanges: hasChanges, busy: busy,
                              cancelTitle: cancelTitle, onCancel: onCancel))
    }

    func discardGuard<Value: Equatable>(
        tracking value: Value,
        ready: Bool = true,
        busy: Bool = false,
        changed: Binding<Bool>? = nil,
        cancelTitle: String = "Abbrechen",
        onCancel: (() -> Void)? = nil
    ) -> some View {
        modifier(TrackingDiscardGuard(value: value, ready: ready, busy: busy, changed: changed,
                                      cancelTitle: cancelTitle, onCancel: onCancel))
    }
}

private struct DiscardGuard: ViewModifier {
    let hasChanges: Bool
    let busy: Bool
    let cancelTitle: String
    let onCancel: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    func body(content: Content) -> some View {
        content
            // While saving the sheet stays too: closing it then would
            // leave the save without a place to show its error.
            .interactiveDismissDisabled(hasChanges || busy)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(cancelTitle) {
                        if hasChanges { confirming = true } else { cancel() }
                    }
                    // On the button, so an iPad anchors the question there.
                    .confirmationDialog("Änderungen verwerfen?", isPresented: $confirming,
                                        titleVisibility: .visible) {
                        Button("Verwerfen", role: .destructive) { cancel() }
                        Button("Weiter bearbeiten", role: .cancel) {}
                    }
                }
            }
    }

    private func cancel() {
        if let onCancel { onCancel() } else { dismiss() }
    }
}

private struct TrackingDiscardGuard<Value: Equatable>: ViewModifier {
    let value: Value
    let ready: Bool
    let busy: Bool
    let changed: Binding<Bool>?
    let cancelTitle: String
    let onCancel: (() -> Void)?

    /// The values when the sheet was ready; nil until then.
    @State private var baseline: Value?

    private var hasChanges: Bool { baseline.map { $0 != value } ?? false }

    func body(content: Content) -> some View {
        content
            .discardGuard(hasChanges: hasChanges,
                          busy: busy, cancelTitle: cancelTitle, onCancel: onCancel)
            .onChange(of: ready, initial: true) { _, isReady in
                if isReady, baseline == nil { baseline = value }
            }
            .onChange(of: hasChanges, initial: true) { _, now in
                if let changed, changed.wrappedValue != now { changed.wrappedValue = now }
            }
    }
}
