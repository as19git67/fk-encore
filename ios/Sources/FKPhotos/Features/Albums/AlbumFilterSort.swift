import SwiftUI

// MARK: - AlbumFilter

struct AlbumFilter: Equatable, Codable {
    enum SharedMode: String, Equatable, Codable {
        case all, sharedOnly, notShared
        var label: String {
            switch self {
            case .all:        return "Alle"
            case .sharedOnly: return "Nur geteilte"
            case .notShared:  return "Nicht geteilt"
            }
        }
    }

    var sharedMode: SharedMode = .all
    var dateFrom: Date?        = nil
    var dateTo: Date?          = nil

    static let empty = AlbumFilter()
    var isEmpty: Bool { self == .empty }

    var activeCount: Int {
        var n = sharedMode != .all ? 1 : 0
        if dateFrom != nil || dateTo != nil { n += 1 }
        return n
    }

    func matches(_ album: Album) -> Bool {
        // Shared mode
        switch sharedMode {
        case .sharedOnly: if !album.is_shared { return false }
        case .notShared:  if  album.is_shared { return false }
        case .all: break
        }

        // Date range — mirrors web frontend: only checks newest_photo_at.
        if dateFrom != nil || dateTo != nil {
            guard let newestStr = album.newest_photo_at,
                  let albumNewest = PhotoFilter.parseDate(newestStr) else { return false }
            if let from = dateFrom, albumNewest < from { return false }
            if let to = dateTo {
                let endOfDay = Calendar.current.date(byAdding: .day, value: 1, to: to) ?? to
                if albumNewest >= endOfDay { return false }
            }
        }

        return true
    }
}

// MARK: - AlbumSortState

struct AlbumSortState: Equatable, Codable {
    enum Field: String, CaseIterable, Equatable, Codable {
        case newestPhoto = "newestPhoto"
        case name        = "name"
        case photoCount  = "photoCount"
        case createdAt   = "createdAt"

        var label: String {
            switch self {
            case .newestPhoto: return "Neuestes Foto"
            case .name:        return "Name"
            case .photoCount:  return "Anzahl Fotos"
            case .createdAt:   return "Erstellt"
            }
        }
    }

    enum Direction: String, Equatable, Codable {
        case asc, desc
        var label: String { self == .asc ? "Aufsteigend" : "Absteigend" }
    }

    var field: Field         = .newestPhoto
    var direction: Direction = .desc

    static let `default` = AlbumSortState()
    var isDefault: Bool { self == .default }

    var label: String { "\(field.label) \(direction == .asc ? "↑" : "↓")" }

    func comparator(_ a: Album, _ b: Album) -> Bool {
        switch field {
        case .newestPhoto:
            let av = a.newest_photo_at ?? ""
            let bv = b.newest_photo_at ?? ""
            return direction == .desc ? av > bv : av < bv
        case .name:
            return direction == .desc
                ? a.name.localizedCompare(b.name) == .orderedDescending
                : a.name.localizedCompare(b.name) == .orderedAscending
        case .photoCount:
            return direction == .desc ? a.photo_count > b.photo_count : a.photo_count < b.photo_count
        case .createdAt:
            return direction == .desc ? a.created_at > b.created_at : a.created_at < b.created_at
        }
    }
}

// MARK: - AlbumFilterSortViewModel

@Observable
final class AlbumFilterSortViewModel {
    var appliedFilter = AlbumFilter()
    var appliedSort   = AlbumSortState()
    var draftFilter   = AlbumFilter()
    var draftSort     = AlbumSortState()
    var isMenuPresented = false

    private let persistenceKey: String?

    init(persistenceKey: String? = nil) {
        self.persistenceKey = persistenceKey
        if let key = persistenceKey { load(key: key) }
    }

    var activeCount: Int {
        appliedFilter.activeCount + (appliedSort.isDefault ? 0 : 1)
    }

    func openMenu() {
        draftFilter = appliedFilter
        draftSort   = appliedSort
        isMenuPresented = true
    }

    func apply() {
        appliedFilter = draftFilter
        appliedSort   = draftSort
        isMenuPresented = false
        persist()
    }

    func resetAll() {
        appliedFilter = .empty
        appliedSort   = .default
        draftFilter   = .empty
        draftSort     = .default
        isMenuPresented = false
        persist()
    }

    // MARK: Persistence

    private struct Snapshot: Codable {
        var filter: AlbumFilter
        var sort: AlbumSortState
    }

    private func persist() {
        guard let key = persistenceKey else { return }
        if let data = try? JSONEncoder().encode(Snapshot(filter: appliedFilter, sort: appliedSort)) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private func load(key: String) {
        guard let data = UserDefaults.standard.data(forKey: key),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
        appliedFilter = snapshot.filter
        appliedSort   = snapshot.sort
        draftFilter   = snapshot.filter
        draftSort     = snapshot.sort
    }
}

// MARK: - AlbumFilterSortMenuView

struct AlbumFilterSortMenuView: View {
    @Bindable var viewModel: AlbumFilterSortViewModel

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
                Section("Sortierung") {
                    Picker("Feld", selection: $viewModel.draftSort.field) {
                        ForEach(AlbumSortState.Field.allCases, id: \.self) { f in
                            Text(f.label).tag(f)
                        }
                    }
                    .pickerStyle(.menu)
                    Picker("Richtung", selection: $viewModel.draftSort.direction) {
                        Text("Absteigend").tag(AlbumSortState.Direction.desc)
                        Text("Aufsteigend").tag(AlbumSortState.Direction.asc)
                    }
                    .pickerStyle(.segmented)
                }

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

                Section("Filter") {
                    Picker("Geteilt", selection: $viewModel.draftFilter.sharedMode) {
                        ForEach([AlbumFilter.SharedMode.all, .sharedOnly, .notShared], id: \.self) { m in
                            Text(m.label).tag(m)
                        }
                    }
                    .pickerStyle(.segmented)
                }
            }
            .navigationTitle("Filter & Sortierung")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Zurücksetzen") { viewModel.resetAll() }
                        .foregroundStyle(.red)
                        .disabled(viewModel.activeCount == 0)
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

// MARK: - AlbumFilterSortButton

struct AlbumFilterSortButton: View {
    let viewModel: AlbumFilterSortViewModel

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
