import SwiftUI

// MARK: - Upload Queue Detail

struct UploadQueueDetailView: View {
    @Bindable var observer: UploadQueueObserver

    var body: some View {
        List {
            if !observer.pendingItems.isEmpty {
                Section {
                    ForEach(observer.pendingItems) { item in
                        HStack(spacing: 12) {
                            Image(systemName: "arrow.up.circle")
                                .foregroundStyle(.orange)
                            Text(item.filename)
                                .font(.subheadline)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                } header: {
                    HStack {
                        Text("Ausstehend (\(observer.pendingItems.count))")
                        Spacer()
                        Button("Abbrechen") {
                            observer.cancelPending()
                        }
                        .font(.caption)
                        .foregroundStyle(.red)
                    }
                }
            }

            if !observer.failedItems.isEmpty {
                Section {
                    ForEach(observer.failedItems) { item in
                        HStack(spacing: 12) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.filename)
                                    .font(.subheadline)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                if let error = item.lastError {
                                    Text(error)
                                        .font(.caption)
                                        .foregroundStyle(.red)
                                        .lineLimit(2)
                                }
                                Text("Fehlgeschlagen\(item.retryCount > 1 ? " (\(item.retryCount)×)" : "")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                observer.remove(id: item.id)
                            } label: {
                                Label("Löschen", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("Fehlgeschlagen (\(observer.failedItems.count))")
                        Spacer()
                        Button {
                            observer.requeueAllFailed()
                        } label: {
                            Text("Alle erneut")
                                .font(.caption)
                        }
                        Button(role: .destructive) {
                            observer.removeAllFailed()
                        } label: {
                            Text("Alle löschen")
                                .font(.caption)
                        }
                    }
                }
            }

            if observer.pendingItems.isEmpty && observer.failedItems.isEmpty {
                ContentUnavailableView {
                    Label("Keine Einträge", systemImage: "checkmark.circle")
                } description: {
                    Text("Die Upload-Warteschlange ist leer.")
                }
                .listRowSeparator(.hidden)
            }
        }
        .navigationTitle("Upload-Warteschlange")
        .navigationBarTitleDisplayMode(.inline)
    }
}
