import Foundation

/// Thin backend client. PR 0 exposes only the health probe; domain calls arrive
/// in later PRs. Uses async/await and injects a trace id header so client calls
/// are correlatable end to end.
struct APIClient {
    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.backendBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    static let traceHeader = "x-trace-id"

    func health() async throws -> HealthResponse {
        let url = baseURL.appendingPathComponent("health")
        var request = URLRequest(url: url)
        request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: Self.traceHeader)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(HealthResponse.self, from: data)
    }
}
