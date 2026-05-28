import Foundation

struct ServerInfo: Decodable {
    let name: String
    let apiVersion: Int
    let maxLiveStreams: Int
    let hlsEnabled: Bool
    let qualityPresets: [String]
    let audioModes: [String]

    enum CodingKeys: String, CodingKey {
        case name
        case apiVersion = "api_version"
        case maxLiveStreams = "max_live_streams"
        case hlsEnabled = "hls_enabled"
        case qualityPresets = "quality_presets"
        case audioModes = "audio_modes"
    }
}

struct Channel: Decodable, Identifiable, Hashable {
    let channel: String
    let name: String
    let services: [ChannelService]?

    var id: String { channel }
}

struct ChannelService: Decodable, Hashable {
    let sid: Int?
    let name: String?
}

struct ChannelListResponse: Decodable {
    let channels: [Channel]
}

struct Programme: Decodable, Identifiable, Hashable {
    let eventId: Int?
    let channel: String
    let title: String
    let startTime: String
    let endTime: String?
    let category: String?
    let description: String?

    var id: String { "\(channel)-\(eventId ?? 0)-\(startTime)" }

    enum CodingKeys: String, CodingKey {
        case eventId = "event_id"
        case channel
        case title
        case startTime = "start_time"
        case endTime = "end_time"
        case category
        case description
    }

    var startDate: Date? { Programme.parse(startTime) }
    var endDate: Date? { endTime.flatMap(Programme.parse) }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()

    static func parse(_ s: String) -> Date? { dateFormatter.date(from: s) }
}

struct ProgrammeListResponse: Decodable {
    let programmes: [Programme]
    let total: Int?
}

struct RecordingFile: Decodable, Identifiable, Hashable {
    let name: String
    let size: Int64
    let mtime: String
    let path: String
    let hasNicojk: Bool

    var id: String { path }

    enum CodingKeys: String, CodingKey {
        case name
        case size
        case mtime
        case path
        case hasNicojk = "has_nicojk"
    }
}

struct RecordingSeries: Decodable, Identifiable, Hashable {
    let name: String
    let fileCount: Int
    let totalSize: Int64
    let files: [RecordingFile]

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name
        case fileCount = "file_count"
        case totalSize = "total_size"
        case files
    }
}

struct RecordingsResponse: Decodable {
    let series: [RecordingSeries]
}

struct Rule: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
    let keyword: String?
    let channel: String?
    let category: String?
    let timeFrom: String?
    let timeTo: String?
    let weekdays: String?
    let enabled: Int
    let priority: Int

    enum CodingKeys: String, CodingKey {
        case id, name, keyword, channel, category, weekdays, enabled, priority
        case timeFrom = "time_from"
        case timeTo = "time_to"
    }

    var isEnabled: Bool { enabled != 0 }
}

struct RulesResponse: Decodable {
    let rules: [Rule]
}

struct Schedule: Decodable, Identifiable, Hashable {
    let id: Int
    let ruleId: Int?
    let eventId: Int?
    let channel: String
    let title: String
    let startTime: String
    let endTime: String
    let ruleName: String?

    enum CodingKeys: String, CodingKey {
        case id
        case ruleId = "rule_id"
        case eventId = "event_id"
        case channel
        case title
        case startTime = "start_time"
        case endTime = "end_time"
        case ruleName = "rule_name"
    }
}

struct SchedulesResponse: Decodable {
    let schedules: [Schedule]
    let total: Int
}

struct DiskInfo: Decodable, Hashable {
    let path: String
    let total: Int64
    let used: Int64
    let free: Int64
    let usagePercent: Double

    enum CodingKeys: String, CodingKey {
        case path, total, used, free
        case usagePercent = "usage_percent"
    }
}

struct SeriesUsage: Decodable, Identifiable, Hashable {
    let name: String
    let fileCount: Int
    let totalSize: Int64

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name
        case fileCount = "file_count"
        case totalSize = "total_size"
    }
}

struct StorageResponse: Decodable {
    let disk: DiskInfo
    let series: [SeriesUsage]
}
