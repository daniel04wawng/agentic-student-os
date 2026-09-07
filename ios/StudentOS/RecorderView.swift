import SwiftUI

struct RecorderView: View {
    @StateObject private var store: RecordingStore
    @StateObject private var recorder: AudioRecorder
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
            VStack(spacing: 16) {
                Button(action: recorder.toggle) {
                    Label(
                        isRecording ? "Stop" : "Record",
                        systemImage: isRecording ? "stop.circle.fill" : "mic.circle.fill"
                    )
                    .font(.title2)
                    .foregroundStyle(isRecording ? .red : .accentColor)
                }
                .padding(.top)

                if store.recordings.isEmpty {
                    ContentUnavailableView("No recordings yet", systemImage: "waveform")
                } else {
                    List(store.recordings) { rec in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(rec.capturedAt.formatted(date: .abbreviated, time: .shortened))
                                if let ms = rec.durationMs {
                                    Text("\(ms / 1000)s").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Text(rec.uploadState.rawValue)
                                .font(.caption)
                                .foregroundStyle(color(for: rec.uploadState))
                        }
                    }
                }

                Button(action: uploadPending) {
                    if uploading { ProgressView() } else { Text("Upload pending") }
                }
                .disabled(uploading || store.pending().isEmpty)
                .padding(.bottom)
            }
            .navigationTitle("Record")
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
        }
    }
}
