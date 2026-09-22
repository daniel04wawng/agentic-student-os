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

    /// Whether the app requires sign-in. Read from Info.plist `AuthRequired` so a
    /// build can ship with the gate OFF (legacy single-user) until the backend
    /// auth routes are deployed and Sign in with Apple is enabled - flipping this
    /// to true is what turns multi-user on, with no risk of an early lock-out.
    static var authRequired: Bool {
        (Bundle.main.object(forInfoDictionaryKey: "AuthRequired") as? Bool) ?? false
    }
}
