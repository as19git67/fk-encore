import SwiftUI

struct LoginView: View {
    @Environment(AuthManager.self) private var authManager
    @State private var viewModel = AuthViewModel()
    @State private var showRegister = false
    @State private var showServerConfig = false
    @AppStorage(APIClient.serverURLKey) private var serverURL: String = "http://localhost:4000"

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()

                // Logo / Title
                VStack(spacing: 8) {
                    Image(systemName: "photo.stack")
                        .font(.system(size: 64))
                        .foregroundStyle(.blue)
                    Text("FK Photos")
                        .font(.largeTitle.bold())
                    Text("Melde dich an, um fortzufahren")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                // Form
                VStack(spacing: 16) {
                    TextField("E-Mail", text: $viewModel.email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .padding()
                        .background(.quaternary)
                        .clipShape(RoundedRectangle(cornerRadius: 12))

                    SecureField("Passwort", text: $viewModel.password)
                        .textContentType(.password)
                        .padding()
                        .background(.quaternary)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .padding(.horizontal)

                // Error
                if let error = viewModel.errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                // Login Button
                Button {
                    Task {
                        await viewModel.login(authManager: authManager)
                    }
                } label: {
                    Group {
                        if viewModel.isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Anmelden")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(.blue)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .disabled(viewModel.isLoading)
                .padding(.horizontal)

                // Register Link
                Button("Noch kein Konto? Registrieren") {
                    showRegister = true
                }
                .font(.footnote)

                Spacer()

                // Server selection
                Button {
                    showServerConfig = true
                } label: {
                    Label(serverURL, systemImage: "server.rack")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.bottom, 8)
            }
            .navigationDestination(isPresented: $showRegister) {
                RegisterView()
            }
            .sheet(isPresented: $showServerConfig) {
                NavigationStack {
                    ServerSettingsView()
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Fertig") { showServerConfig = false }
                            }
                        }
                }
                .presentationDetents([.medium])
            }
        }
    }
}
