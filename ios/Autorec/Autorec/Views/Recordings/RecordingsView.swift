import SwiftUI

struct RecordingsView: View {
    @Environment(ServerConfig.self) private var config
    @State private var series: [RecordingSeries] = []
    @State private var isLoading = false
    @State private var loadError: String? = nil
    @State private var playerFile: RecordingFile? = nil

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("録画")
                .task { await loadIfNeeded() }
                .refreshable { await load() }
                .sheet(item: $playerFile) { file in
                    RecordingPlayerView(file: file)
                        .environment(config)
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && series.isEmpty {
            ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = loadError, series.isEmpty {
            ContentUnavailableView {
                Label("録画一覧を取得できません", systemImage: "tv.slash")
            } description: {
                Text(err)
            } actions: {
                Button("再試行") { Task { await load() } }
            }
        } else if series.isEmpty {
            ContentUnavailableView("録画なし", systemImage: "tv",
                                    description: Text("まだ録画ファイルがありません。"))
        } else {
            List {
                ForEach(series) { s in
                    NavigationLink {
                        SeriesDetailView(series: s) { file in playerFile = file }
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(s.name).font(.body)
                                Text("\(s.fileCount) 件 / \(formatBytes(s.totalSize))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    private func loadIfNeeded() async {
        if series.isEmpty { await load() }
    }

    private func load() async {
        isLoading = true
        loadError = nil
        do {
            series = try await api.recordings()
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}

private struct SeriesDetailView: View {
    let series: RecordingSeries
    let onPlay: (RecordingFile) -> Void

    var body: some View {
        List {
            ForEach(series.files) { f in
                Button {
                    onPlay(f)
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(displayTitle(f.name)).font(.body)
                            Text("\(f.mtime) · \(formatBytes(f.size))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if f.hasNicojk {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .foregroundStyle(.secondary)
                                .font(.caption)
                        }
                        Image(systemName: "play.circle.fill")
                            .foregroundStyle(.tint)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle(series.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private func displayTitle(_ filename: String) -> String {
    let withoutExt = filename.hasSuffix(".ts") ? String(filename.dropLast(3)) : filename
    return withoutExt
}

func formatBytes(_ bytes: Int64) -> String {
    let formatter = ByteCountFormatter()
    formatter.allowedUnits = [.useGB, .useMB, .useKB]
    formatter.countStyle = .file
    return formatter.string(fromByteCount: bytes)
}
