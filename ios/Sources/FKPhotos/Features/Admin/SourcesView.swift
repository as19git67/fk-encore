import SwiftUI

/// Where the content the app shows comes from, and under which licence.
///
/// The free licences behind the trip planner are free on condition of
/// saying so: OpenStreetMap's ODbL asks for "© OpenStreetMap
/// contributors" wherever its data is shown, Wikipedia's and Commons'
/// CC BY-SA for author and licence beside the text or picture. The
/// places that show the data say it in a line; this screen says it all
/// in one place, with the links to the licences themselves.
enum SourceAttribution {
    static let osmCopyrightURL = URL(string: "https://www.openstreetmap.org/copyright")!
    static let odblURL = URL(string: "https://opendatacommons.org/licenses/odbl/")!
    static let wikipediaLicenseURL = URL(string: "https://de.wikipedia.org/wiki/Wikipedia:Lizenzbestimmungen")!
    static let commonsLicensingURL = URL(string: "https://commons.wikimedia.org/wiki/Commons:Licensing")!
    static let ccBySaURL = URL(string: "https://creativecommons.org/licenses/by-sa/4.0/deed.de")!
}

/// "Kartendaten © OpenStreetMap-Mitwirkende", linked to the copyright
/// page OpenStreetMap asks the attribution to point at.
///
/// Placed under the lists and details built from OpenStreetMap data —
/// opening hours, ways, the food list — as a section footer.
struct OSMAttributionNote: View {
    var body: some View {
        Link("Daten © OpenStreetMap-Mitwirkende (ODbL)",
             destination: SourceAttribution.osmCopyrightURL)
            .font(.footnote)
    }
}

struct SourcesView: View {
    var body: some View {
        List {
            Section {
                Text("Orte, Öffnungszeiten, Wege und Routenverläufe im Reiseplaner stammen "
                     + "aus OpenStreetMap. Die Daten stehen unter der Open Database License "
                     + "(ODbL).")
                Link(destination: SourceAttribution.osmCopyrightURL) {
                    Label("© OpenStreetMap-Mitwirkende", systemImage: "map")
                }
                Link(destination: SourceAttribution.odblURL) {
                    Label("Open Database License (ODbL)", systemImage: "doc.text")
                }
            } header: {
                Text("OpenStreetMap")
            }

            Section {
                Text("Artikeltexte stammen aus Wikipedia, Bilder aus Wikimedia Commons. "
                     + "Texte stehen unter CC BY-SA; jedes Bild nennt Urheber und Lizenz "
                     + "an der Stelle, an der es gezeigt wird. Übersetzte Artikel sind als "
                     + "maschinell übersetzt gekennzeichnet.")
                Link(destination: SourceAttribution.wikipediaLicenseURL) {
                    Label("Lizenzbestimmungen der Wikipedia", systemImage: "book")
                }
                Link(destination: SourceAttribution.commonsLicensingURL) {
                    Label("Lizenzen auf Wikimedia Commons", systemImage: "photo")
                }
                Link(destination: SourceAttribution.ccBySaURL) {
                    Label("Creative Commons BY-SA 4.0", systemImage: "doc.text")
                }
            } header: {
                Text("Wikipedia und Wikimedia Commons")
            }

            Section {
                Text("Karten und die Ortssuche kommen von Apple Karten. Die rechtlichen "
                     + "Hinweise dazu stehen in jeder Karte unten über „Rechtliches“.")
            } header: {
                Text("Apple Karten")
            }

            Section {
                Text("Fotos, Alben, Dokumente und Notizen sind Inhalte der Nutzerinnen "
                     + "und Nutzer dieser Installation.")
            } header: {
                Text("Eigene Inhalte")
            }
        }
        .navigationTitle("Quellen & Lizenzen")
    }
}
