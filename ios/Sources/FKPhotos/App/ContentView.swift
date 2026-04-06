import SwiftUI

struct ContentView: View {
    @Environment(AuthManager.self) private var authManager

    var body: some View {
        Group {
            if authManager.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        .animation(.easeInOut, value: authManager.isAuthenticated)
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
