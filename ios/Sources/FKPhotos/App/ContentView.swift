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
    @State private var feedViewModel = FeedViewModel()

    var body: some View {
        TabView {
            Tab("Feed", systemImage: "house") {
                NavigationStack {
                    FeedView()
                }
            }
            .badge(feedViewModel.unreadCount)

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

            Tab("Einstellungen", systemImage: "gearshape") {
                NavigationStack {
                    AdminView()
                }
            }
        }
        .task {
            await feedViewModel.refreshUnreadCount()
        }
    }
}
