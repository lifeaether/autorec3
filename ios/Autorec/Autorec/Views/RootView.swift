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

            EPGView()
                .tabItem { Label("番組表", systemImage: "calendar") }

            RecordingsTabView()
                .tabItem { Label("録画", systemImage: "play.rectangle") }

            MoreTabView()
                .tabItem { Label("その他", systemImage: "ellipsis.circle") }
        }
    }
}

/// 「録画」タブ: セグメントで録画済みファイルと予約一覧を切り替える。
private struct RecordingsTabView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case files = "録画済み"
        case schedules = "予約"
        var id: String { rawValue }
    }

    @State private var mode: Mode = .files

    var body: some View {
        VStack(spacing: 0) {
            Picker("表示", selection: $mode) {
                ForEach(Mode.allCases) { m in Text(m.rawValue).tag(m) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.top, 6)
            switch mode {
            case .files: RecordingsView()
            case .schedules: SchedulesView()
            }
        }
    }
}

/// 「その他」タブ: ルール、ストレージ、設定など管理系画面の入口。
private struct MoreTabView: View {
    var body: some View {
        NavigationStack {
            List {
                NavigationLink {
                    RulesView()
                } label: {
                    Label("録画ルール", systemImage: "slider.horizontal.3")
                }
                NavigationLink {
                    StorageView()
                } label: {
                    Label("ストレージ", systemImage: "externaldrive")
                }
                NavigationLink {
                    SettingsView()
                } label: {
                    Label("設定", systemImage: "gearshape")
                }
            }
            .navigationTitle("メニュー")
        }
    }
}
