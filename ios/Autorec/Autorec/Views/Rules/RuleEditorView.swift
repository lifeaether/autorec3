import SwiftUI

/// 編集中のルールを表すドラフト。新規時は id == nil。
struct RuleDraft: Identifiable {
    var id: Int? { ruleId }
    let ruleId: Int?
    var name: String
    var keyword: String
    var channel: String
    var category: String
    var enabled: Bool
    var priority: Int

    init() {
        ruleId = nil; name = ""; keyword = ""; channel = ""; category = ""
        enabled = true; priority = 0
    }

    init(rule: Rule) {
        ruleId = rule.id
        name = rule.name
        keyword = rule.keyword ?? ""
        channel = rule.channel ?? ""
        category = rule.category ?? ""
        enabled = rule.isEnabled
        priority = rule.priority
    }
}

struct RuleEditorView: View {
    @Environment(ServerConfig.self) private var config
    @Environment(\.dismiss) private var dismiss

    @State var draft: RuleDraft
    @State private var isSaving = false
    @State private var saveError: String? = nil

    let onComplete: (_ saved: Bool) -> Void

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            Form {
                Section("基本") {
                    TextField("名前 (必須)", text: $draft.name)
                    Toggle("有効", isOn: $draft.enabled)
                    Stepper("優先度: \(draft.priority)", value: $draft.priority, in: -10...10)
                }
                Section {
                    TextField("キーワード", text: $draft.keyword)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("チャンネル名", text: $draft.channel)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("カテゴリ (部分一致)", text: $draft.category)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("マッチ条件")
                } footer: {
                    Text("空欄の条件は無視されます。少なくとも 1 つは指定してください。")
                }
                if let err = saveError {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            .navigationTitle(draft.ruleId == nil ? "ルール追加" : "ルール編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("キャンセル") { onComplete(false); dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text("保存").bold() }
                    }
                    .disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                }
            }
        }
    }

    private func save() async {
        isSaving = true
        saveError = nil
        var body: [String: Any] = [
            "name": draft.name,
            "enabled": draft.enabled ? 1 : 0,
            "priority": draft.priority,
        ]
        if !draft.keyword.isEmpty { body["keyword"] = draft.keyword }
        if !draft.channel.isEmpty { body["channel"] = draft.channel }
        if !draft.category.isEmpty { body["category"] = draft.category }
        do {
            _ = try await api.upsertRule(id: draft.ruleId, body: body)
            onComplete(true)
            dismiss()
        } catch {
            saveError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isSaving = false
    }
}
