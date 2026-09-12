import SwiftUI

/// Assignments the app has drafted for you: read the draft, approve it, and
/// submit to Canvas. Submission is always behind your explicit approval + tap.
struct AssignmentsView: View {
    @State private var items: [AssignmentItem] = []
    @State private var error: String?
    @State private var loading = true
    private let client = APIClient()

    private var review: [AssignmentItem] { items.filter { $0.status == "review_ready" } }
    private var other: [AssignmentItem] { items.filter { $0.status != "review_ready" && $0.status != "submitted" } }
    private var done: [AssignmentItem] { items.filter { $0.status == "submitted" } }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load", systemImage: "wifi.exclamationmark", description: Text(error))
                } else if items.isEmpty {
                    ContentUnavailableView("Nothing yet", systemImage: "tray", description: Text("Assignments the app drafts appear here to review."))
                } else {
                    List {
                        section("Ready to review", review, badge: true)
                        section("Upcoming", other, badge: false)
                        section("Submitted", done, badge: false)
                    }
                    .navigationDestination(for: AssignmentItem.self) { AssignmentDetailView(assignment: $0) }
                }
            }
            .navigationTitle("Work")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ rows: [AssignmentItem], badge: Bool) -> some View {
        if !rows.isEmpty {
            Section(title) {
                ForEach(rows) { a in
                    NavigationLink(value: a) {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(a.title).font(.headline).lineLimit(1)
                                if badge { Spacer(); Image(systemName: "sparkles").foregroundStyle(.tint) }
                            }
                            Text([a.courseName, a.dueAt.flatMap(Self.due)].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do { items = try await client.assignments(); error = nil }
        catch { self.error = error.localizedDescription }
    }

    static func due(_ iso: String) -> String? {
        let p = ISO8601DateFormatter()
        guard let d = p.date(from: iso) else { return nil }
        let f = DateFormatter(); f.dateFormat = "MMM d"
        return "due \(f.string(from: d))"
    }
}

/// Read the drafted answer, approve it, then submit to Canvas.
struct AssignmentDetailView: View {
    let assignment: AssignmentItem
    @State private var draft: AssignmentDraft?
    @State private var loading = true
    @State private var working = false
    @State private var message: String?
    private let client = APIClient()

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if let draft, let text = draft.draftText, !text.isEmpty {
                List {
                    if let prompt = draft.prompt, !prompt.isEmpty {
                        Section("Prompt") { Text(prompt).font(.caption).foregroundStyle(.secondary) }
                    }
                    Section("Drafted answer (review before submitting)") { Text(text) }
                    Section {
                        if draft.status == "submitted" {
                            Label("Submitted to Canvas", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                        } else {
                            Button(draft.approved ? "Approved ✓" : "Approve this draft") { Task { await approve() } }
                                .disabled(draft.approved || working)
                            Button("Submit to Canvas") { Task { await submit() } }
                                .disabled(!draft.approved || working)
                                .foregroundStyle(draft.approved ? .green : .secondary)
                        }
                        if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            } else {
                ContentUnavailableView("No draft yet", systemImage: "doc", description: Text("The app hasn't drafted this one yet."))
            }
        }
        .navigationTitle(assignment.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        draft = try? await client.assignmentDraft(id: assignment.id)
    }

    private func approve() async {
        guard let artifactId = draft?.artifactId else { return }
        working = true; defer { working = false }
        do { _ = try await client.approve(artifactId: artifactId); message = "Approved."; await load() }
        catch { message = "Approve failed." }
    }

    private func submit() async {
        working = true; defer { working = false }
        do {
            let status = try await client.submit(assignmentId: assignment.id)
            message = status == "submitted" ? "Posted to Canvas." : "Submit: \(status)"
            await load()
        } catch { message = "Submit failed (is it still approved?)." }
    }
}
