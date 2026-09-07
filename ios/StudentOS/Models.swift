import Foundation

/// Codable mirrors of the backend read-view payloads. Decoded with
/// `.convertFromSnakeCase`, so properties are camelCase.

struct ZonedDisplay: Codable, Hashable {
    let timezone: String
    let wallClock: String
    let offset: String
}

struct ResolvedSource: Codable, Hashable {
    let timezone: String?
    let resolution: String
    let display: ZonedDisplay?
}

struct ResolvedDeadline: Codable, Hashable {
    let hasDeadline: Bool
    let instantUtc: String?
    let source: ResolvedSource
    let current: ZonedDisplay
}

struct DeadlineItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let courseName: String
    let past: Bool
    let deadline: ResolvedDeadline
}

struct NotificationItem: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let body: String?
    let status: String
}

struct TodayResponse: Codable {
    let date: String
    let deadlines: [DeadlineItem]
    let notifications: [NotificationItem]
}

struct ReviewNotification: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let body: String?
}

struct ReviewAssignment: Codable, Identifiable, Hashable {
    let id: String
    let title: String
}

struct ReviewResponse: Codable {
    let notifications: [ReviewNotification]
    let assignments: [ReviewAssignment]
}
