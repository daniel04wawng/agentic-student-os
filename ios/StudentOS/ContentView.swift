import SwiftUI

/// Placeholder root screen. Its only job in PR 0 is to prove the app builds and
/// can reach the backend `/health` endpoint. Real Today/Review/Deadlines UI
/// arrives in PR 7.
struct ContentView: View {
    @State private var statusText = "Not checked"
    @State private var isLoading = false

    private let client = APIClient()

    var body: some View {
        VStack(spacing: 16) {
            Text("Agentic Student OS")
                .font(.title2)
                .bold()
            Text(statusText)
                .foregroundStyle(.secondary)
            Button(action: checkHealth) {
                if isLoading {
                    ProgressView()
                } else {
                    Text("Check backend health")
                }
            }
            .disabled(isLoading)
        }
        .padding()
    }

    private func checkHealth() {
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                let health = try await client.health()
                statusText = "\(health.service): \(health.status.rawValue)"
            } catch {
                statusText = "Unreachable: \(error.localizedDescription)"
            }
        }
    }
}

#Preview {
    ContentView()
}
