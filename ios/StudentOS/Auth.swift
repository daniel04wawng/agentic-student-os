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

/// A signed-in session, persisted between launches. Tokens are minted by our own
/// backend (see backend/src/auth) after it verifies the Apple identity token.
struct Session: Codable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: Date
    let userId: String
}

enum AuthError: LocalizedError {
    case server(String)
    var errorDescription: String? {
        switch self { case .server(let m): return m }
    }
}

/// Owns the signed-in session. Sends a Sign in with Apple identity token to our
/// backend, which verifies it against Apple and returns our session tokens;
/// persists them in the Keychain and keeps the access token fresh for API calls.
@MainActor
final class AuthStore: ObservableObject {
    @Published private(set) var session: Session?
    @Published var errorMessage: String?
    @Published var working = false

    var isSignedIn: Bool { session != nil }
    private let sessionKey = "session"

    init() {
        if let data = Keychain.get(sessionKey), let s = try? JSONDecoder().decode(Session.self, from: data) {
            session = s
            AuthTokenBox.shared.token = s.accessToken
        }
    }

    func signInWithApple(idToken: String, rawNonce: String) async {
        working = true; defer { working = false }
        do {
            let s = try await post(path: "auth/apple", body: ["id_token": idToken, "nonce": rawNonce])
            persist(s); errorMessage = nil
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? "Couldn't sign in."
        }
    }

    /// Refresh the access token when it's close to expiry. Called on launch and
    /// when the app returns to the foreground. Failure keeps the old session; a
    /// hard failure (refresh token itself rejected) signs out.
    func refreshIfNeeded() async {
        guard let s = session, s.expiresAt.timeIntervalSinceNow < 300 else { return }
        do {
            let ns = try await post(path: "auth/refresh", body: ["refresh_token": s.refreshToken])
            persist(ns)
        } catch AuthError.server(let m) where m.contains("invalid_refresh") {
            signOut()
        } catch { /* transient; keep the current session and retry later */ }
    }

    func signOut() {
        session = nil
        AuthTokenBox.shared.token = nil
        Keychain.delete(sessionKey)
    }

    private func persist(_ s: Session) {
        session = s
        AuthTokenBox.shared.token = s.accessToken
        if let d = try? JSONEncoder().encode(s) { Keychain.set(d, for: sessionKey) }
    }

    private struct TokenResponse: Decodable {
        let access_token: String
        let refresh_token: String
        let expires_at: Double
        let user_id: String
    }

    private func post(path: String, body: [String: Any]) async throws -> Session {
        var req = URLRequest(url: AppConfig.backendBaseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw AuthError.server(String(data: data, encoding: .utf8) ?? "sign-in failed")
        }
        let r = try JSONDecoder().decode(TokenResponse.self, from: data)
        return Session(accessToken: r.access_token, refreshToken: r.refresh_token,
                       expiresAt: Date(timeIntervalSince1970: r.expires_at), userId: r.user_id)
    }
}

// MARK: - Sign in with Apple nonce helpers

/// A cryptographically-random nonce. The SHA256 of this is sent to Apple; the raw
/// value is sent to the backend (anti-replay hardening).
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
