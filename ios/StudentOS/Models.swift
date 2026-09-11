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

/// A prepared class: what to know and a worked analysis for an upcoming session.
struct PrepContent: Codable, Hashable {
    let overview: String
    let priorRecap: String
    let keyPoints: [String]
    let questions: [String]
    let analysis: String
    let workedAnswer: String
}

struct PrepItem: Codable, Identifiable, Hashable {
    let sessionId: String
    let courseName: String
    let title: String?
    let startsAt: String
    let content: PrepContent
    var id: String { sessionId }
}

struct LectureContent: Codable, Hashable {
    let summary: String
    let keyPoints: [String]
    let topics: [String]
    let actionItems: [String]
    let questions: [String]
}

struct LectureItem: Codable, Identifiable, Hashable {
    let transcriptId: String
    let courseName: String?
    let title: String?
    let recordedAt: String?
    let content: LectureContent
    var id: String { transcriptId }
}
