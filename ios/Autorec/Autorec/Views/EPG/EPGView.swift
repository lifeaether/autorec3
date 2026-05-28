import SwiftUI

/// 新聞式 EPG: 横軸=チャンネル、縦軸=時刻。
/// 番組タップで詳細シートを開き、そこから録画予約できる。
struct EPGView: View {
    @Environment(ServerConfig.self) private var config
    @State private var channels: [Channel] = []
    @State private var programmes: [Programme] = []
    @State private var selectedDate: Date = EPGView.broadcastToday()
    @State private var loadError: String? = nil
    @State private var isLoading = false
    @State private var detail: Programme? = nil

    private var api: APIClient { APIClient(config: config) }
    private let pixelsPerHour: CGFloat = 100
    private let channelWidth: CGFloat = 140
    private let timeAxisWidth: CGFloat = 48
    private let dayStartHour: Int = 4   // 放送日 4:00 起点
    private let dayLengthHours: Int = 24

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        return f
    }()
    private static let displayDateFormatter: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "ja_JP")
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        f.dateFormat = "M/d (EEEEE)"
        return f
    }()

    private var totalHeight: CGFloat { CGFloat(dayLengthHours) * pixelsPerHour }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                dateNav
                Divider()
                if isLoading && programmes.isEmpty {
                    ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = loadError, programmes.isEmpty {
                    ContentUnavailableView {
                        Label("番組表を取得できません", systemImage: "calendar.badge.exclamationmark")
                    } description: { Text(err) } actions: {
                        Button("再試行") { Task { await load() } }
                    }
                } else {
                    grid
                }
            }
            .navigationTitle("番組表")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            .sheet(item: $detail) { p in
                ProgrammeDetailSheet(programme: p)
                    .environment(config)
            }
        }
    }

    private var dateNav: some View {
        HStack {
            Button {
                selectedDate = Calendar(identifier: .gregorian).date(byAdding: .day, value: -1, to: selectedDate) ?? selectedDate
                Task { await load() }
            } label: { Image(systemName: "chevron.left") }
            Spacer()
            Text(Self.displayDateFormatter.string(from: selectedDate)).font(.headline)
            Spacer()
            Button {
                selectedDate = Calendar(identifier: .gregorian).date(byAdding: .day, value: 1, to: selectedDate) ?? selectedDate
                Task { await load() }
            } label: { Image(systemName: "chevron.right") }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    private var grid: some View {
        ScrollView([.horizontal, .vertical]) {
            HStack(alignment: .top, spacing: 0) {
                // 時刻軸
                VStack(spacing: 0) {
                    ForEach(0..<dayLengthHours, id: \.self) { i in
                        let hour = (dayStartHour + i) % 24
                        VStack {
                            Text(String(format: "%02d:00", hour))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .frame(width: timeAxisWidth, height: pixelsPerHour)
                        .overlay(Rectangle().frame(height: 0.5).foregroundStyle(.quaternary), alignment: .top)
                    }
                }
                .frame(width: timeAxisWidth, height: totalHeight, alignment: .top)

                // チャンネル列
                ForEach(channels) { ch in
                    channelColumn(channel: ch)
                        .frame(width: channelWidth, height: totalHeight, alignment: .top)
                        .overlay(Rectangle().frame(width: 0.5).foregroundStyle(.quaternary), alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private func channelColumn(channel: Channel) -> some View {
        ZStack(alignment: .topLeading) {
            // ヘッダ (簡易: チャンネル名をカラム最上部に。複雑化したらスティッキ化)
            VStack {
                Text(channel.name)
                    .font(.caption)
                    .lineLimit(1)
                    .padding(4)
                    .frame(width: channelWidth - 4, alignment: .leading)
                    .background(Color(.secondarySystemBackground))
                Spacer()
            }
            .frame(width: channelWidth, height: totalHeight, alignment: .top)

            // programme.channel は番組表 DB 上の表示名 ("NHK総合" 等)。
            // Channel.name と一致する。チューナ番号 (number) ではない点に注意。
            ForEach(programmes.filter { $0.channel == channel.name }) { p in
                programmeCell(p)
                    .offset(x: 0, y: yOffset(for: p))
            }
        }
        .clipped()
    }

    @ViewBuilder
    private func programmeCell(_ p: Programme) -> some View {
        Button {
            detail = p
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(timeLabel(p)).font(.system(size: 9)).foregroundStyle(.secondary)
                Text(p.title).font(.caption2).lineLimit(3).multilineTextAlignment(.leading)
            }
            .padding(4)
            .frame(width: channelWidth, height: max(height(for: p), 16), alignment: .topLeading)
            .background(categoryColor(p.category).opacity(0.25))
            .overlay(
                RoundedRectangle(cornerRadius: 2)
                    .stroke(categoryColor(p.category).opacity(0.6), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }

    private func yOffset(for p: Programme) -> CGFloat {
        guard let start = p.startDate else { return 0 }
        let dayStart = startOfBroadcastDay(selectedDate)
        let secondsFromStart = start.timeIntervalSince(dayStart)
        return max(0, CGFloat(secondsFromStart) / 3600 * pixelsPerHour)
    }

    private func height(for p: Programme) -> CGFloat {
        guard let start = p.startDate, let end = p.endDate else { return pixelsPerHour / 2 }
        return max(8, CGFloat(end.timeIntervalSince(start)) / 3600 * pixelsPerHour)
    }

    private func timeLabel(_ p: Programme) -> String {
        guard let start = p.startDate else { return "" }
        let f = DateFormatter(); f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        f.dateFormat = "HH:mm"
        return f.string(from: start)
    }

    private func categoryColor(_ cat: String?) -> Color {
        guard let cat = cat else { return .gray }
        if cat.contains("ニュース") || cat.contains("報道") { return .blue }
        if cat.contains("アニメ") || cat.contains("特撮") { return .pink }
        if cat.contains("ドラマ") { return .purple }
        if cat.contains("スポーツ") { return .green }
        if cat.contains("映画") { return .orange }
        if cat.contains("音楽") { return .mint }
        if cat.contains("バラエティ") { return .yellow }
        if cat.contains("情報") || cat.contains("ワイドショー") { return .teal }
        if cat.contains("ドキュメンタリー") { return .brown }
        return .gray
    }

    private func startOfBroadcastDay(_ date: Date) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
        let startOfDay = cal.startOfDay(for: date)
        return cal.date(byAdding: .hour, value: dayStartHour, to: startOfDay) ?? startOfDay
    }

    private static func broadcastToday() -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Tokyo") ?? .current
        let now = Date()
        let comps = cal.dateComponents([.hour], from: now)
        // 0:00-3:59 は前日の放送日扱い
        if (comps.hour ?? 0) < 4 {
            return cal.date(byAdding: .day, value: -1, to: cal.startOfDay(for: now)) ?? now
        }
        return cal.startOfDay(for: now)
    }

    private func load() async {
        isLoading = true
        loadError = nil
        let dateString = Self.dateFormatter.string(from: selectedDate)
        do {
            async let chTask = api.channels()
            async let progTask = api.programmes(date: dateString)
            channels = try await chTask
            programmes = try await progTask
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        isLoading = false
    }
}
