import Foundation
import Photos
import Observation

@Observable
final class LibraryBrowserViewModel {

    struct IOSAlbum: Identifiable, Hashable, Sendable {
        let id: String  // PHAssetCollection.localIdentifier
        let name: String
        let assetCount: Int
        let isSmart: Bool
        var syncStatus: SyncStatus

        enum SyncStatus: Hashable, Sendable {
            case none
            case copy
        }
    }

    var albums: [IOSAlbum] = []
    var isLoading = true
    var authorizationDenied = false

    func load() async {
        isLoading = true
        defer { isLoading = false }

        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        guard status == .authorized || status == .limited else {
            authorizationDenied = true
            return
        }

        let selectedIds = PhotoSyncPreferences.selectedAlbumIds
        let mappings = PhotoSyncPreferences.albumMappings
        let allLibrary = PhotoSyncPreferences.allLibrarySentinel

        let loaded: [IOSAlbum] = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let imageFilter = PHFetchOptions()
                imageFilter.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)

                let skipSubtypes: Set<PHAssetCollectionSubtype> = [
                    .smartAlbumVideos, .smartAlbumAllHidden, .smartAlbumSlomoVideos,
                    .smartAlbumTimelapses, .smartAlbumAnimated,
                    .smartAlbumGeneric, .smartAlbumSelfPortraits,
                    .smartAlbumLongExposures, .smartAlbumDepthEffect,
                    .smartAlbumLivePhotos, .smartAlbumBursts,
                    .smartAlbumScreenshots, .smartAlbumPanoramas,
                ]

                struct Raw {
                    let collection: PHAssetCollection
                    let title: String
                    let count: Int
                    let isSmart: Bool
                }

                var seenIds = Set<String>()
                var raw: [Raw] = []

                func collect(from result: PHFetchResult<PHAssetCollection>, isSmart: Bool) {
                    result.enumerateObjects { collection, _, _ in
                        if skipSubtypes.contains(collection.assetCollectionSubtype) { return }
                        guard seenIds.insert(collection.localIdentifier).inserted else { return }
                        let count = PHAsset.fetchAssets(in: collection, options: imageFilter).count
                        guard count > 0 else { return }
                        let title = collection.localizedTitle ?? "Unbekannt"
                        raw.append(Raw(collection: collection, title: title, count: count, isSmart: isSmart))
                    }
                }
                collect(from: PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil), isSmart: false)
                collect(from: PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .any, options: nil), isSmart: true)

                let isAllLibrary = selectedIds.contains(allLibrary)
                let result = raw.map { r -> IOSAlbum in
                    let localId = r.collection.localIdentifier
                    let synced = isAllLibrary || (selectedIds.contains(localId) && mappings[localId] != nil)
                    return IOSAlbum(
                        id: localId,
                        name: r.title,
                        assetCount: r.count,
                        isSmart: r.isSmart,
                        syncStatus: synced ? .copy : .none
                    )
                }
                continuation.resume(returning: result)
            }
        }

        albums = loaded.sorted { a, b in
            if a.syncStatus != .none && b.syncStatus == .none { return true }
            if a.syncStatus == .none && b.syncStatus != .none { return false }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
}
