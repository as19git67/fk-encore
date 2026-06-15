import Foundation
import Security

enum KeychainHelper {
    private static let service = "dev.fk-encore.FKPhotos"

    /// Stores `data` under `key`. `accessible` controls when the item is
    /// readable; it defaults to `kSecAttrAccessibleAfterFirstUnlock` so tokens
    /// remain available to background tasks after the first unlock. Pass
    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for more sensitive
    /// items (e.g. a stored password) that must never sync to iCloud or appear
    /// in encrypted backups.
    static func save(
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

    static func load(forKey key: String) -> Data? {
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

    static func delete(forKey key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func saveString(
        _ value: String,
        forKey key: String,
        accessible: CFString = kSecAttrAccessibleAfterFirstUnlock
    ) throws {
        guard let data = value.data(using: .utf8) else { return }
        try save(data, forKey: key, accessible: accessible)
    }

    static func loadString(forKey key: String) -> String? {
        guard let data = load(forKey: key) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

enum KeychainError: Error, LocalizedError {
    case saveFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .saveFailed(let status):
            return "Keychain save failed with status: \(status)"
        }
    }
}
