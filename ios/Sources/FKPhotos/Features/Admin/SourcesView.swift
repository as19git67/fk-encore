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
    static let wikivoyageLicenseURL = URL(string: "https://de.wikivoyage.org/wiki/Wikivoyage:Lizenz")!
    static let wikidataURL = URL(string: "https://www.wikidata.org/wiki/Wikidata:Licensing")!
    static let openMeteoURL = URL(string: "https://open-meteo.com/")!
    static let ccByURL = URL(string: "https://creativecommons.org/licenses/by/4.0/deed.de")!
    static let copernicusDEMURL = URL(string: "https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model")!
}

/// Open-source software compiled into the app, with the version pinned in
/// `ios/Package.resolved`. Packages that only run while building (the
/// OpenAPI generator and what it pulls in) ship nothing and are not listed.
///
/// Apache 2.0 asks for the licence text and each project's NOTICE file to
/// travel with the binary: both lie in `Resources/Licenses`. A new runtime
/// package gets a row here and its NOTICE file there.
struct OpenSourcePackage: Identifiable {
    let name: String
    let version: String
    let license: String
    let noticeResource: String
    var id: String { name }

    /// A licence or NOTICE file from `Resources/Licenses`.
    static func bundledText(_ resource: String) -> URL? {
        Bundle.module.url(forResource: resource, withExtension: "txt")
    }

    static let all: [OpenSourcePackage] = [
        OpenSourcePackage(name: "swift-openapi-runtime", version: "1.11.0",
                          license: "Apache 2.0", noticeResource: "NOTICE-swift-openapi-runtime"),
        OpenSourcePackage(name: "swift-openapi-urlsession", version: "1.2.0",
                          license: "Apache 2.0", noticeResource: "NOTICE-swift-openapi-urlsession"),
        OpenSourcePackage(name: "swift-http-types", version: "1.5.1",
                          license: "Apache 2.0", noticeResource: "NOTICE-swift-http-types"),
    ]
}

/// A bundled licence or NOTICE file, shown as plain monospaced text.
struct LicenseTextView: View {
    let title: String
    let resource: String

    private var text: String {
        guard let url = OpenSourcePackage.bundledText(resource),
              let text = try? String(contentsOf: url, encoding: .utf8) else {
            return "Text nicht gefunden."
        }
        return text
    }

    var body: some View {
        ScrollView {
            Text(text)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
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
                     + "aus OpenStreetMap, ebenso die Ortsnamen an Fotos (über Nominatim) und "
                     + "die Routen, die der Server berechnet. Die Daten stehen unter der Open "
                     + "Database License (ODbL).")
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
                Text("Beschreibungen von Orten stammen, wo angegeben, aus Wikivoyage und "
                     + "stehen unter CC BY-SA. Bilder und Angaben zur Bekanntheit eines Orts "
                     + "kommen auch aus Wikidata (CC0).")
                Link(destination: SourceAttribution.wikivoyageLicenseURL) {
                    Label("Lizenz von Wikivoyage", systemImage: "book")
                }
                Link(destination: SourceAttribution.wikidataURL) {
                    Label("Lizenz von Wikidata (CC0)", systemImage: "doc.text")
                }
            } header: {
                Text("Wikivoyage und Wikidata")
            }

            Section {
                Text("Wetter, Klimawerte und Geländehöhen im Reiseplaner kommen von "
                     + "Open-Meteo.com und stehen unter Creative Commons BY 4.0.")
                Text("Höhendaten: Copernicus DEM GLO-90, © DLR e.V. 2010–2014 und "
                     + "© Airbus Defence and Space GmbH 2014–2018, bereitgestellt im Rahmen "
                     + "von COPERNICUS durch die Europäische Union und die ESA.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Link(destination: SourceAttribution.openMeteoURL) {
                    Label("Wetterdaten von Open-Meteo.com", systemImage: "cloud.sun")
                }
                Link(destination: SourceAttribution.ccByURL) {
                    Label("Creative Commons BY 4.0", systemImage: "doc.text")
                }
                Link(destination: SourceAttribution.copernicusDEMURL) {
                    Label("Copernicus DEM", systemImage: "mountain.2")
                }
            } header: {
                Text("Open-Meteo")
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

            Section {
                ForEach(OpenSourcePackage.all) { pkg in
                    NavigationLink {
                        LicenseTextView(title: pkg.name, resource: pkg.noticeResource)
                    } label: {
                        LabeledContent(pkg.name, value: "\(pkg.version) · \(pkg.license)")
                    }
                }
                NavigationLink {
                    LicenseTextView(title: "Apache License 2.0", resource: "Apache-2.0")
                } label: {
                    Label("Apache License 2.0 (Lizenztext)", systemImage: "doc.text")
                }
            } header: {
                Text("Open-Source-Software")
            } footer: {
                Text("Diese Bibliotheken sind in die App eingebaut.")
            }
        }
        .navigationTitle("Quellen & Lizenzen")
    }
}
