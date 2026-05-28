import SwiftUI

struct SettingsView: View {
    @Environment(ServerConfig.self) private var config
    @State private var urlText: String = ""
    @State private var testState: TestState = .idle
    @State private var serverInfo: ServerInfo?

    var firstRun: Bool = false

    enum TestState: Equatable {
        case idle
        case testing
        case success
        case failed(String)
    }

    var body: some View {
        Form {
            Section {
                TextField("http://192.168.1.10:8080", text: $urlText)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { saveURL() }
            } header: {
                Text("サーバ URL")
            } footer: {
                Text("autorec サーバが動作している PC の URL を指定してください。例: http://192.168.1.10:8080")
            }

            Section {
                Button {
                    saveURL()
                    Task { await runConnectionTest() }
                } label: {
                    HStack {
                        switch testState {
                        case .idle:
                            Label("接続テスト", systemImage: "network")
                        case .testing:
                            ProgressView().padding(.trailing, 4)
                            Text("確認中…")
                        case .success:
                            Label("接続成功", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        case .failed:
                            Label("再テスト", systemImage: "arrow.clockwise")
                        }
                    }
                }
                .disabled(testState == .testing || urlText.trimmingCharacters(in: .whitespaces).isEmpty)

                if case .failed(let message) = testState {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .font(.footnote)
                }
            }

            if let info = serverInfo {
                Section("サーバ情報") {
                    LabeledContent("名前", value: info.name)
                    LabeledContent("API バージョン", value: String(info.apiVersion))
                    LabeledContent("HLS 配信", value: info.hlsEnabled ? "有効" : "無効")
                    LabeledContent("同時ライブ上限", value: String(info.maxLiveStreams))
                }
            }
        }
        .navigationTitle("設定")
        .onAppear {
            if urlText.isEmpty { urlText = config.baseURLString }
        }
    }

    private func saveURL() {
        let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        config.baseURLString = trimmed
    }

    private func runConnectionTest() async {
        await MainActor.run {
            testState = .testing
            serverInfo = nil
        }
        let client = APIClient(config: config)
        do {
            let info = try await client.serverInfo()
            await MainActor.run {
                serverInfo = info
                testState = .success
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            await MainActor.run {
                testState = .failed(message)
            }
        }
    }
}

#Preview {
    NavigationStack {
        SettingsView()
    }
    .environment(ServerConfig.shared)
}
