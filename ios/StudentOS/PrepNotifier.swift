import Foundation
import UserNotifications

/// Schedules on-device reminders that a class's prep is ready — no server push
/// or APNs key needed. Fires the evening before each class (or sooner for an
/// imminent one), naming the course and the case/topic. Re-scheduling replaces
/// prior reminders (keyed by session id), so refreshing never duplicates.
enum PrepNotifier {
    static func schedule(_ preps: [PrepItem]) {
        let center = UNUserNotificationCenter.current()
        // Only schedule once permission is granted (AppDelegate requests it on launch).
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let parser = ISO8601DateFormatter()
            let now = Date()
            let ids = preps.map { "prep-\($0.sessionId)" }
            center.removePendingNotificationRequests(withIdentifiers: ids)

            for prep in preps {
                guard let start = parser.date(from: prep.startsAt), start > now else { continue }
                guard let fire = reminderTime(before: start, now: now) else { continue }

                let content = UNMutableNotificationContent()
                content.title = "\(PrepView.courseName(prep.courseName)) prep is ready"
                content.body = snippet(prep)
                content.sound = .default

                let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: fire)
                let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
                center.add(UNNotificationRequest(identifier: "prep-\(prep.sessionId)", content: content, trigger: trigger))
            }
        }
    }

    /// The latest sensible reminder still in the future and before class:
    /// ~7pm the evening before, else 2h before, else a minute from now.
    private static func reminderTime(before start: Date, now: Date) -> Date? {
        let cal = Calendar.current
        let eveningBefore = cal.date(byAdding: .hour, value: -1,
            to: cal.date(bySettingHour: 20, minute: 0, second: 0, of: cal.date(byAdding: .day, value: -1, to: start)!)!)
        for candidate in [eveningBefore, cal.date(byAdding: .hour, value: -2, to: start)] {
            if let t = candidate, t > now, t < start { return t }
        }
        return now.addingTimeInterval(60) < start ? now.addingTimeInterval(60) : nil
    }

    /// A one-line hook for the reminder body: the first key point, else the overview.
    private static func snippet(_ prep: PrepItem) -> String {
        let s = prep.content.keyPoints.first ?? prep.content.overview
        return s.count > 120 ? String(s.prefix(117)) + "…" : s
    }
}
