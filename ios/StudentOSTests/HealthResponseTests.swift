import XCTest
@testable import StudentOS

/// PR 0 harness proof: the client's decoding stays in sync with the shared
/// health contract (snake_case JSON -> camelCase Swift).
final class HealthResponseTests: XCTestCase {
    func testDecodesSharedContractShape() throws {
        let json = """
        {
          "status": "ok",
          "service": "backend",
          "version": "0.0.0",
          "trace_id": "00000000-0000-0000-0000-000000000000",
          "uptime_s": 1.5
        }
        """.data(using: .utf8)!

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let health = try decoder.decode(HealthResponse.self, from: json)
        XCTAssertEqual(health.status, .ok)
        XCTAssertEqual(health.service, "backend")
        XCTAssertEqual(health.traceId, "00000000-0000-0000-0000-000000000000")
        XCTAssertEqual(health.uptimeS, 1.5, accuracy: 0.0001)
    }
}
