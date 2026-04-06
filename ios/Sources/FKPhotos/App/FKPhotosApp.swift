import SwiftUI

@main
struct FKPhotosApp: App {
    @State private var authManager = AuthManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authManager)
                .task {
                    await APIClient.shared.setAuthManager(authManager)
                }
        }
    }
}
