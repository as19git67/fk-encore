import SwiftUI

/// "Nicht übersetzen" — the languages the reader can read as they are
/// (§25, stage C). A list of switches, one per language; what is on
/// is sent with every article request and shown as written.
struct TripArticleLanguagesView: View {
    @AppStorage(TripArticlePreferences.keepLanguagesKey) private var stored: String = ""

    private var kept: Set<String> { Set(TripArticlePreferences.codes(from: stored)) }

    var body: some View {
        List {
            Section {
                ForEach(TripArticlePreferences.offeredCodes, id: \.self) { code in
                    Toggle(isOn: binding(for: code)) {
                        Text(TripArticlePreferences.name(of: code))
                    }
                }
            } header: {
                Text("Nicht übersetzen")
            } footer: {
                Text("Ein Wikipedia-Artikel in einer dieser Sprachen wird so gezeigt, wie er "
                     + "geschrieben ist. Alle anderen übersetzt der eigene KI-Dienst ins Deutsche; "
                     + "im Artikel lässt sich jederzeit auf das Original umschalten.")
            }
        }
        .navigationTitle("Artikel-Sprachen")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func binding(for code: String) -> Binding<Bool> {
        Binding(
            get: { kept.contains(code) },
            set: { on in
                var codes = TripArticlePreferences.codes(from: stored)
                if on {
                    if !codes.contains(code) { codes.append(code) }
                } else {
                    codes.removeAll { $0 == code }
                }
                stored = TripArticlePreferences.stored(from: codes)
            },
        )
    }
}
