import XCTest
@testable import StudentOS

/// Fake upload service so the queue logic is verified without a server.
final class FakeUploadService: RecordingUploadService {
    var failUpload = false
    private(set) var uploadedCount = 0

    func registerRecording(
        clientId: String,
        contentType: String,
        capturedAt: Date,
        durationMs: Int?
    ) async throws -> RegisterRecordingResponse {
        RegisterRecordingResponse(id: "srv-\(clientId)", uploadPath: "/recordings/\(clientId)/audio")
    }

    func uploadRecordingAudio(uploadPath: String, data: Data, contentType: String) async throws {
        if failUpload { throw URLError(.notConnectedToInternet) }
        uploadedCount += 1
    }
}

@MainActor
final class RecordingLogicTests: XCTestCase {
    private func tempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("rec-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func makeRecording(in store: RecordingStore, id: String = UUID().uuidString.lowercased()) -> LocalRecording {
        let rec = LocalRecording(
            id: id, filename: "\(id).m4a", contentType: "audio/m4a",
            capturedAt: Date(), durationMs: 1000, uploadState: .pending, lastError: nil
        )
        // Write a real (fake) audio file so the uploader can read bytes.
        try? Data("audio".utf8).write(to: store.fileURL(for: rec))
        store.add(rec)
        return rec
    }

    func testStateMachineTransitions() {
        XCTAssertEqual(RecorderState.reduce(.idle, .start), .recording)
        XCTAssertEqual(RecorderState.reduce(.recording, .stop), .stopped)
        XCTAssertEqual(RecorderState.reduce(.recording, .fail), .failed)
        XCTAssertEqual(RecorderState.reduce(.stopped, .reset), .idle)
        // invalid transition is ignored
        XCTAssertEqual(RecorderState.reduce(.idle, .stop), .idle)
    }

    func testStorePersistsAcrossReload() {
        let dir = tempDir()
        let store = RecordingStore(baseDir: dir)
        _ = makeRecording(in: store, id: "a")
        XCTAssertEqual(store.pending().count, 1)

        // Reload from disk (offline durability).
        let reloaded = RecordingStore(baseDir: dir)
        XCTAssertEqual(reloaded.recordings.count, 1)
        XCTAssertEqual(reloaded.recordings.first?.id, "a")
    }

    func testUploadPendingSuccessMarksUploaded() async {
        let store = RecordingStore(baseDir: tempDir())
        _ = makeRecording(in: store)
        let result = await RecordingUploader(service: FakeUploadService(), store: store).uploadPending()
        XCTAssertEqual(result.uploaded, 1)
        XCTAssertEqual(store.pending().count, 0)
        XCTAssertEqual(store.recordings.first?.uploadState, .uploaded)
    }

    func testUploadFailureKeepsItemForRetry() async {
        let store = RecordingStore(baseDir: tempDir())
        let rec = makeRecording(in: store)
        let service = FakeUploadService()
        service.failUpload = true

        let failed = await RecordingUploader(service: service, store: store).uploadPending()
        XCTAssertEqual(failed.failed, 1)
        XCTAssertEqual(store.recordings.first?.uploadState, .failed)
        // File is kept and still pending for retry.
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL(for: rec).path))
        XCTAssertEqual(store.pending().count, 1)

        // Retry with a working service succeeds (resumable).
        service.failUpload = false
        let retry = await RecordingUploader(service: service, store: store).uploadPending()
        XCTAssertEqual(retry.uploaded, 1)
        XCTAssertEqual(store.recordings.first?.uploadState, .uploaded)
    }
}
