import CryptoKit
import Foundation

/// The current access token, readable synchronously by the (struct) APIClient so
/// every request can attach `Authorization: Bearer`. AuthStore keeps it current.
final class AuthTokenBox {
    static let shared = AuthTokenBox()
    private let lock = NSLock()
    private var value: String?
    var token: String? {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

/// A Supabase auth session persisted between launches.
struct SupabaseSession: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let userId: String
    let email: String?
}

enum AuthError: LocalizedError {
    case notConfigured
    case server(String)
    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Sign-in isn't configured yet."
        case .server(let m): return m
        }
    }
}

/// Owns the signed-in session. Exchanges a Sign in with Apple identity token for a
/// Supabase session over Supabase's REST auth endpoint (no SDK needed), persists
/// it in the Keychain, and keeps the shared access token fresh for API calls.
@MainActor
final class AuthStore: ObservableObject {
    @Published private(set) var session: SupabaseSession?
    @Published var errorMessage: String?
    @Published var working = false

    var isSignedIn: Bool { session != nil }
    private let sessionKey = "supabase.session"

    init() {
        if let data = Keychain.get(sessionKey),
           let s = try? JSONDecoder().decode(SupabaseSession.self, from: data) {
            session = s
            AuthTokenBox.shared.token = s.accessToken
        }
    }

    func signInWithApple(idToken: String, rawNonce: String) async {
        working = true; defer { working = false }
        do {
            let s = try await tokenRequest(grant: "id_token",
                                           body: ["provider": "apple", "id_token": idToken, "nonce": rawNonce])
            persist(s); errorMessage = nil
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn't sign in."
        }
    }

    /// Email one-time-code fallback: send a 6-digit code to the address.
    func sendEmailCode(_ email: String) async -> Bool {
        working = true; defer { working = false }
        guard let base = AppConfig.supabaseURL, let anon = AppConfig.supabaseAnonKey, !anon.isEmpty else {
            errorMessage = AuthError.notConfigured.errorDescription; return false
        }
        var req = URLRequest(url: base.appendingPathComponent("auth/v1/otp"))
        req.httpMethod = "POST"
        req.setValue(anon, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "create_user": true])
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                errorMessage = String(data: data, encoding: .utf8) ?? "Couldn't send the code."; return false
            }
            errorMessage = nil; return true
        } catch { errorMessage = "Couldn't send the code."; return false }
    }

    /// Verify the emailed code and establish a session.
    func verifyEmailCode(email: String, code: String) async {
        working = true; defer { working = false }
        guard let base = AppConfig.supabaseURL, let anon = AppConfig.supabaseAnonKey, !anon.isEmpty else {
            errorMessage = AuthError.notConfigured.errorDescription; return
        }
        var req = URLRequest(url: base.appendingPathComponent("auth/v1/verify"))
        req.httpMethod = "POST"
        req.setValue(anon, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["email": email, "token": code, "type": "email"])
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                errorMessage = String(data: data, encoding: .utf8) ?? "That code didn't work."; return
            }
            let r = try JSONDecoder().decode(TokenResponse.self, from: data)
            let expiry = r.expires_at.map { Date(timeIntervalSince1970: $0) } ?? Date().addingTimeInterval(r.expires_in ?? 3600)
            persist(SupabaseSession(accessToken: r.access_token, refreshToken: r.refresh_token,
                                    expiresAt: expiry, userId: r.user.id, email: r.user.email))
            errorMessage = nil
        } catch { errorMessage = "That code didn't work." }
    }

    /// Refresh the access token when it's close to expiry. Called on launch and
    /// when the app returns to the foreground. Failure keeps the old session.
    func refreshIfNeeded() async {
        guard let s = session, s.expiresAt.timeIntervalSinceNow < 120 else { return }
        if let ns = try? await tokenRequest(grant: "refresh_token", body: ["refresh_token": s.refreshToken]) {
            persist(ns)
        }
    }

    func signOut() {
        session = nil
        AuthTokenBox.shared.token = nil
        Keychain.delete(sessionKey)
    }

    private func persist(_ s: SupabaseSession) {
        session = s
        AuthTokenBox.shared.token = s.accessToken
        if let d = try? JSONEncoder().encode(s) { Keychain.set(d, for: sessionKey) }
    }

    private struct TokenResponse: Decodable {
        let access_token: String
        let refresh_token: String
        let expires_at: Double?
        let expires_in: Double?
        struct User: Decodable { let id: String; let email: String? }
        let user: User
    }

    private func tokenRequest(grant: String, body: [String: Any]) async throws -> SupabaseSession {
        guard let base = AppConfig.supabaseURL, let anon = AppConfig.supabaseAnonKey, !anon.isEmpty else {
            throw AuthError.notConfigured
        }
        var comps = URLComponents(url: base.appendingPathComponent("auth/v1/token"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "grant_type", value: grant)]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.setValue(anon, forHTTPHeaderField: "apikey")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let msg = String(data: data, encoding: .utf8) ?? "sign-in failed"
            throw AuthError.server(msg)
        }
        let r = try JSONDecoder().decode(TokenResponse.self, from: data)
        let expiry = r.expires_at.map { Date(timeIntervalSince1970: $0) }
            ?? Date().addingTimeInterval(r.expires_in ?? 3600)
        return SupabaseSession(accessToken: r.access_token, refreshToken: r.refresh_token,
                               expiresAt: expiry, userId: r.user.id, email: r.user.email)
    }
}

// MARK: - Sign in with Apple nonce helpers

/// A cryptographically-random nonce. The SHA256 of this is sent to Apple; the raw
/// value is sent to Supabase, which re-hashes it to verify the identity token.
func randomNonce(length: Int = 32) -> String {
    let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
    var result = ""
    var remaining = length
    while remaining > 0 {
        var random: UInt8 = 0
        _ = SecRandomCopyBytes(kSecRandomDefault, 1, &random)
        if random < charset.count {
            result.append(charset[Int(random)])
            remaining -= 1
        }
    }
    return result
}

func sha256Hex(_ input: String) -> String {
    SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
}
