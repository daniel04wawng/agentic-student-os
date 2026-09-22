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

    /// Supabase project URL for auth (e.g. https://<ref>.supabase.co). The anon
    /// key is a publishable key (safe to ship in the client) used only to reach
    /// the auth endpoints. Both come from Info.plist so builds can differ.
    static var supabaseURL: URL? {
        (Bundle.main.object(forInfoDictionaryKey: "SupabaseURL") as? String).flatMap(URL.init(string:))
    }

    static var supabaseAnonKey: String? {
        Bundle.main.object(forInfoDictionaryKey: "SupabaseAnonKey") as? String
    }

    /// True once the Supabase anon key is really set. Until then the app skips the
    /// login gate (legacy single-user), so shipping the sign-in build before the
    /// Supabase/Apple setup is done never locks anyone out of their own app.
    static var authConfigured: Bool {
        guard let key = supabaseAnonKey else { return false }
        return !key.isEmpty && key != "REPLACE_WITH_SUPABASE_ANON_KEY"
    }
}
