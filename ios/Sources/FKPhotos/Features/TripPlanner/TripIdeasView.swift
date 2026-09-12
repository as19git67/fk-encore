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
    @State private var shareEmail = ""
    @State private var isSharing = false
    /// True while the shared link is being turned into an entry.
    @State private var isAddingShared = false
    /// Whether the collection may speak up on its own (§20.2).
    @State private var noticesEnabled = TripIdeaNoticePreferences.isEnabled()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            if let place = model.sharedPlace {
                sharedRow(place)
            }

            if let message = model.lastAddition {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red)
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
        // An overlay rather than a row. Inside the list the empty state
        // got a row's width, and `ContentUnavailableView` answered by
        // squeezing its button into a column of single letters — the
        // one control the screen has, unreadable.
        .overlay {
            if isEmpty {
                // The empty state carries the way in rather than only
                // describing one. A screen that says "nothing here yet"
                // and leaves the reader to find the button is a screen
                // that has explained its own uselessness.
                ContentUnavailableView {
                    Label("Noch keine Ideen", systemImage: "lightbulb")
                } description: {
                    Text("Was euch begegnet, sammelt sich hier — ohne dass es "
                         + "schon eine Reise dazu geben muss.")
                } actions: {
                    Button {
                        startAdding()
                    } label: {
                        Label("Das hier merken", systemImage: "mappin.and.ellipse")
                    }
                    .buttonStyle(.borderedProminent)
                }
                .background(Color(uiColor: .systemGroupedBackground))
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
                    Divider()
                    // §20.5 asks for it to be switchable, and the honest
                    // reading of that is "off until somebody says so":
                    // a collection that starts talking because an app
                    // was updated was never given permission.
                    Toggle(isOn: $noticesEnabled) {
                        Label("Von selbst melden", systemImage: "bell")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
            // Top bar, not `.bottomBar`: this screen lives inside the
            // tab view, and a bottom toolbar item loses that argument
            // with the tab bar — the button was in the code and on no
            // screen.
            ToolbarItem(placement: .primaryAction) {
                Button {
                    startAdding()
                } label: {
                    Label("Das hier merken", systemImage: "plus")
                }
                .disabled(model.isAdding)
            }
            // The question the collection exists for (§20.2), reachable
            // from the list rather than buried in the menu: "ist hier
            // etwas von uns?" is what somebody standing somewhere asks.
            ToolbarItem(placement: .topBarLeading) {
                NavigationLink {
                    TripIdeasNearbyView(model: model)
                } label: {
                    Label("In der Nähe", systemImage: "location.magnifyingglass")
                }
            }
        }
        .task {
            await model.load()
            await model.checkShare()
        }
        .onChange(of: model.ownerId) { _, _ in
            Task { await model.load() }
        }
        // A link shared while this screen was already open arrives in
        // the inbox with nobody looking: `.task` ran long before the
        // share did.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.checkShare() } }
        }
        .onChange(of: noticesEnabled) { _, enabled in
            TripIdeaNoticePreferences.setEnabled(enabled)
            if enabled {
                TripIdeaNoticeMonitor.shared.startIfEnabled()
            } else {
                TripIdeaNoticeMonitor.shared.stop()
            }
        }
        .refreshable { await model.load() }
        // A sheet rather than an alert, because an alert cannot ask how
        // long you stay — and without that the server refuses every
        // place OpenStreetMap does not know.
        .sheet(isPresented: $isAddingHere) {
            TripIdeaCaptureSheet(
                title: "Das hier merken",
                // Said before it happens, not after: the coordinate is
                // what makes the entry findable again, and somebody
                // standing in the wrong place should know that is what
                // gets stored.
                explanation: "Gespeichert wird, wo ihr gerade steht.",
            ) { note, dwellMinutes in
                await model.addHere(note: note, dwellMinutes: dwellMinutes)
            }
        }
        .sheet(isPresented: $isAddingShared) {
            TripIdeaCaptureSheet(
                title: "In den Vorrat",
                explanation: "Der Ort aus dem Link wird gemerkt — mit dem Link als Herkunft.",
            ) { note, dwellMinutes in
                await model.addShared(note: note, dwellMinutes: dwellMinutes)
            }
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

    /// The banner for a link somebody shared into the app.
    ///
    /// A row rather than an alert: it is an offer, not a question, and
    /// an offer that blocks the screen until it is answered turns a
    /// share into an interruption. Ignoring it leaves the link in the
    /// inbox for the trip picker, which is the other thing it may have
    /// been meant for.
    @ViewBuilder
    private func sharedRow(_ place: TripMapLink.Place) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(place.name ?? "Geteilter Ort", systemImage: "square.and.arrow.down")
                .font(.subheadline.weight(.medium))
            Text("Aus einem geteilten Kartenlink.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                Button("In den Vorrat") { isAddingShared = true }
                .buttonStyle(.borderedProminent)
                .disabled(model.isAdding)
                Button("Später") { model.dismissShare() }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }

    /// Nothing collected, nothing loading, no shared link waiting and
    /// nothing to say — the offer from a share is a row worth seeing,
    /// and an overlay would cover it.
    ///
    /// The last two clauses are the fix for a failure nobody could see:
    /// this overlay is opaque and sits over the rows that carry the
    /// error and the confirmation. An addition the server refused
    /// therefore looked exactly like an addition nobody made — "merken"
    /// tapped, dialog gone, list still empty, no word about why.
    private var isEmpty: Bool {
        model.entries.isEmpty && !model.isLoading && model.sharedPlace == nil
            && model.errorMessage == nil && model.lastAddition == nil
    }

    private func startAdding() {
        isAddingHere = true
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
