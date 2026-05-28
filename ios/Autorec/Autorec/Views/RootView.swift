import SwiftUI

struct RootView: View {
    @Environment(ServerConfig.self) private var config

    var body: some View {
        if config.isConfigured {
            MainTabView()
        } else {
            NavigationStack {
                SettingsView(firstRun: true)
            }
        }
    }
}

struct MainTabView: View {
    var body: some View {
        TabView {
            LiveView()
                .tabItem { Label("ライブ", systemImage: "antenna.radiowaves.left.and.right") }

            EPGPlaceholderView()
                .tabItem { Label("番組表", systemImage: "calendar") }

            RecordingsView()
                .tabItem { Label("録画", systemImage: "play.rectangle") }

            RulesPlaceholderView()
                .tabItem { Label("ルール", systemImage: "slider.horizontal.3") }

            NavigationStack {
                SettingsView()
            }
            .tabItem { Label("設定", systemImage: "gearshape") }
        }
    }
}

// 後続マイルストーンで本実装と差し替えるプレースホルダ。
private struct EPGPlaceholderView: View {
    var body: some View { ComingSoonView(title: "番組表") }
}

private struct RulesPlaceholderView: View {
    var body: some View { ComingSoonView(title: "録画ルール") }
}

private struct ComingSoonView: View {
    let title: String
    var body: some View {
        NavigationStack {
            ContentUnavailableView(
                "準備中",
                systemImage: "hammer",
                description: Text("\(title) は後続のマイルストーンで実装されます。")
            )
            .navigationTitle(title)
        }
    }
}
