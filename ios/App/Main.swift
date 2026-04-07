import SwiftUI
import FKPhotosLib

@main
struct FKPhotosEntry: App {
    @State private var authManager = AuthManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authManager)
        }
    }
}
