import SwiftUI

struct RecordingPlayerView: View {
    @Environment(ServerConfig.self) private var config
    @Environment(\.dismiss) private var dismiss
    @State private var player = PlayerViewModel()

    let file: RecordingFile

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                PlayerContainerView(player: player.player)
                    .background(Color.black)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)

                if let err = player.lastError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .padding()
                }

                List {
                    Section("情報") {
                        LabeledContent("ファイル", value: file.name)
                        LabeledContent("録画日時", value: file.mtime)
                        LabeledContent("サイズ", value: formatBytes(file.size))
                        if file.hasNicojk {
                            Label("実況コメントあり", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                }
            }
            .navigationTitle("再生")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { player.stop(); dismiss() }
                }
            }
            .onAppear {
                player.playRecording(path: file.path, title: file.name, api: api)
            }
            .onDisappear { player.stop() }
        }
    }
}
