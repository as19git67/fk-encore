import SwiftUI

/// What to tell a traveller when a request failed.
///
/// One place, because the alternative was `TripErrorText.describe(error)`
/// on thirty screens: English `URLError` prose for a German app, and
/// the same outage worded three different ways. The server's own
/// German sentences (a refused re-plan, a missing address) pass
/// through untouched — they are already written for the person reading.
enum TripErrorText {
    static func describe(_ error: Error) -> String {
        if error is CancellationError { return "" }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed,
                 .internationalRoamingOff:
                return "Keine Verbindung. Der Plan bleibt, wie er ist — bitte später noch einmal."
            case .timedOut:
                return "Der Server hat nicht rechtzeitig geantwortet."
            case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
                return "Der Server ist gerade nicht erreichbar."
            case .cancelled:
                return ""
            default:
                return "Die Verbindung ist fehlgeschlagen."
            }
        }
        if let apiError = error as? APIError {
            switch apiError {
            case .httpError(let code, let message):
                switch code {
                case 401: return "Du bist nicht mehr angemeldet."
                case 403: return "Das darf auf dieser Reise nur, wer sie angelegt hat."
                case 404: return "Das gibt es nicht mehr — vielleicht hat es jemand gerade gelöscht."
                case 500...599: return "Der Server hat einen Fehler gemeldet. Bitte später noch einmal."
                default:
                    if let message, !message.isEmpty { return message }
                    return "Das hat nicht geklappt."
                }
            default:
                return apiError.localizedDescription
            }
        }
        return TripErrorText.describe(error)
    }
}

/// The one way the planner says "that did not work".
///
/// A banner at the top of the screen rather than a red line at the
/// bottom of a list, where it sat below the fold whenever the list was
/// long enough to matter. With a retry when the screen has something
/// to retry, and a way to put it away either way.
struct TripErrorBanner: ViewModifier {
    let message: String?
    let retry: (() async -> Void)?
    let dismiss: (() -> Void)?

    @State private var retrying = false

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            if let message, !message.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Text(message)
                        .font(.footnote)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let retry {
                        Button {
                            retrying = true
                            Task {
                                await retry()
                                retrying = false
                            }
                        } label: {
                            if retrying {
                                ProgressView().controlSize(.small)
                            } else {
                                Text("Erneut")
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(retrying)
                    }
                    if let dismiss {
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .accessibilityLabel("Meldung ausblenden")
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .background(.bar)
                .overlay(alignment: .bottom) { Divider() }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.default, value: message)
    }
}

extension View {
    /// Show `message` as the planner's error banner (see `TripErrorBanner`).
    func plannerErrorBanner(_ message: String?,
                            retry: (() async -> Void)? = nil,
                            dismiss: (() -> Void)? = nil) -> some View {
        modifier(TripErrorBanner(message: message, retry: retry, dismiss: dismiss))
    }
}
