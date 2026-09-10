import SwiftUI

/// Upcoming classes with their prep. Tap a class to see the full worked prep.
struct PrepView: View {
    @State private var preps: [PrepItem] = []
    @State private var error: String?
    @State private var loading = true
    private let client = APIClient()

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load prep", systemImage: "wifi.exclamationmark", description: Text(error))
                } else if preps.isEmpty {
                    ContentUnavailableView("No prep yet", systemImage: "book", description: Text("Prep appears here before each class."))
                } else {
                    List(preps) { prep in
                        NavigationLink(value: prep) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(prep.courseName).font(.headline)
                                Text(Self.when(prep.startsAt)).font(.caption).foregroundStyle(.secondary)
                                Text(prep.content.overview).font(.subheadline).lineLimit(2).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .navigationDestination(for: PrepItem.self) { PrepDetailView(prep: $0) }
                }
            }
            .navigationTitle("Prep")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            preps = try await client.preps()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    static func when(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) else { return iso }
        let f = DateFormatter()
        f.dateFormat = "EEE MMM d, h:mm a"
        return f.string(from: date)
    }
}

/// Full worked prep for one class.
struct PrepDetailView: View {
    let prep: PrepItem

    var body: some View {
        List {
            Section {
                Text(prep.content.overview)
            } header: {
                Text(PrepView.when(prep.startsAt))
            }
            if !prep.content.keyPoints.isEmpty {
                Section("Key points") {
                    ForEach(prep.content.keyPoints, id: \.self) { Label($0, systemImage: "circle.fill").labelStyle(BulletLabel()) }
                }
            }
            if !prep.content.analysis.isEmpty {
                Section("Analysis") { Text(prep.content.analysis) }
            }
            if !prep.content.workedAnswer.isEmpty {
                Section("Worked answer") { Text(prep.content.workedAnswer).fontWeight(.medium) }
            }
            if !prep.content.questions.isEmpty {
                Section("Be ready to discuss") {
                    ForEach(prep.content.questions, id: \.self) { Text($0) }
                }
            }
        }
        .navigationTitle(prep.courseName)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Tiny bullet style for key points.
private struct BulletLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "circle.fill").font(.system(size: 5)).foregroundStyle(.secondary)
            configuration.title
        }
    }
}
