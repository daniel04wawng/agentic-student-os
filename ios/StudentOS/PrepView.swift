import SwiftUI

/// Upcoming classes with their prep. A card per class; tap for the full worked prep.
struct PrepView: View {
    @State private var preps: [PrepItem] = []
    @State private var error: String?
    @State private var loading = true
    private let client = APIClient()

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load prep", systemImage: "wifi.exclamationmark", description: Text(error))
                } else if preps.isEmpty {
                    ContentUnavailableView("No prep yet", systemImage: "book", description: Text("Prep appears here before each class."))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(preps) { prep in
                                NavigationLink(value: prep) { PrepCard(prep: prep) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(16)
                    }
                    .background(Color(.systemGroupedBackground))
                    .navigationDestination(for: PrepItem.self) { PrepDetailView(prep: $0) }
                }
            }
            .navigationTitle("Prep")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            preps = try await client.preps()
            error = nil
            PrepNotifier.schedule(preps) // local reminders, evening before each class
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: date helpers
    static func when(_ iso: String) -> String {
        guard let d = ISO8601DateFormatter().date(from: iso) else { return iso }
        let cal = Calendar.current
        let f = DateFormatter()
        if cal.isDateInToday(d) { f.dateFormat = "'Today,' h:mm a" }
        else if cal.isDateInTomorrow(d) { f.dateFormat = "'Tomorrow,' h:mm a" }
        else { f.dateFormat = "EEE MMM d, h:mm a" }
        return f.string(from: d)
    }

    static func courseName(_ raw: String) -> String {
        raw.replacingOccurrences(of: #"^\d+-"#, with: "", options: .regularExpression)
    }
}

/// One class in the list.
private struct PrepCard: View {
    let prep: PrepItem
    private var isSoon: Bool {
        guard let d = ISO8601DateFormatter().date(from: prep.startsAt) else { return false }
        return Calendar.current.isDateInToday(d) || Calendar.current.isDateInTomorrow(d)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(PrepView.when(prep.startsAt))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(isSoon ? Color.accentColor : .secondary)
                Spacer()
                if !prep.content.questions.isEmpty {
                    Label("\(prep.content.questions.count)", systemImage: "questionmark.circle.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            Text(PrepView.courseName(prep.courseName))
                .font(.headline)
            Text(prep.content.overview)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        .overlay(alignment: .leading) {
            if isSoon { RoundedRectangle(cornerRadius: 2).fill(Color.accentColor).frame(width: 4).padding(.vertical, 10) }
        }
    }
}

/// Full worked prep for one class.
struct PrepDetailView: View {
    let prep: PrepItem
    private var c: PrepContent { prep.content }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // Header
                VStack(alignment: .leading, spacing: 6) {
                    Text(PrepView.when(prep.startsAt)).font(.subheadline.weight(.semibold)).foregroundStyle(.tint)
                    Text(PrepView.courseName(prep.courseName)).font(.title2.bold())
                    Text(c.overview).font(.callout).foregroundStyle(.secondary)
                }

                // Bottom line — the money
                if !c.workedAnswer.isEmpty {
                    Section(header: SectionHeader("The bottom line", "checkmark.seal.fill")) {
                        Text(c.workedAnswer)
                            .font(.callout.weight(.medium))
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    }
                }

                // Prof's questions to be ready for
                if !c.questions.isEmpty {
                    Section(header: SectionHeader("Be ready to answer", "hand.raised.fill")) {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(Array(c.questions.enumerated()), id: \.offset) { i, q in
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    Text("\(i + 1)").font(.caption.bold()).foregroundStyle(.tint)
                                        .frame(width: 20, height: 20).background(Color.accentColor.opacity(0.15), in: Circle())
                                    Text(q).font(.callout)
                                }
                            }
                        }
                    }
                }

                // Key points
                if !c.keyPoints.isEmpty {
                    Section(header: SectionHeader("Key points", "list.bullet")) {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(c.keyPoints, id: \.self) { k in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Image(systemName: "circle.fill").font(.system(size: 5)).foregroundStyle(.tint).padding(.top, 6)
                                    Text(k).font(.callout)
                                }
                            }
                        }
                    }
                }

                // The working
                if !c.analysis.isEmpty {
                    Section(header: SectionHeader("Working", "function")) {
                        Text(c.analysis).font(.callout).foregroundStyle(.primary.opacity(0.9))
                    }
                }

                if !c.priorRecap.isEmpty {
                    Section(header: SectionHeader("Last class", "clock.arrow.circlepath")) {
                        Text(c.priorRecap).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(18)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(PrepView.courseName(prep.courseName))
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func Section<Content: View>(header: some View, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) { header; content() }
    }
}

/// A small labeled section heading.
private struct SectionHeader: View {
    let title: String, icon: String
    init(_ title: String, _ icon: String) { self.title = title; self.icon = icon }
    var body: some View {
        Label(title, systemImage: icon)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
    }
}
