import SwiftUI

struct ProgrammeDetailSheet: View {
    @Environment(ServerConfig.self) private var config
    @Environment(\.dismiss) private var dismiss

    let programme: Programme

    @State private var status: ReserveStatus = .idle

    enum ReserveStatus: Equatable {
        case idle
        case reserving
        case success
        case duplicate
        case failed(String)
    }

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(programme.title).font(.title3).bold()
                    if let cat = programme.category, !cat.isEmpty {
                        Text(cat).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("時刻") {
                    LabeledContent("開始", value: programme.startTime)
                    if let end = programme.endTime { LabeledContent("終了", value: end) }
                    LabeledContent("チャンネル", value: programme.channel)
                }
                if let desc = programme.description, !desc.isEmpty {
                    Section("内容") {
                        Text(desc)
                    }
                }
                Section {
                    Button {
                        Task { await reserve() }
                    } label: {
                        HStack {
                            switch status {
                            case .idle: Label("録画予約する", systemImage: "record.circle")
                            case .reserving: ProgressView(); Text("予約中…")
                            case .success: Label("予約しました", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                            case .duplicate: Label("既に予約済み", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                            case .failed: Label("再試行", systemImage: "arrow.clockwise")
                            }
                        }
                    }
                    .disabled(status == .reserving || status == .success || status == .duplicate)
                    if case .failed(let msg) = status {
                        Label(msg, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            .navigationTitle("番組詳細")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
    }

    private func reserve() async {
        status = .reserving
        do {
            let created = try await api.createSchedule(programme: programme)
            status = created ? .success : .duplicate
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            status = .failed(msg)
        }
    }
}
