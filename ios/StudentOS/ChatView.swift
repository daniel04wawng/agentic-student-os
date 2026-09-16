import SwiftUI

/// Ask-your-classes chat. Questions are answered by the model grounded in your
/// own course materials and lecture notes. Stateless per question for now (no
/// stored history) - each ask stands alone.
struct ChatView: View {
    private struct Message: Identifiable {
        let id = UUID()
        let mine: Bool
        let text: String
        var sources: [ChatSource] = []
    }

    @State private var messages: [Message] = []
    @State private var input = ""
    @State private var sending = false
    private let client = APIClient()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            if messages.isEmpty {
                                ContentUnavailableView(
                                    "Ask about your classes",
                                    systemImage: "bubble.left.and.text.bubble.right",
                                    description: Text("e.g. \"What were the key ideas from today's lecture?\" or \"Summarize the case for tomorrow.\"")
                                )
                                .padding(.top, 40)
                            }
                            ForEach(messages) { m in bubble(m).id(m.id) }
                            if sending { ProgressView().padding(.leading, 8).id("spinner") }
                        }
                        .padding()
                    }
                    .onChange(of: messages.count) { _, _ in
                        if let last = messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                }
                inputBar
            }
            .navigationTitle("Chat")
        }
    }

    @ViewBuilder
    private func bubble(_ m: Message) -> some View {
        HStack {
            if m.mine { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 6) {
                Text(m.text).textSelection(.enabled)
                if !m.sources.isEmpty {
                    Divider()
                    ForEach(Array(m.sources.enumerated()), id: \.offset) { _, s in
                        Label(s.title, systemImage: s.type == "lecture" ? "mic" : "doc.text")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(10)
            .background(m.mine ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            if !m.mine { Spacer(minLength: 40) }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            TextField("Ask about your classes…", text: $input, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .onSubmit { send() }
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill").font(.title2)
            }
            .disabled(sending || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private func send() {
        let question = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, !sending else { return }
        input = ""
        messages.append(Message(mine: true, text: question))
        sending = true
        Task {
            defer { sending = false }
            do {
                let answer = try await client.chat(question: question)
                messages.append(Message(mine: false, text: answer.answer.isEmpty ? "No answer." : answer.answer, sources: answer.sources))
            } catch {
                messages.append(Message(mine: false, text: "Couldn't reach the assistant. Try again in a moment."))
            }
        }
    }
}

#Preview {
    ChatView()
}
