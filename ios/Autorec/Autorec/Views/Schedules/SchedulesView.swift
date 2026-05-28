import SwiftUI

struct SchedulesView: View {
    @Environment(ServerConfig.self) private var config
    @State private var schedules: [Schedule] = []
    @State private var isLoading = false
    @State private var loadError: String? = nil

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("録画予約")
                .navigationBarTitleDisplayMode(.inline)
                .task { await loadIfNeeded() }
                .refreshable { await load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && schedules.isEmpty {
            ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = loadError, schedules.isEmpty {
            ContentUnavailableView {
                Label("予約一覧を取得できません", systemImage: "calendar.badge.exclamationmark")
            } description: { Text(err) } actions: {
                Button("再試行") { Task { await load() } }
            }
        } else if schedules.isEmpty {
            ContentUnavailableView("予約なし", systemImage: "calendar",
                                    description: Text("録画予約はありません。"))
        } else {
            List {
                ForEach(schedules) { s in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(s.title).font(.body)
                            Spacer()
                            if let rule = s.ruleName, !rule.isEmpty {
                                Text(rule).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Text("\(s.startTime) – \(s.endTime)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(s.channel).font(.caption2).foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func loadIfNeeded() async {
        if schedules.isEmpty { await load() }
    }

    private func load() async {
        isLoading = true
        loadError = nil
        do {
            schedules = try await api.schedules()
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}
