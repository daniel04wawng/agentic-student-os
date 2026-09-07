import Foundation

/// Durable, on-disk registry of local recordings + their upload state. Backed by
/// a JSON index file in `baseDir`; the audio files live alongside it. Survives
/// app restarts (offline durability). Thread-confined to the main actor for
/// simplicity in the app; tests drive it directly.
@MainActor
final class RecordingStore: ObservableObject {
    let baseDir: URL
    private let indexURL: URL
    @Published private(set) var recordings: [LocalRecording] = []

    init(baseDir: URL) {
        self.baseDir = baseDir
        self.indexURL = baseDir.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: baseDir, withIntermediateDirectories: true)
        load()
    }

    func fileURL(for recording: LocalRecording) -> URL {
        baseDir.appendingPathComponent(recording.filename)
    }

    func add(_ recording: LocalRecording) {
        recordings.append(recording)
        save()
    }

    func markUploaded(_ id: String) {
        update(id) {
            $0.uploadState = .uploaded
            $0.lastError = nil
        }
    }

    func markFailed(_ id: String, error: String) {
        update(id) {
            $0.uploadState = .failed
            $0.lastError = error
        }
    }

    /// Recordings that still need to be uploaded (pending or previously failed).
    func pending() -> [LocalRecording] {
        recordings.filter { $0.uploadState == .pending || $0.uploadState == .failed }
    }

    private func update(_ id: String, _ mutate: (inout LocalRecording) -> Void) {
        guard let idx = recordings.firstIndex(where: { $0.id == id }) else { return }
        mutate(&recordings[idx])
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: indexURL) else { return }
        recordings = (try? JSONDecoder().decode([LocalRecording].self, from: data)) ?? []
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(recordings) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }
}
