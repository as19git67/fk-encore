import SwiftUI

public struct ContentView: View {
    @Environment(AuthManager.self) private var authManager

    public init() {}

    public var body: some View {
        Group {
            if authManager.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut, value: authManager.isAuthenticated)
        .task {
            // Inject the AuthManager into APIClient so requests can attach the token.
            await APIClient.shared.setAuthManager(authManager)
        }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            Tab("Fotos", systemImage: "photo.on.rectangle") {
                NavigationStack {
                    PhotoGridView()
                }
            }

            Tab("Alben", systemImage: "rectangle.stack") {
                NavigationStack {
                    AlbumsListView()
                }
            }

            Tab("Personen", systemImage: "person.2") {
                NavigationStack {
                    PersonsListView()
                }
            }

            Tab("Suche", systemImage: "magnifyingglass") {
                NavigationStack {
                    SearchView()
                }
            }

            Tab("Profil", systemImage: "person.circle") {
                NavigationStack {
                    AdminView()
                }
            }
        }
    }
}
