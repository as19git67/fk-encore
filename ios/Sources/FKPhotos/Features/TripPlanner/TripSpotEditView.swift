import SwiftUI

/// What a person wants to say about one spot (§9.2, §10.4).
///
/// Three fields, and keeping them apart is the point. The **title** is
/// the group's own handle for the place — "das Museum mit dem
/// Dachgarten" — and never a correction of OpenStreetMap, whose name
/// stays visible underneath it. The **note** is why it matters:
/// "Eingang um die Ecke", "Tickets vorher kaufen". The **URL** is the
/// one link they keep with it.
///
/// A value rather than three `@State` strings in the sheet, so the
/// rules about what an empty field means can be tested without a view.
struct TripSpotEdit: Identifiable, Equatable, Sendable {
    let osmRef: String
    var title: String
    var note: String
    var url: String
    var dwellMinutes: Int

    var id: String { osmRef }

    init(osmRef: String, title: String = "", note: String = "", url: String = "",
         dwellMinutes: Int = 45) {
        self.osmRef = osmRef
        self.title = title
        self.note = note
        self.url = url
        self.dwellMinutes = dwellMinutes
    }

    /// What the sheet opens with: the spot's own title if the group
    /// gave it one, never the map's name pre-filled into the field.
    /// Offering "Museum Beispiel" as an editable value would turn every
    /// save into a rename nobody asked for.
    init(_ spot: TripSpotDetail) {
        self.init(
            osmRef: spot.osmRef,
            title: spot.title ?? "",
            note: spot.note ?? "",
            url: spot.sourceUrl ?? "",
            dwellMinutes: spot.dwellMinutes,
        )
    }

    /// Whether the link is one the app could open.
    ///
    /// The server refuses anything but http and https; saying so here
    /// saves a round trip and, more to the point, says it next to the
    /// field rather than as a red banner over the whole screen.
    var urlIsUsable: Bool {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        guard let parsed = URL(string: trimmed), let scheme = parsed.scheme?.lowercased() else {
            return false
        }
        return (scheme == "http" || scheme == "https") && parsed.host?.isEmpty == false
    }

    /// Trimmed, with an empty field meaning "clear this one" rather
    /// than "leave it alone" — the server draws the same line.
    var trimmed: TripSpotEdit {
        TripSpotEdit(
            osmRef: osmRef,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            note: note.trimmingCharacters(in: .whitespacesAndNewlines),
            url: url.trimmingCharacters(in: .whitespacesAndNewlines),
            dwellMinutes: dwellMinutes,
        )
    }
}

/// The sheet itself.
struct TripSpotEditView: View {
    @State var edit: TripSpotEdit
    /// What OpenStreetMap calls the place, shown as the fallback the
    /// title field replaces.
    let spotName: String?
    let onSave: (TripSpotEdit) async -> Void
    let onCancel: () -> Void

    @State private var saving = false

    var body: some View {
        Form {
            Section {
                TextField(spotName ?? "Eigener Name", text: $edit.title)
            } header: {
                Text("Titel")
            } footer: {
                Text("Wie ihr den Ort nennt. Leer lassen, dann bleibt es beim Namen "
                     + "aus OpenStreetMap — der steht ohnehin weiterhin daneben.")
            }

            Section {
                TextField("Was man wissen sollte", text: $edit.note, axis: .vertical)
                    .lineLimit(3...8)
            } header: {
                Text("Notiz")
            } footer: {
                Text("„Eingang um die Ecke“, „Tickets vorher kaufen“ — das, was den "
                     + "Vormittag entscheidet.")
            }

            Section {
                TextField("https://…", text: $edit.url)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !edit.urlIsUsable {
                    Text("Das ist keine Adresse, die sich öffnen lässt.")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            } header: {
                Text("Link")
            } footer: {
                Text("Die offizielle Seite, die Buchung, der Blogeintrag.")
            }

            Section {
                Stepper(value: $edit.dwellMinutes, in: 5...480, step: 5) {
                    Text(TripClock.duration(edit.dwellMinutes))
                }
            } header: {
                Text("Aufenthalt")
            } footer: {
                Text("Wie lange ihr voraussichtlich dort seid.")
            }
        }
        .navigationTitle("Notiz zum Spot")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Abbrechen", action: onCancel)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Sichern") {
                    saving = true
                    Task {
                        await onSave(edit.trimmed)
                        saving = false
                    }
                }
                .disabled(saving || !edit.urlIsUsable)
            }
        }
    }
}
