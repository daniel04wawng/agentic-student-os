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

/// Read the drafted answer, EDIT it if you want, approve it, then submit to
/// Canvas. Editing advances the version, so an edited draft must be re-approved
/// before it can be submitted (you never post text you didn't approve).
struct AssignmentDetailView: View {
    let assignment: AssignmentItem
    @State private var draft: AssignmentDraft?
    @State private var editedText = ""
    @State private var loading = true
    @State private var working = false
    @State private var message: String?
    private let client = APIClient()

    /// Unsaved local edits differ from the saved draft.
    private var dirty: Bool { editedText != (draft?.draftText ?? "") }
    private var isSubmitted: Bool { draft?.status == "submitted" }

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if let draft, (draft.draftText?.isEmpty == false) || isSubmitted {
                List {
                    if let prompt = draft.prompt, !prompt.isEmpty {
                        Section("Prompt") { Text(prompt).font(.caption).foregroundStyle(.secondary) }
                    }
                    Section {
                        TextEditor(text: $editedText)
                            .frame(minHeight: 260)
                            .font(.body)
                            .disabled(working || isSubmitted)
                    } header: {
                        Text("Drafted answer — edit before submitting")
                    } footer: {
                        if dirty { Text("Unsaved edits. Save, then approve to enable submit.").foregroundStyle(.orange) }
                    }
                    Section {
                        if isSubmitted {
                            Label("Submitted to Canvas", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                        } else {
                            if dirty {
                                Button("Save changes") { Task { await save() } }.disabled(working)
                            }
                            Button(draft.approved ? "Approved ✓" : "Approve this draft") { Task { await approve() } }
                                .disabled(draft.approved || working || dirty)
                            Button("Submit to Canvas") { Task { await submit() } }
                                .disabled(!draft.approved || working || dirty)
                                .foregroundStyle(draft.approved && !dirty ? .green : .secondary)
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
        editedText = draft?.draftText ?? ""
    }

    private func save() async {
        working = true; defer { working = false }
        do {
            draft = try await client.updateDraft(assignmentId: assignment.id, text: editedText)
            editedText = draft?.draftText ?? editedText
            message = "Saved. Approve the edited draft to submit."
        } catch { message = "Save failed." }
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
