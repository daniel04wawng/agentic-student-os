import SwiftUI

struct TodayView: View {
    @State private var today: TodayResponse?
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
                } else if let today {
                    List {
                        Section("Deadlines today") {
                            if today.deadlines.isEmpty {
                                Text("Nothing due today").foregroundStyle(.secondary)
                            } else {
                                ForEach(today.deadlines) { DeadlineRow(item: $0) }
                            }
                        }
                        Section("Notifications") {
                            if today.notifications.isEmpty {
                                Text("All clear").foregroundStyle(.secondary)
                            } else {
                                ForEach(today.notifications) { note in
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
            .navigationTitle("Today")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            today = try await client.today(timezone: TimeZone.current.identifier)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
