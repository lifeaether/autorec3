import SwiftUI

struct RulesView: View {
    @Environment(ServerConfig.self) private var config
    @State private var rules: [Rule] = []
    @State private var isLoading = false
    @State private var loadError: String? = nil
    @State private var editing: RuleDraft? = nil

    private var api: APIClient { APIClient(config: config) }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("録画ルール")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            editing = RuleDraft()
                        } label: { Image(systemName: "plus") }
                    }
                }
                .task { await loadIfNeeded() }
                .refreshable { await load() }
                .sheet(item: $editing) { draft in
                    RuleEditorView(draft: draft) { saved in
                        if saved { Task { await load() } }
                        editing = nil
                    }
                    .environment(config)
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading && rules.isEmpty {
            ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let err = loadError, rules.isEmpty {
            ContentUnavailableView {
                Label("ルールを取得できません", systemImage: "exclamationmark.triangle")
            } description: { Text(err) } actions: {
                Button("再試行") { Task { await load() } }
            }
        } else if rules.isEmpty {
            ContentUnavailableView("ルールなし", systemImage: "slider.horizontal.3",
                                    description: Text("右上の + から追加できます。"))
        } else {
            List {
                ForEach(rules) { rule in
                    Button {
                        editing = RuleDraft(rule: rule)
                    } label: {
                        ruleRow(rule)
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { idx in
                    Task { await deleteRules(at: idx) }
                }
            }
        }
    }

    @ViewBuilder
    private func ruleRow(_ rule: Rule) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Image(systemName: rule.isEnabled ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(rule.isEnabled ? .green : .secondary)
                    Text(rule.name).font(.body)
                }
                let details = [
                    rule.keyword.map { "🔍 \($0)" },
                    rule.channel.map { "📡 \($0)" },
                    rule.category.map { "🏷️ \($0)" },
                ].compactMap { $0 }.joined(separator: " · ")
                if !details.isEmpty {
                    Text(details).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
        }
    }

    private func loadIfNeeded() async {
        if rules.isEmpty { await load() }
    }

    private func load() async {
        isLoading = true
        loadError = nil
        do {
            rules = try await api.rules()
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }

    private func deleteRules(at offsets: IndexSet) async {
        for i in offsets {
            let r = rules[i]
            do { try await api.deleteRule(id: r.id) } catch { /* silent fail */ }
        }
        await load()
    }
}
