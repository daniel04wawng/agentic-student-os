import Foundation

/// Recorder state machine. Kept as a pure reducer so transitions are unit
/// testable without a microphone.
enum RecorderState: String, Equatable {
    case idle
    case recording
    case stopped
    case failed
}

enum RecorderEvent {
    case start
    case stop
    case fail
    case reset
}

extension RecorderState {
    static func reduce(_ state: RecorderState, _ event: RecorderEvent) -> RecorderState {
        switch (state, event) {
        case (_, .reset):
            return .idle
        // Start a recording from any non-recording state, so you can record
        // again after a previous one stopped or failed.
        case (.idle, .start), (.stopped, .start), (.failed, .start):
            return .recording
        case (.recording, .stop):
            return .stopped
        case (.recording, .fail):
            return .failed
        default:
            return state // ignore invalid transitions
        }
    }
}

/// Upload lifecycle of a locally-captured recording. The local audio file is
/// durable and independent of upload state, so a failed upload never loses it.
enum UploadState: String, Codable {
    case pending
    case uploading
    case uploaded
    case failed
}

/// A recording captured on device. `id` is the client-generated id used for
/// idempotent server registration. The audio lives at `filename` under the
/// store's base directory.
struct LocalRecording: Codable, Identifiable, Equatable {
    let id: String
    let filename: String
    let contentType: String
    let capturedAt: Date
    var durationMs: Int?
    var uploadState: UploadState
    var lastError: String?
}
