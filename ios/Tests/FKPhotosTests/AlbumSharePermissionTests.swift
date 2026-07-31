import XCTest
@testable import FKPhotosLib

/// The iOS share sheet must offer exactly what the backend accepts (issue #918):
/// only the owner may grant `write_share`, and a delegate may only revoke
/// invitations they created themselves.
final class AlbumSharePermissionTests: XCTestCase {

    private func share(
        userId: Int,
        level: AlbumAccessLevel = .read,
        invitedBy: Int?
    ) -> AlbumShareWithUser {
        AlbumShareWithUser(
            album_id: 1,
            user_id: userId,
            access_level: level.rawValue,
            invited_by_user_id: invitedBy,
            user_name: "User \(userId)",
            user_email: "user\(userId)@example.com"
        )
    }

    func testOwnerCanGrantEveryLevel() {
        let vm = AlbumShareViewModel(albumId: 1, accessLevel: "owner", currentUserId: 7)
        XCTAssertTrue(vm.isOwner)
        XCTAssertEqual(vm.grantableAccessLevels, [.read, .write, .writeShare])
    }

    func testDelegateCannotGrantWriteShare() {
        let vm = AlbumShareViewModel(albumId: 1, accessLevel: "write_share", currentUserId: 7)
        XCTAssertFalse(vm.isOwner)
        XCTAssertEqual(vm.grantableAccessLevels, [.read, .write])
    }

    func testUnresolvedAccessLevelFallsBackToDelegateCapabilities() {
        let vm = AlbumShareViewModel(albumId: 1)
        XCTAssertFalse(vm.isOwner)
        XCTAssertEqual(vm.grantableAccessLevels, [.read, .write])
    }

    func testOwnerCanRemoveAnyShare() {
        let vm = AlbumShareViewModel(albumId: 1, accessLevel: "owner", currentUserId: 7)
        XCTAssertTrue(vm.canRemove(share(userId: 2, invitedBy: 99)))
        // Shares that predate `invited_by_user_id` are owner-managed.
        XCTAssertTrue(vm.canRemove(share(userId: 3, invitedBy: nil)))
    }

    func testDelegateRemovesOnlyOwnInvites() {
        let vm = AlbumShareViewModel(albumId: 1, accessLevel: "write_share", currentUserId: 7)
        XCTAssertTrue(vm.canRemove(share(userId: 2, invitedBy: 7)))
        XCTAssertFalse(vm.canRemove(share(userId: 3, invitedBy: 99)))
        XCTAssertFalse(vm.canRemove(share(userId: 4, invitedBy: nil)))
    }

    func testAvailableUsersExcludesExistingShares() {
        let vm = AlbumShareViewModel(albumId: 1, accessLevel: "owner", currentUserId: 7)
        vm.candidates = [
            ShareableUser(id: 2, name: "Anna", email: "anna@example.com"),
            ShareableUser(id: 3, name: "Bert", email: "bert@example.com"),
        ]
        vm.shares = [share(userId: 3, level: .write, invitedBy: 7)]
        XCTAssertEqual(vm.availableUsers.map(\.id), [2])
    }

    func testAccessLevelLabelsCoverEveryBackendValue() {
        XCTAssertEqual(AlbumAccessLevel(rawValue: "read"), .read)
        XCTAssertEqual(AlbumAccessLevel(rawValue: "write"), .write)
        XCTAssertEqual(AlbumAccessLevel(rawValue: "write_share"), .writeShare)
        XCTAssertNil(AlbumAccessLevel(rawValue: "owner"))
    }
}
