import SwiftUI

// MARK: - Selection checkmark overlay

struct SelectionCheckmark: View {
    let isSelected: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(isSelected ? Color.accentColor : Color.black.opacity(0.3))
                .frame(width: 24, height: 24)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
            } else {
                Circle()
                    .strokeBorder(.white, lineWidth: 1.5)
                    .frame(width: 24, height: 24)
            }
        }
    }
}

// MARK: - Photo share manager

@Observable @MainActor
final class PhotoShareManager {
    var isLoading = false
    var images: [UIImage] = []
    var isPresented = false

    func share(filenames: [String]) async {
        isLoading = true
        images = []
        for filename in filenames {
            if let cached = await ImageCache.shared.image(forKey: "photo-\(filename)") {
                images.append(cached)
            } else if let data = try? await APIClient.shared.downloadData("/photos/file/\(filename)"),
                      let image = UIImage(data: data) {
                images.append(image)
            }
        }
        isLoading = false
        if !images.isEmpty {
            isPresented = true
        }
    }
}

// MARK: - iOS share sheet wrapper

struct ActivityView: UIViewControllerRepresentable {
    let images: [UIImage]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: images, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Album pin storage

enum AlbumPinPreferences {
    private static let key = "albums.pinnedIds"

    static var pinnedIds: Set<Int> {
        get {
            guard let data = UserDefaults.standard.data(forKey: key),
                  let ids = try? JSONDecoder().decode(Set<Int>.self, from: data) else { return [] }
            return ids
        }
        set {
            let data = try? JSONEncoder().encode(newValue)
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
