import SwiftUI

struct PhotoMetadataView: View {
    var viewModel: PhotoMetadataViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showDatePicker = false
    @State private var editedDate: Date = Date()

    var body: some View {
        NavigationStack {
            List {
                // Date
                Section {
                    HStack {
                        Text(formattedDate)
                            .font(.subheadline)
                        Spacer()
                        Button {
                            editedDate = parsedDate ?? Date()
                            showDatePicker = true
                        } label: {
                            Image(systemName: "calendar")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // Location
                if viewModel.photo.location_name != nil || viewModel.photo.location_city != nil {
                    Section("Ort") {
                        Text(locationText)
                            .font(.subheadline)
                    }
                }

                // Persons
                if !viewModel.facesLoadFailed {
                    Section("Personen") {
                        if viewModel.isLoadingFaces {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                        } else if viewModel.namedFaces.isEmpty {
                            Text("Keine Personen erkannt")
                                .foregroundStyle(.secondary)
                                .font(.subheadline)
                        } else {
                            ForEach(viewModel.namedFaces) { face in
                                Label(face.personName, systemImage: "person")
                                    .font(.subheadline)
                            }
                        }
                    }
                }

                // Albums
                Section("Alben") {
                    if viewModel.isLoadingAlbums {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        ForEach(viewModel.sortedAlbums) { album in
                            Button {
                                viewModel.toggleAlbum(album.id)
                            } label: {
                                HStack {
                                    Image(systemName: viewModel.albumCheckState(for: album.id)
                                          ? "checkmark.square.fill" : "square")
                                        .foregroundStyle(viewModel.albumCheckState(for: album.id)
                                                         ? Color.accentColor : .secondary)
                                    Text(album.name)
                                        .foregroundStyle(.primary)
                                }
                            }
                        }
                        if viewModel.hasPendingAlbumChanges {
                            Button {
                                Task { await viewModel.saveAlbumChanges() }
                            } label: {
                                if viewModel.isSavingAlbums {
                                    ProgressView()
                                        .frame(maxWidth: .infinity)
                                } else {
                                    Text("Speichern")
                                        .frame(maxWidth: .infinity, alignment: .center)
                                }
                            }
                            .disabled(viewModel.isSavingAlbums)
                        }
                    }
                }

                // AI quality score
                if let score = viewModel.photo.ai_quality_score {
                    Section("Bewertung") {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 6) {
                                // Star icons
                                let stars = Int((score * 4).rounded())
                                HStack(spacing: 2) {
                                    ForEach(0..<4, id: \.self) { i in
                                        Image(systemName: i < stars ? "star.fill" : "star")
                                            .font(.caption)
                                            .foregroundStyle(i < stars ? .yellow : .secondary)
                                    }
                                }
                                Text("\(Int((score * 4).rounded())) von 4")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            ProgressView(value: score)
                                .tint(.yellow)
                        }
                        .padding(.vertical, 4)
                    }
                }

                // File info
                Section("Datei") {
                    LabeledContent("Name", value: viewModel.photo.original_name)
                        .font(.subheadline)
                    LabeledContent("Größe", value: formatBytes(viewModel.photo.size))
                        .font(.subheadline)
                }
            }
            .navigationTitle("Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
            }
            .sheet(isPresented: $showDatePicker) {
                NavigationStack {
                    DatePicker(
                        "Datum und Uhrzeit",
                        selection: $editedDate,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    .datePickerStyle(.graphical)
                    .padding()
                    .navigationTitle("Datum ändern")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Abbrechen") { showDatePicker = false }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Speichern") {
                                showDatePicker = false
                                Task { await viewModel.updatePhotoDate(editedDate) }
                            }
                            .fontWeight(.semibold)
                        }
                    }
                }
                .presentationDetents([.medium, .large])
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task {
            await viewModel.loadAll()
        }
    }

    private var formattedDate: String {
        let dateStr = viewModel.takenAt ?? viewModel.photo.created_at
        guard let d = parseISO(dateStr) else { return dateStr }
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        formatter.timeStyle = .short
        return formatter.string(from: d)
    }

    private var parsedDate: Date? {
        let dateStr = viewModel.takenAt ?? viewModel.photo.created_at
        return parseISO(dateStr)
    }

    private func parseISO(_ str: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: str) { return d }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: str)
    }

    private var locationText: String {
        let primary = viewModel.photo.location_name ?? viewModel.photo.location_city
        let parts = [primary, viewModel.photo.location_country].compactMap { $0 }
        return parts.joined(separator: ", ")
    }

    private func formatBytes(_ bytes: Int) -> String {
        let mb = Double(bytes) / 1_048_576
        return String(format: "%.2f MB", mb)
    }
}
