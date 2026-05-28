import SwiftUI

struct StorageView: View {
    @Environment(ServerConfig.self) private var config
    @State private var data: StorageResponse?
    @State private var isLoading = false
    @State private var loadError: String? = nil

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("ストレージ")
                .navigationBarTitleDisplayMode(.inline)
                .task { await loadIfNeeded() }
                .refreshable { await load() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && data == nil {
            ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = loadError, data == nil {
            ContentUnavailableView {
                Label("ストレージ情報を取得できません", systemImage: "externaldrive.badge.exclamationmark")
            } description: { Text(err) } actions: {
                Button("再試行") { Task { await load() } }
            }
        } else if let data {
            List {
                Section("ディスク") {
                    LabeledContent("マウント", value: data.disk.path)
                    LabeledContent("全体", value: formatBytes(data.disk.total))
                    LabeledContent("使用中", value: formatBytes(data.disk.used))
                    LabeledContent("空き", value: formatBytes(data.disk.free))
                    HStack {
                        Text("使用率")
                        Spacer()
                        Text("\(data.disk.usagePercent, specifier: "%.1f") %")
                            .foregroundStyle(usageColor(data.disk.usagePercent))
                            .bold()
                    }
                    ProgressView(value: data.disk.usagePercent / 100)
                        .tint(usageColor(data.disk.usagePercent))
                }

                Section("シリーズ別") {
                    ForEach(data.series) { s in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(s.name).font(.body)
                                Text("\(s.fileCount) 件").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(formatBytes(s.totalSize)).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func usageColor(_ pct: Double) -> Color {
        if pct >= 90 { return .red }
        if pct >= 70 { return .orange }
        return .green
    }

    private func loadIfNeeded() async { if data == nil { await load() } }

    private func load() async {
        isLoading = true
        loadError = nil
        do {
            data = try await api.storage()
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}
