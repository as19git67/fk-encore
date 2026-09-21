import FKPhotosLib
import SwiftUI
import WidgetKit

/// The Live Activity for a running trip day (#768 §1). The content
/// itself is computed in the package (`TripDayActivityContent`,
/// `TripDayActivityManager`); this only lays it out for the Lock
/// Screen and the Dynamic Island.
struct TripDayLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TripDayActivityAttributes.self) { context in
            TripDayLockScreenView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color.clear)
                .widgetURL(AppDeepLink.url(for: .tripDay(planId: context.attributes.planId)))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label(context.attributes.dayTitle, systemImage: "map")
                        .font(.caption)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let endMinutes = context.state.blockEndMinutes {
                        Text(TripClock.format(endMinutes)).font(.caption).monospacedDigit()
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    TripDayStopLine(state: context.state)
                }
            } compactLeading: {
                Image(systemName: "map")
            } compactTrailing: {
                Text(context.state.blockLabel ?? "").font(.caption2).lineLimit(1)
            } minimal: {
                Image(systemName: "map")
            }
        }
    }
}

private struct TripDayLockScreenView: View {
    let attributes: TripDayActivityAttributes
    let state: TripDayActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(attributes.dayTitle, systemImage: "map")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let endMinutes = state.blockEndMinutes {
                    Text("bis \(TripClock.format(endMinutes))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let label = state.blockLabel {
                Text(label).font(.headline)
            }
            TripDayStopLine(state: state)
            if state.overrunMinutes > 0 {
                Text("\(state.overrunMinutes) Min. später als geplant")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let lightHint = state.lightHintText {
                Text(lightHint).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
    }
}

/// "Im Museum" / "Auf dem Weg zu Aussichtspunkt" / "Unterwegs" — the one
/// line both presentations share.
private struct TripDayStopLine: View {
    let state: TripDayActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 4) {
            if let current = state.currentStopName {
                Image(systemName: state.stopConfirmed ? "checkmark.circle.fill" : "mappin.circle")
                    .foregroundStyle(state.stopConfirmed ? .green : .secondary)
                Text(current).font(.subheadline).lineLimit(1)
            } else {
                Text("Unterwegs").font(.subheadline).foregroundStyle(.secondary)
            }
            if let next = state.nextStopName {
                Text("· weiter zu \(next)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}
