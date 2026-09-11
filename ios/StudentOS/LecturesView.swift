import SwiftUI

/// One place for lectures: record a class at the top, and read the AI notes for
/// past classes below. Recording, upload, transcription, and note-generation all
/// flow into the same list.
struct LecturesView: View {
    @StateObject private var store: RecordingStore
    @StateObject private var recorder: AudioRecorder
    @State private var lectures: [LectureItem] = []
    @State private var error: String?
    @State private var loading = true
    @State private var uploading = false
    private let client = APIClient()

    init() {
        let dir = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings")
        let store = RecordingStore(baseDir: dir)
        _store = StateObject(wrappedValue: store)
        _recorder = StateObject(wrappedValue: AudioRecorder(store: store))
    }

    private var isRecording: Bool { recorder.state == .recording }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    recordControls
                }
                if !inFlight.isEmpty {
                    Section("Processing") {
                        ForEach(inFlight) { rec in
                            HStack {
                                Text(rec.capturedAt.formatted(date: .abbreviated, time: .shortened))
                                Spacer()
                                Text(statusLabel(rec.uploadState))
                                    .font(.caption).foregroundStyle(color(for: rec.uploadState))
                            }
                        }
                    }
                }
                Section("Notes") {
                    if loading {
                        ProgressView()
                    } else if let error {
                        Text(error).font(.caption).foregroundStyle(.secondary)
                    } else if lectures.isEmpty {
                        Text("Record a class and its notes appear here.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    } else {
                        ForEach(lectures) { lecture in
                            NavigationLink(value: lecture) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(lecture.courseName ?? lecture.title ?? "Lecture").font(.headline)
                                    if let when = lecture.recordedAt.flatMap(Self.when) {
                                        Text(when).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Text(lecture.content.summary).font(.subheadline).lineLimit(2)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Lectures")
            .navigationDestination(for: LectureItem.self) { LectureDetailView(lecture: $0) }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    /// Big record/stop control plus an upload action for anything still local.
    private var recordControls: some View {
        VStack(spacing: 12) {
            Button(action: recorder.toggle) {
                Label(isRecording ? "Stop" : "Record a lecture",
                      systemImage: isRecording ? "stop.circle.fill" : "mic.circle.fill")
                    .font(.title2)
                    .foregroundStyle(isRecording ? .red : .accentColor)
                    .frame(maxWidth: .infinity)
            }
            if !store.pending().isEmpty {
                Button(action: uploadPending) {
                    if uploading { ProgressView() } else {
                        Text("Upload \(store.pending().count) pending")
                    }
                }
                .disabled(uploading)
            }
        }
        .padding(.vertical, 4)
    }

    /// Local recordings not yet uploaded (or failed) - shown so capture/upload is visible.
    private var inFlight: [LocalRecording] {
        store.recordings.filter { $0.uploadState != .uploaded }
    }

    private func statusLabel(_ s: UploadState) -> String {
        switch s {
        case .uploaded: return "uploaded"
        case .uploading: return "uploading…"
        case .failed: return "failed - retry"
        case .pending: return "not uploaded"
        }
    }

    private func color(for state: UploadState) -> Color {
        switch state {
        case .uploaded: return .green
        case .failed: return .red
        case .uploading: return .orange
        case .pending: return .secondary
        }
    }

    private func uploadPending() {
        uploading = true
        Task {
            defer { uploading = false }
            await RecordingUploader(service: client, store: store).uploadPending()
            await load()
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
