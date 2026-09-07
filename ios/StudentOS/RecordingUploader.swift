import Foundation

struct RegisterRecordingResponse: Codable {
    let id: String
    let uploadPath: String
}

/// Network surface the uploader needs. APIClient conforms; tests substitute a
/// fake so the queue logic is verifiable without a server.
protocol RecordingUploadService {
    func registerRecording(
        clientId: String,
        contentType: String,
        capturedAt: Date,
        durationMs: Int?
    ) async throws -> RegisterRecordingResponse
    func uploadRecordingAudio(uploadPath: String, data: Data, contentType: String) async throws
}

extension APIClient: RecordingUploadService {}

/// Drains the store's pending queue: register (idempotent on client id) then
/// upload the audio bytes. On failure the recording is marked failed but the
/// local file is kept, so a later `uploadPending()` retries it (resumable).
@MainActor
struct RecordingUploader {
    let service: RecordingUploadService
    let store: RecordingStore

    @discardableResult
    func uploadPending() async -> (uploaded: Int, failed: Int) {
        var uploaded = 0
        var failed = 0
        for rec in store.pending() {
            do {
                let data = try Data(contentsOf: store.fileURL(for: rec))
                let reg = try await service.registerRecording(
                    clientId: rec.id,
                    contentType: rec.contentType,
                    capturedAt: rec.capturedAt,
                    durationMs: rec.durationMs
                )
                try await service.uploadRecordingAudio(
                    uploadPath: reg.uploadPath,
                    data: data,
                    contentType: rec.contentType
                )
                store.markUploaded(rec.id)
                uploaded += 1
            } catch {
                store.markFailed(rec.id, error: error.localizedDescription)
                failed += 1
            }
        }
        return (uploaded, failed)
    }
}
