import SwiftUI

/// Sheet for editing filter and sort state. Edits `viewModel.draft*` in place.
/// Only "Anwenden" writes through to applied state.
struct FilterSortMenuView: View {
    @Bindable var viewModel: FilterSortViewModel

    /// Which filter criteria to show — lets album/person views hide irrelevant options.
    var available: Set<FilterCriterion> = Set(FilterCriterion.allCases)

    enum FilterCriterion: String, CaseIterable {
        case favorite, hiddenMode, mediaType, hasGps, dateRange
    }

    var body: some View {
        NavigationStack {
            Form {
                // ── Sort ───────────────────────────────────────────────
                Section("Sortierung") {
                    Picker("Feld", selection: $viewModel.draftSort.field) {
                        ForEach(PhotoSortState.Field.allCases, id: \.self) { f in
                            Text(f.label).tag(f)
                        }
                    }
                    .pickerStyle(.menu)
                    Picker("Richtung", selection: $viewModel.draftSort.direction) {
                        Text("Absteigend").tag(PhotoSortState.Direction.desc)
                        Text("Aufsteigend").tag(PhotoSortState.Direction.asc)
                    }
                    .pickerStyle(.segmented)
                }

                // ── Filter ─────────────────────────────────────────────
                Section("Filter") {
                    if available.contains(.favorite) {
                        Toggle("Nur Favoriten", isOn: Binding(
                            get: { viewModel.draftFilter.favorite == true },
                            set: { viewModel.draftFilter.favorite = $0 ? true : nil }
                        ))
                    }

                    if available.contains(.hiddenMode) {
                        Picker("Ausgeblendet", selection: $viewModel.draftFilter.hiddenMode) {
                            Text("Ohne").tag(PhotoFilter.HiddenMode.exclude)
                            Text("Mit").tag(PhotoFilter.HiddenMode.include)
                            Text("Nur").tag(PhotoFilter.HiddenMode.only)
                        }
                        .pickerStyle(.segmented)
                    }
                }

                if available.contains(.mediaType) {
                    Section("Medientyp") {
                        mediaTypeRow
                    }
                }

                if available.contains(.hasGps) || available.contains(.dateRange) {
                    Section("Weitere Filter") {
                        if available.contains(.hasGps) {
                            Picker("GPS-Daten", selection: $viewModel.draftFilter.hasGps) {
                                ForEach([PhotoFilter.TriState.any, .yes, .no], id: \.self) { s in
                                    Text(s.label).tag(s)
                                }
                            }
                            .pickerStyle(.segmented)
                        }

                        if available.contains(.dateRange) {
                            DatePicker(
                                "Von",
                                selection: Binding(
                                    get: { viewModel.draftFilter.dateFrom ?? Date.distantPast },
                                    set: { viewModel.draftFilter.dateFrom = $0 }
                                ),
                                displayedComponents: .date
                            )
                            .onChange(of: viewModel.draftFilter.dateFrom) { _, v in
                                if v == Date.distantPast { viewModel.draftFilter.dateFrom = nil }
                            }

                            if viewModel.draftFilter.dateFrom != nil {
                                DatePicker(
                                    "Bis",
                                    selection: Binding(
                                        get: { viewModel.draftFilter.dateTo ?? Date() },
                                        set: { viewModel.draftFilter.dateTo = $0 }
                                    ),
                                    in: (viewModel.draftFilter.dateFrom ?? .distantPast)...,
                                    displayedComponents: .date
                                )

                                Button("Datum zurücksetzen", role: .destructive) {
                                    viewModel.draftFilter.dateFrom = nil
                                    viewModel.draftFilter.dateTo   = nil
                                }
                                .font(.footnote)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Filter & Sortierung")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Zurücksetzen") { viewModel.resetAll() }
                        .foregroundStyle(.red)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Anwenden") { viewModel.apply() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    // Chip-style multi-select for media types
    @ViewBuilder
    private var mediaTypeRow: some View {
        HStack(spacing: 8) {
            ForEach(PhotoFilter.MediaType.allCases, id: \.self) { mt in
                let selected = viewModel.draftFilter.mediaTypes.contains(mt)
                Button {
                    if selected {
                        viewModel.draftFilter.mediaTypes.removeAll { $0 == mt }
                    } else {
                        viewModel.draftFilter.mediaTypes.append(mt)
                    }
                } label: {
                    Text(mt.label)
                        .font(.subheadline)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(selected ? Color.accentColor : Color(.systemFill))
                        .foregroundStyle(selected ? .white : .primary)
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }
}

#Preview("Leer") {
    FilterSortMenuView(viewModel: FilterSortViewModel())
}

#Preview("Favoriten + Qualität") {
    let vm = FilterSortViewModel()
    vm.draftFilter.favorite = true
    vm.draftFilter.mediaTypes = [.photo]
    vm.draftSort.field = .qualityScore
    return FilterSortMenuView(viewModel: vm)
}

// MARK: - Toolbar button with active-count badge

struct FilterSortButton: View {
    let viewModel: FilterSortViewModel

    var body: some View {
        Button { viewModel.openMenu() } label: {
            Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                .symbolVariant(viewModel.activeCount > 0 ? .fill : .none)
                .overlay(alignment: .topTrailing) {
                    if viewModel.activeCount > 0 {
                        Text("\(viewModel.activeCount)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 14, height: 14)
                            .background(Color.accentColor)
                            .clipShape(Circle())
                            .offset(x: 6, y: -6)
                    }
                }
        }
    }
}
