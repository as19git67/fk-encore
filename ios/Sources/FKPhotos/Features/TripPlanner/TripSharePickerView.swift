import SwiftUI

/// Choose which trip a shared find goes into, and add an optional title
/// and note before handing off to analysis (§9.2).
///
/// The banner in `TripPlansListView` used to do this inline via a menu,
/// but a menu cannot hold a text field — and the title is the thing that
/// distinguishes "das coole Café" from a bare coordinate the traveller
/// will not recognise tomorrow. Turning the flow into a proper screen
/// also means two shares back-to-back no longer overwrite each other: the
/// inbox entry is not consumed until the screen is dismissed with
/// something added, so a second share simply waits.
struct TripSharePickerView: View {
    let payload: TripSharePayload
    let plans: [TripPlanSummary]
    @Binding var didAddAnything: Bool

    @State private var title: String
    @State private var note = ""
    @State private var selectedPlanId: Int?
    @State private var navigateToReview = false
    @Environment(\.dismiss) private var dismiss

    init(payload: TripSharePayload, plans: [TripPlanSummary], didAddAnything: Binding<Bool>) {
        self.payload = payload
        self.plans = plans
        _didAddAnything = didAddAnything
        _title = State(initialValue: payload.title ?? "")
        // Pre-select the only trip so the traveller can tap straight through.
        _selectedPlanId = State(initialValue: plans.count == 1 ? plans.first?.id : nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                if payload.url != nil || payload.text != nil {
                    Section("Quelle") {
                        if let url = payload.url {
                            Text(url).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        } else if let text = payload.text {
                            Text(text).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                }

                Section {
                    TextField("Titel", text: $title)
                    TextField("Notiz", text: $note, axis: .vertical)
                        .lineLimit(2...4)
                } header: {
                    Text("Zum Fund")
                } footer: {
                    Text("Der Titel wird zum Namen im Vorrat. Die Notiz bleibt am Fund.")
                }

                Section("Reise") {
                    ForEach(plans) { plan in
                        Button {
                            selectedPlanId = plan.id
                        } label: {
                            HStack {
                                Text(plan.displayTitle)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if selectedPlanId == plan.id {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Fund übernehmen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Weiter") { navigateToReview = true }
                        .disabled(selectedPlanId == nil)
                }
            }
            .navigationDestination(isPresented: $navigateToReview) {
                if let planId = selectedPlanId {
                    TripShareReviewView(
                        planId: planId,
                        payload: payload,
                        userTitle: title.trimmingCharacters(in: .whitespacesAndNewlines),
                        userNote: note.trimmingCharacters(in: .whitespacesAndNewlines),
                        didAddAnything: $didAddAnything
                    )
                }
            }
            // When the review view is dismissed (user pressed Fertig or back),
            // close the whole picker if something was successfully added.
            .onChange(of: navigateToReview) { _, showing in
                if !showing && didAddAnything { dismiss() }
            }
        }
    }
}
