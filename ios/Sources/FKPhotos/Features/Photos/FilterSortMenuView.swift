import SwiftUI

/// Sheet for editing filter and sort state. Edits `viewModel.draft*` in place.
/// Only "Anwenden" writes through to applied state.
struct FilterSortMenuView: View {
    @Bindable var viewModel: FilterSortViewModel

    /// Which filter criteria to show — lets album/person views hide irrelevant options.
    var available: Set<FilterCriterion> = Set(FilterCriterion.allCases)

    enum FilterCriterion: String, CaseIterable {
        case favorite, hiddenMode, hasGps, dateRange
    }

    @State private var selectedYear: Int?  = nil
    @State private var selectedMonth: Int? = nil

    private static let calendar    = Calendar.current
    private static let currentYear = calendar.component(.year, from: Date())

    private var availableYears: [Int] {
        Array(stride(from: Self.currentYear, through: Self.currentYear - 30, by: -1))
    }

    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "de_DE")
        f.dateFormat = "LLLL"
        return f
    }()

    private func monthName(_ month: Int) -> String {
        var c = DateComponents()
        c.month = month; c.day = 1; c.year = 2000
        guard let d = Self.calendar.date(from: c) else { return "\(month)" }
        return Self.monthFormatter.string(from: d).capitalized
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

                // ── Date range — first filter, directly below sort ─────
                if available.contains(.dateRange) {
                    Section("Datum") {
                        Picker("Jahr", selection: $selectedYear) {
                            Text("–").tag(Int?.none)
                            ForEach(availableYears, id: \.self) { y in
                                Text(String(y)).tag(Int?.some(y))
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: selectedYear) { _, _ in
                            applyYearMonth()
                        }

                        Picker("Monat", selection: $selectedMonth) {
                            Text("–").tag(Int?.none)
                            ForEach(1...12, id: \.self) { m in
                                Text(monthName(m)).tag(Int?.some(m))
                            }
                        }
                        .pickerStyle(.menu)
                        .onChange(of: selectedMonth) { _, newMonth in
                            if newMonth != nil && selectedYear == nil {
                                selectedYear = Self.currentYear
                            } else {
                                applyYearMonth()
                            }
                        }

                        dateRow("Von", date: $viewModel.draftFilter.dateFrom, clearResetDropdowns: true)
                        dateRow("Bis",  date: $viewModel.draftFilter.dateTo,  clearResetDropdowns: false)
                    }
                }

                // ── Other filters ──────────────────────────────────────
                if available.contains(.favorite) || available.contains(.hiddenMode) {
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
                }

                if available.contains(.hasGps) {
                    Section("GPS-Standort") {
                        Picker("GPS-Standort", selection: $viewModel.draftFilter.hasGps) {
                            Text("Alle").tag(PhotoFilter.TriState.any)
                            Text("Mit GPS").tag(PhotoFilter.TriState.yes)
                            Text("Ohne GPS").tag(PhotoFilter.TriState.no)
                        }
                        .pickerStyle(.segmented)
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
            .onAppear { initDropdowns() }
        }
    }

    // MARK: - Optional date row

    @ViewBuilder
    private func dateRow(_ label: String, date: Binding<Date?>, clearResetDropdowns: Bool) -> some View {
        if let current = date.wrappedValue {
            HStack {
                DatePicker(
                    label,
                    selection: Binding(get: { current }, set: { date.wrappedValue = $0 }),
                    displayedComponents: .date
                )
                Button {
                    date.wrappedValue = nil
                    if clearResetDropdowns {
                        viewModel.draftFilter.dateTo = nil
                        selectedYear  = nil
                        selectedMonth = nil
                    }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        } else {
            HStack {
                Text(label)
                Spacer()
                Text("–")
                    .foregroundStyle(.secondary)
                Button {
                    date.wrappedValue = Self.calendar.startOfDay(for: Date())
                } label: {
                    Image(systemName: "plus.circle")
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Year/month logic

    private func initDropdowns() {
        selectedYear  = nil
        selectedMonth = nil
        guard let from = viewModel.draftFilter.dateFrom else { return }
        let cal = Self.calendar
        let fromComps = cal.dateComponents([.year, .month], from: from)
        selectedYear = fromComps.year
        if let to = viewModel.draftFilter.dateTo, let m = fromComps.month {
            let toComps = cal.dateComponents([.year, .month], from: to)
            if toComps.year == fromComps.year && toComps.month == m {
                selectedMonth = m
            }
        }
    }

    private func applyYearMonth() {
        let cal = Self.calendar
        guard let year = selectedYear else {
            viewModel.draftFilter.dateFrom = nil
            viewModel.draftFilter.dateTo   = nil
            return
        }
        if let month = selectedMonth {
            guard let from = cal.date(from: DateComponents(year: year, month: month, day: 1)) else { return }
            let nextMonth = cal.date(byAdding: .month, value: 1, to: from)!
            let lastDay   = cal.date(byAdding: .day,   value: -1, to: nextMonth)!
            viewModel.draftFilter.dateFrom = from
            viewModel.draftFilter.dateTo   = lastDay
        } else {
            let from = cal.date(from: DateComponents(year: year, month: 1,  day: 1))  ?? .distantPast
            let to   = cal.date(from: DateComponents(year: year, month: 12, day: 31)) ?? .distantPast
            viewModel.draftFilter.dateFrom = from
            viewModel.draftFilter.dateTo   = to
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
