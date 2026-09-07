import SwiftUI

struct ReviewView: View {
    @State private var review: ReviewResponse?
    @State private var error: String?
    @State private var loading = true
    private let client = APIClient()

    private var isEmpty: Bool {
        (review?.notifications.isEmpty ?? true) && (review?.assignments.isEmpty ?? true)
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load", systemImage: "wifi.exclamationmark", description: Text(error))
                } else if isEmpty {
                    ContentUnavailableView("Nothing to review", systemImage: "checkmark.seal")
                } else if let review {
                    List {
                        if !review.assignments.isEmpty {
                            Section("Ready for review") {
                                ForEach(review.assignments) { Text($0.title) }
                            }
                        }
                        if !review.notifications.isEmpty {
                            Section("Review items") {
                                ForEach(review.notifications) { note in
                                    VStack(alignment: .leading) {
                                        Text(note.title).font(.headline)
                                        if let body = note.body { Text(body).font(.caption).foregroundStyle(.secondary) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Review")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            review = try await client.review()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
