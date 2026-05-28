import SwiftUI

struct LiveView: View {
    @Environment(ServerConfig.self) private var config
    @State private var player = PlayerViewModel()
    @State private var channels: [Channel] = []
    @State private var loadError: String? = nil
    @State private var isLoading = false
    @State private var selectedChannel: Channel? = nil

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                PlayerContainerView(player: player.player)
                    .background(Color.black)
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)

                if let title = currentTitle {
                    HStack {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .foregroundStyle(.red)
                        Text(title).bold()
                        Spacer()
                        Button("停止", role: .destructive) { player.stop(); selectedChannel = nil }
                            .buttonStyle(.bordered)
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }

                if let err = player.lastError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .padding(.horizontal)
                }

                Divider()

                channelList
            }
            .navigationTitle("ライブ")
            .navigationBarTitleDisplayMode(.inline)
            .task { await loadChannels() }
            .refreshable { await loadChannels() }
        }
    }

    private var currentTitle: String? {
        switch player.currentSource {
        case .live(let ch, _, _): return "\(ch.name)"
        case .recording, .none: return nil
        }
    }

    @ViewBuilder
    private var channelList: some View {
        if isLoading {
            ProgressView("チャンネル取得中…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = loadError {
            ContentUnavailableView {
                Label("チャンネル一覧を取得できません", systemImage: "wifi.exclamationmark")
            } description: {
                Text(err)
            } actions: {
                Button("再試行") { Task { await loadChannels() } }
            }
        } else {
            List {
                ForEach(channels) { ch in
                    Button {
                        selectedChannel = ch
                        player.playLive(channel: ch, api: api)
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(ch.name).font(.body)
                                Text("ch \(ch.channel)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if selectedChannel?.id == ch.id {
                                Image(systemName: "play.fill").foregroundStyle(.tint)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.plain)
        }
    }

    private func loadChannels() async {
        isLoading = true
        loadError = nil
        do {
            channels = try await api.channels()
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}
