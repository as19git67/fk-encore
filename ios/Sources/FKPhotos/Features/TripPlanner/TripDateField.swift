import SwiftUI

/// A date row that looks the same every time it appears.
///
/// The compact `DatePicker` picks its own text, and when a row is
/// inserted into a form (switching "Beginn steht fest" on) it first
/// lays out with a two-digit year and switches to four digits on the
/// next pass (Anton, 17.11.). The field shows the date itself, in the
/// device's locale and in the same style as the picker usually does
/// (`.medium`: "27.11.2026", "Nov 27, 2026").
///
/// The whole pill is one button that opens Apple's calendar in a
/// popover. An invisible compact picker lying on top only answered
/// where its own, smaller label happened to be, so most taps on the
/// pill went nowhere (Anton, 18.11.).
struct TripDateField: View {
    let title: String
    @Binding var selection: Date
    var range: ClosedRange<Date>? = nil
    /// "x" back to "offen" next to the date; nil when the date cannot
    /// be left open.
    var onClear: (() -> Void)? = nil
    /// Keeps the date where a row with an "x" would have it, so two
    /// dates under each other line up when only one can be cleared.
    var reservesClearSpace = false

    @State private var picking = false

    var body: some View {
        HStack(spacing: 0) {
            Text(title)
            Spacer(minLength: 8)
            Button { picking = true } label: {
                Text(Self.text(selection))
                    .foregroundStyle(picking ? Color.accentColor : Color.primary)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 6)
                    .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 6))
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .fixedSize()
            .accessibilityLabel(title)
            .accessibilityValue(Self.text(selection))
            .accessibilityHint("Öffnet den Kalender")
            .popover(isPresented: $picking) {
                calendar
                    .presentationCompactAdaptation(.popover)
            }
            if let onClear {
                TripClearValueButton(label: "\(title) offen lassen", action: onClear)
            } else if reservesClearSpace {
                TripClearValueButton.placeholder
            }
        }
    }

    /// Apple's calendar; picking a day closes it, paging the month does not.
    private var calendar: some View {
        picker
            .datePickerStyle(.graphical)
            .labelsHidden()
            .frame(width: 320)
            .padding(8)
            .onChange(of: selection) { picking = false }
    }

    @ViewBuilder
    private var picker: some View {
        if let range {
            DatePicker(title, selection: $selection, in: range, displayedComponents: .date)
        } else {
            DatePicker(title, selection: $selection, displayedComponents: .date)
        }
    }

    static func text(_ date: Date) -> String {
        formatter.string(from: date)
    }

    /// `.medium` is what the compact picker shows once it has settled.
    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()
}

/// The "x" that sets a date or a time back to "offen".
///
/// Secondary rather than tertiary — tertiary read as a disabled button —
/// and with room to its left, so it no longer touches the picker.
/// Every row with one has the same width; `placeholder` keeps that
/// width in a row without one.
struct TripClearValueButton: View {
    let label: String
    let action: () -> Void

    static let width: CGFloat = 36

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark.circle.fill")
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: Self.width, height: 32, alignment: .trailing)
                .contentShape(.rect)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }

    static var placeholder: some View {
        Color.clear
            .frame(width: width, height: 1)
            .accessibilityHidden(true)
    }
}
