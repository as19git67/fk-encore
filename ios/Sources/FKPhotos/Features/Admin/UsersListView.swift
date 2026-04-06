import SwiftUI

struct UsersListView: View {
    @State private var viewModel = AdminViewModel()

    var body: some View {
        List {
            if viewModel.isLoading && viewModel.users.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
            } else if viewModel.users.isEmpty {
                ContentUnavailableView {
                    Label("Keine Benutzer", systemImage: "person.2")
                }
                .listRowSeparator(.hidden)
            } else {
                ForEach(viewModel.users) { user in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(user.name)
                            .font(.headline)
                        Text(user.email)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if !user.roles.isEmpty {
                            HStack {
                                ForEach(user.roles) { role in
                                    Text(role.name)
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 2)
                                        .background(.blue.opacity(0.15))
                                        .clipShape(Capsule())
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("Benutzer")
        .refreshable {
            await viewModel.loadUsers()
        }
        .task {
            await viewModel.loadUsers()
        }
    }
}
