import Foundation
import Security

/// The app's Keychain items, under one service name shared by every app
/// built on this package: a session stored by one is read by the next.
public enum KeychainHelper {
    private static let service = "dev.fk-encore.FKPhotos"

    /// Stores `data` under `key`. `accessible` controls when the item is
    /// readable; it defaults to `kSecAttrAccessibleAfterFirstUnlock` so tokens
    /// remain available to background tasks after the first unlock. Pass
    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for more sensitive
    /// items (e.g. a stored password) that must never sync to iCloud or appear
    /// in encrypted backups.
    public static func save(
        _ data: Data,
        forKey key: String,
        accessible: CFString = kSecAttrAccessibleAfterFirstUnlock
    ) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]

        // Delete existing item first
        SecItemDelete(query as CFDictionary)

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = accessible

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    public static func load(forKey key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    public static func delete(forKey key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    public static func saveString(
        _ value: String,
        forKey key: String,
        accessible: CFString = kSecAttrAccessibleAfterFirstUnlock
    ) throws {
        guard let data = value.data(using: .utf8) else { return }
        try save(data, forKey: key, accessible: accessible)
    }

    public static func loadString(forKey key: String) -> String? {
        guard let data = load(forKey: key) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

public enum KeychainError: Error, LocalizedError {
    case saveFailed(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .saveFailed(let status):
            return "Keychain save failed with status: \(status)"
        }
    }
}
