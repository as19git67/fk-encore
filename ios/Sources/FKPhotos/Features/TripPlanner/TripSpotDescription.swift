import SwiftUI

/// What a place is, with where that was read (candidate ranking,
/// stage 4): a Wikivoyage line, the lead of the Wikipedia article, or a
/// summary of the place's own website that the server checked against
/// a quote from the page. The source is always said on screen.
struct TripSpotDescription: Codable, Equatable, Sendable {
    let text: String
    /// "wikivoyage", "wikipedia" or "website".
    let source: String
    let url: String?

    /// The line under the text: whose words these are.
    var sourceLabel: String {
        switch source {
        case "wikivoyage": return "Aus Wikivoyage (CC BY-SA)"
        case "wikipedia":  return "Aus Wikipedia (CC BY-SA)"
        case "website":    return "Zusammengefasst von der Website des Orts"
        default:           return "Quelle"
        }
    }

    /// Under the short sentence: "aus Wikivoyage", as in the mock.
    var shortSourceLabel: String {
        switch source {
        case "wikivoyage": return "aus Wikivoyage"
        case "wikipedia":  return "aus Wikipedia"
        case "website":    return "von der Website des Orts"
        default:           return ""
        }
    }

    var link: URL? { url.flatMap(URL.init(string:)) }
}

/// The description as a list section: the text, and its source as a
/// link underneath.
struct TripSpotDescriptionSection: View {
    let description: TripSpotDescription

    var body: some View {
        Section {
            Text(description.text)
                .fixedSize(horizontal: false, vertical: true)
        } header: {
            Text("Beschreibung")
        } footer: {
            if let link = description.link {
                Link(description.sourceLabel, destination: link)
            } else {
                Text(description.sourceLabel)
            }
        }
    }
}
