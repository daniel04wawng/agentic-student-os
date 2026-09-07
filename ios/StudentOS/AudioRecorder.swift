import AVFoundation
import Foundation

/// AVFoundation recorder. Writes audio durably to the store's directory as it
/// records, so a crash mid-recording still leaves a usable file. On stop it
/// registers a durable LocalRecording (upload state pending) for the queue.
@MainActor
final class AudioRecorder: ObservableObject {
    @Published private(set) var state: RecorderState = .idle

    private let store: RecordingStore
    private var recorder: AVAudioRecorder?
    private var currentId: String?
    private var startedAt: Date?

    init(store: RecordingStore) {
        self.store = store
    }

    func toggle() {
        state == .recording ? stop() : start()
    }

    func start() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)

            let id = UUID().uuidString.lowercased()
            let url = store.baseDir.appendingPathComponent("\(id).m4a")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100.0,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            guard recorder.record() else {
                state = RecorderState.reduce(state, .fail)
                return
            }
            self.recorder = recorder
            currentId = id
            startedAt = Date()
            state = RecorderState.reduce(state, .start)
        } catch {
            state = RecorderState.reduce(state, .fail)
        }
    }

    func stop() {
        guard let recorder, let id = currentId, let startedAt else { return }
        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        recorder.stop()

        // The audio file is already durable on disk; register it for upload.
        store.add(
            LocalRecording(
                id: id,
                filename: "\(id).m4a",
                contentType: "audio/m4a",
                capturedAt: startedAt,
                durationMs: durationMs,
                uploadState: .pending,
                lastError: nil
            )
        )
        self.recorder = nil
        currentId = nil
        self.startedAt = nil
        state = RecorderState.reduce(state, .stop)
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
