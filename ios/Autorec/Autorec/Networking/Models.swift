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
    let id: Int?
    let channel: String
    let title: String
    let startTime: String
    let endTime: String?
    let category: String?
    let description: String?

    enum CodingKeys: String, CodingKey {
        case id
        case channel
        case title
        case startTime = "start_time"
        case endTime = "end_time"
        case category
        case description
    }
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
