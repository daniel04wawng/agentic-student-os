import Foundation

/// Thin backend client. Uses async/await and injects a trace id header so client
/// calls are correlatable end to end. Domain reads (today/review/deadlines) back
/// the app shell; the in-app data is authoritative regardless of push delivery.
struct APIClient {
    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.backendBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    static let traceHeader = "x-trace-id"

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    private func request(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) -> URLRequest {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var req = URLRequest(url: components.url!)
        req.httpMethod = method
        req.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: Self.traceHeader)
        // Bypass ngrok-free's browser interstitial so tunnelled API calls return JSON.
        req.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try Self.decoder.decode(T.self, from: data)
    }

    // MARK: Endpoints

    func health() async throws -> HealthResponse {
        try await send(request("health"))
    }

    func today(timezone: String) async throws -> TodayResponse {
        try await send(request("today", query: [URLQueryItem(name: "tz", value: timezone)]))
    }

    func deadlines(timezone: String) async throws -> [DeadlineItem] {
        try await send(request("deadlines", query: [URLQueryItem(name: "tz", value: timezone)]))
    }

    func review() async throws -> ReviewResponse {
        try await send(request("review"))
    }

    func preps() async throws -> [PrepItem] {
        try await send(request("preps"))
    }

    func registerDevice(token: String, platform: String = "ios") async throws {
        let payload = try JSONSerialization.data(withJSONObject: ["token": token, "platform": platform])
        let req = request("devices", method: "POST", body: payload)
        _ = try await session.data(for: req)
    }

    func registerRecording(
        clientId: String,
        contentType: String,
        capturedAt: Date,
        durationMs: Int?
    ) async throws -> RegisterRecordingResponse {
        var payload: [String: Any] = [
            "client_id": clientId,
            "content_type": contentType,
            "captured_at": ISO8601DateFormatter().string(from: capturedAt),
        ]
        if let durationMs { payload["duration_ms"] = durationMs }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await send(request("recordings", method: "POST", body: body))
    }

    func uploadRecordingAudio(uploadPath: String, data: Data, contentType: String) async throws {
        guard let url = URL(string: uploadPath, relativeTo: baseURL)?.absoluteURL else {
            throw URLError(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.httpBody = data
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: Self.traceHeader)
        // Bypass ngrok-free's browser interstitial so tunnelled API calls return JSON.
        req.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
        let (_, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
}

