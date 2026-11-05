import QuickLook
import SafariServices
import SwiftUI

/// A document's PDF in a QuickLook preview: downloaded through the API
/// client (the file needs the bearer token), written to a temporary file,
/// shown, removed again.
struct PDFPreviewSheet: View {
    let item: PDFItem
    let api: AssistantAPI
    @State private var fileURL: URL?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let fileURL {
                    QuickLookPreview(url: fileURL)
                        .ignoresSafeArea(edges: .bottom)
                } else if let error {
                    ContentUnavailableView("Dokument nicht geladen", systemImage: "doc.text", description: Text(error))
                } else {
                    ProgressView("Dokument wird geladen …")
                }
            }
            .navigationTitle("Dokument")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fertig") { dismiss() }
                }
                if let fileURL {
                    ToolbarItem(placement: .topBarLeading) {
                        ShareLink(item: fileURL)
                    }
                }
            }
        }
        .task {
            do {
                let data = try await api.documentFile(id: item.documentId)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("assistant-document-\(item.documentId)-\(UUID().uuidString)")
                    .appendingPathExtension("pdf")
                try data.write(to: url, options: .atomic)
                fileURL = url
            } catch {
                self.error = error.localizedDescription
            }
        }
        .onDisappear {
            if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        }
    }
}

struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

/// `SFSafariViewController` for a row the app has no screen for: the web
/// app's page, signed in by the web app's own session until the handover
/// token of stage 5 exists (the page asks for a login once).
struct SafariSheet: UIViewControllerRepresentable {
    let url: URL
    let onDone: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}

    final class Coordinator: NSObject, SFSafariViewControllerDelegate {
        let onDone: () -> Void
        init(onDone: @escaping () -> Void) { self.onDone = onDone }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) { onDone() }
    }
}
