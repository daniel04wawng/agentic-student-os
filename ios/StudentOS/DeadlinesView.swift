import SwiftUI

/// Shared row rendering a deadline in both its source timezone and the device's
/// current timezone, so travel/DST never hides a shift.
struct DeadlineRow: View {
    let item: DeadlineItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title).font(.headline)
            Text(item.courseName).font(.caption).foregroundStyle(.secondary)
            if let source = item.deadline.source.display {
                Text("Due \(source.wallClock) (\(source.timezone))")
                    .font(.subheadline)
                    .foregroundStyle(item.past ? .red : .primary)
            }
            let current = item.deadline.current
            Text("Your time: \(current.wallClock) (\(current.timezone))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

struct DeadlinesView: View {
    @State private var deadlines: [DeadlineItem] = []
    @State private var error: String?
    @State private var loading = true
    private let client = APIClient()

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load", systemImage: "wifi.exclamationmark", description: Text(error))
                } else if deadlines.isEmpty {
                    ContentUnavailableView("No deadlines", systemImage: "calendar")
                } else {
                    List(deadlines) { DeadlineRow(item: $0) }
                }
            }
            .navigationTitle("Deadlines")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            deadlines = try await client.deadlines(timezone: TimeZone.current.identifier)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
