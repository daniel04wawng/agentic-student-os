import SwiftUI

/// Recorded lectures with their AI notes. Tap a lecture to read the full notes.
struct LecturesView: View {
    @State private var lectures: [LectureItem] = []
    @State private var error: String?
    @State private var loading = true
    private let client = APIClient()

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load lectures", systemImage: "wifi.exclamationmark", description: Text(error))
                } else if lectures.isEmpty {
                    ContentUnavailableView("No lectures yet", systemImage: "waveform", description: Text("Record a class and its notes appear here."))
                } else {
                    List(lectures) { lecture in
                        NavigationLink(value: lecture) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(lecture.courseName ?? lecture.title ?? "Lecture").font(.headline)
                                if let when = lecture.recordedAt.flatMap(Self.when) {
                                    Text(when).font(.caption).foregroundStyle(.secondary)
                                }
                                Text(lecture.content.summary).font(.subheadline).lineLimit(2).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .navigationDestination(for: LectureItem.self) { LectureDetailView(lecture: $0) }
                }
            }
            .navigationTitle("Lectures")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            lectures = try await client.lectures()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    static func when(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) else { return iso }
        let f = DateFormatter()
        f.dateFormat = "EEE MMM d, h:mm a"
        return f.string(from: date)
    }
}

/// Full AI notes for one recorded lecture.
struct LectureDetailView: View {
    let lecture: LectureItem

    var body: some View {
        List {
            Section {
                Text(lecture.content.summary)
            } header: {
                Text(lecture.recordedAt.flatMap(LecturesView.when) ?? "Summary")
            }
            if !lecture.content.keyPoints.isEmpty {
                Section("Key points") {
                    ForEach(lecture.content.keyPoints, id: \.self) { Text($0) }
                }
            }
            if !lecture.content.actionItems.isEmpty {
                Section("Action items") {
                    ForEach(lecture.content.actionItems, id: \.self) { Label($0, systemImage: "checkmark.circle") }
                }
            }
            if !lecture.content.topics.isEmpty {
                Section("Topics") {
                    Text(lecture.content.topics.joined(separator: " · ")).foregroundStyle(.secondary)
                }
            }
            if !lecture.content.questions.isEmpty {
                Section("Follow-up questions") {
                    ForEach(lecture.content.questions, id: \.self) { Text($0) }
                }
            }
        }
        .navigationTitle(lecture.courseName ?? "Lecture")
        .navigationBarTitleDisplayMode(.inline)
    }
}
