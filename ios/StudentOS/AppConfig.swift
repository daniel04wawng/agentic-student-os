import Foundation

/// App configuration. The backend base URL is read from the app's Info.plist
/// key `BackendBaseURL` (set per build configuration), falling back to
/// localhost for the simulator. No secrets live here or in the client.
enum AppConfig {
    static var backendBaseURL: URL {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "BackendBaseURL") as? String,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "http://localhost:3000")!
    }
}
