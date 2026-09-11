import SwiftUI

/// The collection, at last on a screen (§20).
///
/// The machinery has been complete since the endpoints landed —
/// collecting, sharing, the proximity rule, the outing proposal, the
/// three ways between collection and trip — and none of it was reachable
/// without an HTTP client. This is the first screen: see what is in
/// there, put something in, take something out, let somebody write
/// along.
///
/// Two things it says out loud rather than by omission. An entry the map
/// does not know is **marked**, because its category and its duration
/// are guesses (§15.3). And who put an entry there stays visible —
/// „der Biergarten, den Anna gemerkt hat" is half the information
/// (§20.1), and a list that reduces it to the beer garden loses the
/// half that makes anybody go.
struct TripIdeasView: View {
    @State private var model = TripIdeasViewModel()
    @State private var isAddingHere = false
    @State private var noteDraft = ""
    @State private var shareEmail = ""
    @State private var isSharing = false

    var body: some View {
        List {
            if let message = model.lastAddition {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
            }

            if model.entries.isEmpty && !model.isLoading {
                ContentUnavailableView(
                    "Noch keine Ideen",
                    systemImage: "lightbulb",
                    description: Text("Was euch begegnet, sammelt sich hier — ohne dass es "
                                      + "schon eine Reise dazu geben muss."),
                )
            }

            ForEach(model.entries) { idea in
                row(idea)
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await model.remove(idea) }
                        } label: {
                            Label("Entfernen", systemImage: "trash")
                        }
                    }
            }
        }
        .navigationTitle(model.collection?.label ?? "Ideenvorrat")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    // Buttons rather than a Picker: switching collection
                    // reloads, and a menu entry that says which one is
                    // current reads better than a wheel nobody expects
                    // in a menu.
                    if model.collections.count > 1 {
                        ForEach(model.collections) { collection in
                            Button {
                                model.ownerId = collection.ownerId
                            } label: {
                                Label(
                                    collection.label,
                                    systemImage: isCurrent(collection) ? "checkmark" : "tray",
                                )
                            }
                        }
                        Divider()
                    }
                    Button {
                        isSharing = true
                    } label: {
                        Label("Jemanden mitschreiben lassen", systemImage: "person.badge.plus")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
            ToolbarItem(placement: .bottomBar) {
                Button {
                    noteDraft = ""
                    isAddingHere = true
                } label: {
                    Label("Das hier merken", systemImage: "plus.circle.fill")
                }
                .disabled(model.isAdding)
            }
        }
        .task { await model.load() }
        .onChange(of: model.ownerId) { _, _ in
            Task { await model.load() }
        }
        .refreshable { await model.load() }
        .alert("Das hier merken", isPresented: $isAddingHere) {
            TextField("Notiz (optional)", text: $noteDraft)
            Button("Abbrechen", role: .cancel) {}
            Button("Merken") {
                Task { await model.addHere(note: noteDraft) }
            }
        } message: {
            // Said before it happens, not after: the coordinate is what
            // makes the entry findable again, and somebody standing in
            // the wrong place should know that is what gets stored.
            Text("Gespeichert wird, wo ihr gerade steht.")
        }
        .alert("Mitschreiben lassen", isPresented: $isSharing) {
            TextField("E-Mail-Adresse", text: $shareEmail)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
            Button("Abbrechen", role: .cancel) {}
            Button("Einladen") {
                Task { await model.share(with: shareEmail) }
            }
        } message: {
            Text("Wer eingeladen ist, schreibt in denselben Vorrat — eine Liste, keine Kopie.")
        }
    }

    private func isCurrent(_ collection: TripIdeaCollection) -> Bool {
        model.collection?.ownerId == collection.ownerId
    }

    @ViewBuilder
    private func row(_ idea: TripIdea) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(idea.displayName)
                if idea.unmatched {
                    // Not a warning triangle: nothing is wrong, the map
                    // simply does not know this place, and what follows
                    // from that is that two of its fields are estimates.
                    Image(systemName: "questionmark.circle")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("In OpenStreetMap nicht gefunden — Kategorie und Dauer sind geschätzt")
                }
            }
            if let subtitle = idea.subtitle {
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let validTo = idea.validTo {
                Text("nur bis \(validTo)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
