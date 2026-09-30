import Foundation
import UIKit

/// The one place a photo can live that both the app and the widget
/// extension can read: a folder inside the App Group container the
/// upload queue and `SharedStorage` already share.
///
/// `ImageCache` (the app's thumbnail cache) is in the app's own private
/// Caches directory, invisible to the extension's sandbox — which is
/// why the widgets were text-only at first (#764). The app writes a
/// small JPEG here for each widget that has a photo to show, and
/// `WidgetSnapshotStore` records the file's name in the snapshot the
/// extension reads. Only ever one file per widget: whatever the widget
/// currently shows, and nothing older.
public struct WidgetImageStore: Sendable {
    /// Longest side of a stored image, in pixels. A widget is at most a
    /// few hundred points wide and the extension runs under a tight
    /// memory limit, so a full-size photo is neither needed nor safe to
    /// decode there.
    public static let maxPixelSize: CGFloat = 800

    public static let shared = WidgetImageStore()

    public let directory: URL

    public init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else if let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: SharedStorage.appGroupID
        ) {
            self.directory = container.appendingPathComponent("widget-images", isDirectory: true)
        } else {
            // No app group (unit tests, say): the widgets will not find
            // this, but the app still behaves.
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            self.directory = caches.appendingPathComponent("widget-images", isDirectory: true)
        }
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    /// The file name a widget's image for a given photo is stored under.
    /// The photo id is part of the name so a snapshot can tell whether
    /// the file on disk is the photo it currently names.
    public static func fileName(widget: String, photoId: Int) -> String {
        "\(widget)-\(photoId).jpg"
    }

    /// Downscales `data` (any format `UIImage` decodes, HEIC included)
    /// and writes it as a JPEG for `widget`, removing that widget's
    /// previous file. Returns the stored file name, or nil when the
    /// data was not an image or could not be written.
    @discardableResult
    public func store(_ data: Data, widget: String, photoId: Int) -> String? {
        guard let image = UIImage(data: data),
              let jpeg = Self.downscaled(image)?.jpegData(compressionQuality: 0.8) else {
            return nil
        }
        let name = Self.fileName(widget: widget, photoId: photoId)
        do {
            try jpeg.write(to: directory.appendingPathComponent(name), options: .atomic)
        } catch {
            return nil
        }
        removeFiles(for: widget, except: name)
        return name
    }

    /// Whether the file a snapshot names is still on disk.
    public func contains(_ fileName: String) -> Bool {
        FileManager.default.fileExists(atPath: directory.appendingPathComponent(fileName).path)
    }

    /// Deletes every image stored for `widget`.
    public func remove(widget: String) {
        removeFiles(for: widget, except: nil)
    }

    /// The image a snapshot names, decoded — for the extension.
    public func image(named fileName: String?) -> UIImage? {
        guard let fileName else { return nil }
        return UIImage(contentsOfFile: directory.appendingPathComponent(fileName).path)
    }

    private func removeFiles(for widget: String, except keep: String?) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names where name.hasPrefix("\(widget)-") && name != keep {
            try? fm.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    static func downscaled(_ image: UIImage) -> UIImage? {
        let size = image.size
        let scale = image.scale
        let longest = max(size.width, size.height) * scale
        guard longest > maxPixelSize else { return image }
        let factor = maxPixelSize / longest
        let target = CGSize(width: size.width * scale * factor, height: size.height * scale * factor)
        return image.preparingThumbnail(of: target)
    }
}
