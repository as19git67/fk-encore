import Foundation

/// Reviewing near-duplicates **within one album**.
///
/// On iOS the group review only existed as the standalone „Gruppen-Review"
/// queue over everything the user owns. The web has it inside an album too:
/// `AlbumDetailView.vue` lists `GET /photos/groups` and intersects each group
/// with the album's own photos, then opens the same comparison over what is
/// left (#1085 §2b). No server change is needed for that — the intersection is
/// the client's job in both places.
///
/// This is the intersection, as pure functions.
enum AlbumGroupReview {

    /// One near-duplicate group, as `GET /photos/groups` sends it.
    struct Group: Codable, Identifiable, Sendable, Equatable {
        let id: Int
        let cover_photo_id: Int?
        let member_count: Int
        let photo_ids: [Int]
        let reviewed_at: String?
        let ai_picked_photo_ids: [Int]?
        let ai_picked_confidence: String?
    }

    struct ListResponse: Codable, Sendable {
        let groups: [Group]
    }

    /// The groups worth offering inside an album.
    ///
    /// A group is trimmed to the album's own **visible** members: a photo
    /// already hidden is settled, and a group with one member left has nothing
    /// left to compare. Both rules are the web's.
    ///
    /// Order is by size, largest first — the group where a decision saves the
    /// most is the one to offer first — with the group id breaking ties so the
    /// list does not reshuffle between loads.
    static func scoped(
        groups: [Group],
        toVisiblePhotoIds visible: Set<Int>
    ) -> [Group] {
        groups
            .compactMap { group -> Group? in
                let members = group.photo_ids.filter { visible.contains($0) }
                guard members.count >= 2 else { return nil }
                let cover = group.cover_photo_id.flatMap {
                    visible.contains($0) ? $0 : nil
                } ?? members.first
                return Group(
                    id: group.id,
                    cover_photo_id: cover,
                    member_count: members.count,
                    photo_ids: members,
                    reviewed_at: group.reviewed_at,
                    ai_picked_photo_ids: group.ai_picked_photo_ids?.filter {
                        visible.contains($0)
                    },
                    ai_picked_confidence: group.ai_picked_confidence
                )
            }
            .sorted {
                if $0.member_count != $1.member_count {
                    return $0.member_count > $1.member_count
                }
                return $0.id < $1.id
            }
    }

    /// The album's photos that a group may still be scoped to: everything not
    /// already hidden.
    static func visibleIds(
        in photos: [PhotoWithCuration],
        overrides: [Int: CurationStatus] = [:]
    ) -> Set<Int> {
        Set(
            photos
                .filter { (overrides[$0.id] ?? $0.curation_status) != .hidden }
                .map(\.id)
        )
    }

    /// The comparison speaks `ReviewQueuePhoto`, and an album speaks
    /// `PhotoWithCuration`. This is the one adapter between them.
    ///
    /// `ai_picked` marks the AI's suggestion so the comparison can lead with
    /// it, exactly as the standalone queue does; peer curation is not part of
    /// an album's photo payload, so it stays nil rather than being invented.
    static func comparablePhotos(
        for group: Group,
        from photos: [PhotoWithCuration]
    ) -> [ReviewQueuePhoto] {
        let picked = Set(group.ai_picked_photo_ids ?? [])
        let byId = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
        return group.photo_ids.compactMap { id in
            guard let photo = byId[id] else { return nil }
            return ReviewQueuePhoto(
                id: photo.id,
                filename: photo.filename,
                taken_at: photo.taken_at,
                curation: photo.curation_status,
                ai_picked: picked.contains(photo.id),
                ai_quality_score: photo.ai_quality_score,
                peer_curation: nil,
                // `GET /photos/details` does not carry dimensions, so the
                // album-scoped comparison cannot split its keep set by
                // orientation the way the review queue does — every photo
                // reads as `.unknown` and the group is thinned as one. That
                // is the behaviour this path already had; giving it the
                // split too means widening the shared photo payload.
                width: nil,
                height: nil
            )
        }
    }

    /// `POST /photos/groups/:id/pick-photos`.
    struct PickRequest: Encodable, Sendable {
        let photoIds: [Int]
    }
}
