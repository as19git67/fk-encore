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
    /// True while the shared link is being turned into an entry.
    @State private var isAddingShared = false
    /// Whether the collection may speak up on its own (§20.2).
    @State private var noticesEnabled = TripIdeaNoticePreferences.isEnabled()
    /// Set when an outing proposed from a group became a trip, so this
    /// screen can open it — nobody makes a trip in order to look at a
    /// list.
    @State private var openPlanId: Int?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        List {
            if let place = model.sharedPlace {
                sharedRow(place)
            }
            if let url = model.sharedArticleUrl {
                articleRow(url)
            }

            if let message = model.lastAddition {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            // The two questions the collection exists for, as rows at
            // the top rather than as two icons in the bar: "ist hier
            // etwas von uns?" (§20.2) and "was ist hier überhaupt?"
            // (§9.2) are the reasons to open this screen, and a row with
            // a name is found where an icon has to be guessed.
            if !model.entries.isEmpty {
                Section {
                    NavigationLink {
                        TripIdeasNearbyView(model: model)
                    } label: {
                        Label("In der Nähe", systemImage: "location.magnifyingglass")
                    }
                    NavigationLink {
                        TripExploreView(ownerId: model.ownerId)
                    } label: {
                        Label("Entdecken", systemImage: "binoculars")
                    }
                }
            }

            // Grouped by where things are, not by when they were
            // saved (§20.1). A flat list is fine at five entries and
            // useless at forty: the beer garden two streets away and
            // the museum in another country read the same, and „was
            // haben wir hier eigentlich?" needs all of it read.
            ForEach(model.clusters) { cluster in
                Section {
                    ForEach(cluster.ideas) { idea in
                        // A row that can only be read is a dead end:
                        // what a place is, where it is and why it was
                        // kept are all one tap away for a planned spot,
                        // and an entry here is the same place before it
                        // belongs to a trip.
                        NavigationLink {
                            TripIdeaDetailView(idea: idea, model: model)
                        } label: {
                            row(idea)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await model.remove(idea) }
                            } label: {
                                Label("Entfernen", systemImage: "trash")
                            }
                        }
                    }
                    // „Soll ich daraus einen Nachmittag machen?" (§20.2),
                    // asked where the several-things-close-together
                    // case is visible: a group *is* that case, and until
                    // now the question could only be asked from the
                    // street, about wherever the phone happened to be.
                    NavigationLink {
                        TripIdeasOutingView(model: model, openPlanId: $openPlanId,
                                            anchor: cluster.centre)
                    } label: {
                        Label("Ausflug daraus", systemImage: "figure.walk.motion")
                            .font(.footnote)
                    }
                } header: {
                    Text(model.title(of: cluster))
                        // Named when it comes into view, not all at
                        // once: the geocoder is rate-limited, and a
                        // group nobody has scrolled to needs no name yet.
                        .onAppear { Task { await model.nameCluster(cluster) } }
                }
            }

            // §20.5 asks for it to be switchable, and the honest reading
            // of that is "off until somebody says so": a collection that
            // starts talking because an app was updated was never given
            // permission. Out of the overflow menu and onto the list,
            // with the terms said next to it — a switch whose effect is
            // a surprise is not a switch anybody leaves on.
            if !model.entries.isEmpty {
                Section {
                    Toggle(isOn: $noticesEnabled) {
                        Label("Von selbst melden", systemImage: "bell")
                    }
                } footer: {
                    Text("Meldet sich, wenn ihr bis zu 2 km an einer Idee vorbeikommt — "
                         + "höchstens alle 30 Minuten. Braucht die Standortfreigabe „Immer“.")
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
                    // A successful "merken" whose reload came back
                    // empty (somebody else's collection, no network)
                    // used to hide the empty state and show one grey
                    // line instead. The sentence belongs here.
                    Text(model.lastAddition
                         ?? "Was euch begegnet, sammelt sich hier — ohne dass es "
                            + "schon eine Reise dazu geben muss.")
                } actions: {
                    VStack(spacing: 12) {
                        Button {
                            startAdding()
                        } label: {
                            Label("Das hier merken", systemImage: "mappin.and.ellipse")
                        }
                        .buttonStyle(.borderedProminent)
                        // An empty collection is exactly when somebody
                        // has nothing to share into it yet, so the way
                        // that needs no link belongs here.
                        NavigationLink {
                            TripExploreView(ownerId: model.ownerId)
                        } label: {
                            Label("Entdecken", systemImage: "binoculars")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .background(Color(uiColor: .systemGroupedBackground))
            }
        }
        .navigationTitle("Ideen")
        .plannerErrorBanner(model.errorMessage, retry: { await model.load() }, dismiss: { model.errorMessage = nil })
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // One list for the household (§20.1): everything you may
                // write into, folded where two of you kept the same place,
                // with "von X" on each row. The collection switcher is
                // gone with it — two people who collected separately and
                // then let each other in see one list, not two.
                NavigationLink {
                    TripIdeaMembersView(model: model)
                } label: {
                    Label("Wer schreibt mit", systemImage: "person.2")
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
        .refreshable {
            await model.load()
        }
        .navigationDestination(item: $openPlanId) { planId in
            TripPlanDayView(viewModel: TripPlannerViewModel.shared(for: planId))
        }
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
                return model.errorMessage == nil
            }
        }
        .sheet(isPresented: $isAddingShared) {
            TripIdeaCaptureSheet(
                title: "Zu den Ideen",
                explanation: "Der Ort aus dem Link wird gemerkt — mit dem Link als Herkunft.",
            ) { note, dwellMinutes in
                await model.addShared(note: note, dwellMinutes: dwellMinutes)
                return model.errorMessage == nil
            }
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
                Button("Zu den Ideen") { isAddingShared = true }
                .buttonStyle(.borderedProminent)
                .disabled(model.isAdding)
                Button("Später") { model.dismissShare() }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }

    /// The offer for a shared link that names no place — an article.
    ///
    /// Reading one needs an area to search around and the language
    /// model behind „Entdecken" (§9.3), neither of which the collection
    /// has. So the row does not pretend to read; it says what the link
    /// is and leads to the screen that can, with the one thing that
    /// screen will ask for said in advance.
    @ViewBuilder
    private func articleRow(_ url: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(model.pendingShare?.title ?? url, systemImage: "doc.text.magnifyingglass")
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            Text("Das ist ein Artikel — auslesen? Dafür braucht es erst eine Gegend; "
                 + "die wählt ihr beim Entdecken.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                NavigationLink {
                    TripExploreView(ownerId: model.ownerId)
                } label: {
                    Text("Zum Entdecken")
                }
                .buttonStyle(.borderedProminent)
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
            && model.sharedArticleUrl == nil
            && model.errorMessage == nil
    }

    private func startAdding() {
        isAddingHere = true
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
            // Both, not one or the other: the note is why the place is
            // worth it, and who kept it is who to ask — dropping either
            // for the sake of a shorter row drops half of §20.1.
            if let note = idea.noteLine {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let author = idea.authorLine {
                Text(author)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let validTo = idea.validTo {
                Text("nur bis \(validTo)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 44, alignment: .leading)
    }
}

/// One collected place, in full, and correctable (§20).
///
/// The same screen a planned spot gets — where it is, what it is, why
/// it was kept, the link it came from — because it is the same place
/// before it belongs to a trip, and answering "where is that?" twice
/// would mean two screens drifting apart.
///
/// What it adds is the pencil. Until now an entry was whatever it was
/// on the day somebody saved it: the stay length for a place
/// OpenStreetMap does not know was a guess (§15.3), the note was
/// written before anybody had been there, and neither could be
/// corrected without deleting the entry and collecting it again.
struct TripIdeaDetailView: View {
    let idea: TripIdea
    let model: TripIdeasViewModel

    @State private var isChoosingPlan = false

    var body: some View {
        TripSpotDetailView(
            spot: TripSpotDetail(idea),
            onSave: { edit in await model.update(idea, with: edit) },
        ) { close in
            // The third way between collection and trip (§20.3), from
            // this end: the trip's own screen asks „was liegt hier aus
            // dem Vorrat?", this asks „in welche Reise soll das?" — the
            // question somebody has when they are looking at the idea
            // rather than at the trip.
            Button {
                isChoosingPlan = true
            } label: {
                Label("In eine Reise übernehmen", systemImage: "suitcase")
            }
            Button(role: .destructive) {
                Task {
                    await model.remove(idea)
                    // The screen describes something that is no longer
                    // there, so it has to take itself away.
                    close()
                }
            } label: {
                Label("Aus den Ideen entfernen", systemImage: "trash")
            }
        }
        .sheet(isPresented: $isChoosingPlan) {
            TripIdeaTakeSheet(idea: idea, model: model)
        }
    }
}

/// „In welche Reise?" — the trips, one tap each (§20.3).
///
/// A sheet with a list rather than a menu of titles: the list can say
/// that it is loading, that it failed, and that there is no trip yet,
/// and a menu can say none of those. The idea stays in the collection
/// either way — it is used, not consumed.
struct TripIdeaTakeSheet: View {
    let idea: TripIdea
    let model: TripIdeasViewModel

    @State private var plans: [TripPlanSummary] = []
    @State private var isLoading = true
    @State private var takingPlanId: Int?
    @State private var errorMessage: String?
    /// What happened, in the server's terms, shown until the sheet goes.
    @State private var outcome: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let outcome {
                    Section {
                        Label(outcome, systemImage: "checkmark.circle")
                            .font(.footnote)
                    }
                }
                Section {
                    if isLoading && plans.isEmpty {
                        HStack { ProgressView(); Text("Reisen werden geladen…") }
                    } else if plans.isEmpty {
                        Text("Noch keine Reise angelegt. Eine neue entsteht unter „Reisen“.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(plans) { plan in
                        Button {
                            Task { await take(into: plan) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(plan.displayTitle).foregroundStyle(.primary)
                                    // The route under the name — unless
                                    // the route *is* the name, for a trip
                                    // nobody titled.
                                    if let route = plan.routeLabel, route != plan.displayTitle {
                                        Text(route).font(.footnote).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if takingPlanId == plan.id {
                                    ProgressView()
                                }
                            }
                            .frame(minHeight: 44)
                        }
                        .disabled(takingPlanId != nil || outcome != nil)
                    }
                } header: {
                    Text(idea.displayName)
                } footer: {
                    // Said in the plan's own words: the idea becomes a
                    // *candidate* of the leg it lies in, not a stop on a
                    // day — placing it is the plan's decision (§20.3).
                    Text("Die Idee kommt zu den Kandidaten der passenden Stadt. Bei den Ideen "
                         + "bleibt sie trotzdem.")
                }
            }
            .navigationTitle("In eine Reise übernehmen")
            .plannerErrorBanner(errorMessage, dismiss: { errorMessage = nil })
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(outcome == nil ? "Abbrechen" : "Fertig") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: ListTripPlansResponse =
                try await APIClient.shared.get("/trip-planner/plans")
            plans = response.plans
            errorMessage = nil
        } catch {
            errorMessage = "Die Reisen ließen sich nicht laden."
        }
    }

    private func take(into plan: TripPlanSummary) async {
        takingPlanId = plan.id
        defer { takingPlanId = nil }
        if let sentence = await model.takeIdea(idea, into: plan) {
            outcome = sentence
            errorMessage = nil
            // Long enough to read the sentence, short enough that the
            // sheet does not need a second tap to go away.
            try? await Task.sleep(for: .seconds(1.2))
            dismiss()
        } else {
            errorMessage = model.errorMessage
        }
    }
}

/// Who writes into my ideas (§20.1) — the people, and the rest of the
/// household to pick from.
///
/// Modelled on the album share: the household is a known, short list
/// of accounts, so inviting is a tap on a name, not an address typed
/// into an alert. Being let in means writing into *my* collection;
/// their own stays theirs, and both show up in one list for everybody
/// who may see both.
struct TripIdeaMembersView: View {
    let model: TripIdeasViewModel
    @State private var removing: TripIdeaMember?

    var body: some View {
        List {
            Section {
                if model.isLoadingMembers && model.members.isEmpty {
                    HStack { ProgressView(); Text("Wird geladen…") }
                } else if model.members.isEmpty {
                    Text("Bisher schreibst nur du in deine Ideen.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(model.members) { member in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(member.displayName)
                            Text(member.email).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            removing = member
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("\(member.displayName) nicht mehr mitschreiben lassen")
                    }
                }
            } header: {
                Text("Schreiben mit")
            } footer: {
                Text("Wer hier steht, sieht deine Ideen in seiner Liste und legt eigene dazu. "
                     + "Was die Person selbst sammelt, bleibt ihre Sammlung — du siehst sie "
                     + "mit, sobald sie dich ebenfalls hineinlässt.")
            }

            if !model.household.isEmpty {
                Section {
                    ForEach(model.household) { user in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(user.displayName)
                                Text(user.email).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button {
                                Task { await model.share(with: user) }
                            } label: {
                                Image(systemName: "plus.circle")
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("\(user.displayName) mitschreiben lassen")
                        }
                    }
                } header: {
                    Text("Aus dem Haushalt")
                } footer: {
                    Text("Antippen lässt die Person in deine Ideen. Kein Link, keine Einladung "
                         + "per E-Mail — alle hier haben schon ein Konto.")
                }
            }
        }
        .navigationTitle("Wer schreibt mit")
        .navigationBarTitleDisplayMode(.inline)
        .plannerErrorBanner(model.errorMessage, retry: { await model.loadMembers() },
                            dismiss: { model.errorMessage = nil })
        .task { await model.loadMembers() }
        .refreshable { await model.loadMembers() }
        .confirmationDialog("Nicht mehr mitschreiben lassen?", isPresented: Binding(
            get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible, presenting: removing) { member in
            Button("\(member.displayName) entfernen", role: .destructive) {
                Task { await model.unshare(member) }
            }
            Button("Abbrechen", role: .cancel) {}
        } message: { member in
            Text("\(member.displayName) sieht deine Ideen danach nicht mehr. Die eigene "
                 + "Sammlung bleibt unberührt.")
        }
    }
}
