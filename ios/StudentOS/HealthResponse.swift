import Foundation

/// Mirrors the canonical contract in
/// `packages/shared/generated/health-response.schema.json`. Decoded with
/// `.convertFromSnakeCase` (trace_id -> traceId, uptime_s -> uptimeS).
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
}
