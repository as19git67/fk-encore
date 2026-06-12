import SwiftUI

struct FeedCommentSection: View {
    let photoId: Int
    let albumId: Int

    @State private var comments: [PhotoComment] = []
    @State private var isLoading = false
    @State private var newCommentText = ""
    @State private var isSending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()

            if isLoading && comments.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            } else if comments.isEmpty {
                Text("Noch keine Kommentare")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
            } else {
                ForEach(comments) { comment in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 4) {
                            Text(comment.author.name ?? "Unbekannt")
                                .font(.caption.bold())
                            Spacer()
                            Text(relativeDate(comment.createdAt))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        Text(comment.body)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Comment input
            HStack(spacing: 8) {
                TextField("Kommentar…", text: $newCommentText)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)

                Button {
                    Task { await sendComment() }
                } label: {
                    if isSending {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title3)
                    }
                }
                .disabled(newCommentText.trimmingCharacters(in: .whitespaces).isEmpty || isSending)
            }
        }
        .task {
            await loadComments()
        }
    }

    private func loadComments() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let query: [String: String] = [
                "albumId": "\(albumId)",
                "limit": "20",
            ]
            let response: ListCommentsResponse = try await APIClient.shared.get(
                "/photos/\(photoId)/comments", query: query
            )
            comments = response.comments
        } catch {
            // Silently fail
        }
    }

    @MainActor
    private func sendComment() async {
        let text = newCommentText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        isSending = true
        defer { isSending = false }

        do {
            let comment: PhotoComment = try await APIClient.shared.post(
                "/photos/\(photoId)/comments",
                body: CreateCommentRequest(body: text, albumId: albumId)
            )
            comments.insert(comment, at: 0)
            newCommentText = ""
        } catch {
            // Show error inline if needed
        }
    }

    private func relativeDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: isoString)
                ?? ISO8601DateFormatter().date(from: isoString) else {
            return ""
        }
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .short
        return relative.localizedString(for: date, relativeTo: Date())
    }
}
