import Foundation

/// Mirrors the canonical contract in
/// `packages/shared/generated/health-response.schema.json`. Kept in sync by
/// hand for PR 0; a later PR will code-generate this from the JSON Schema.
struct HealthResponse: Codable, Equatable {
    enum Status: String, Codable {
        case ok
        case degraded
    }

    let status: Status
    let service: String
    let version: String
    let traceId: String
    let uptimeS: Double

    enum CodingKeys: String, CodingKey {
        case status
        case service
        case version
        case traceId = "trace_id"
        case uptimeS = "uptime_s"
    }
}
