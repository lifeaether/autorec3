import Foundation

enum APIError: LocalizedError {
    case notConfigured
    case invalidURL
    case http(Int)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "サーバ URL が未設定です"
        case .invalidURL: return "サーバ URL の形式が不正です"
        case .http(let code): return "サーバエラー (HTTP \(code))"
        case .decoding(let err): return "レスポンス解析失敗: \(err.localizedDescription)"
        case .transport(let err): return err.localizedDescription
        }
    }
}

final class APIClient {
    private let config: ServerConfig
    private let session: URLSession

    init(config: ServerConfig = .shared, session: URLSession = .shared) {
        self.config = config
        self.session = session
    }

    func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        let data = try await getData(path, query: query)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    func getData(_ path: String, query: [String: String] = [:]) async throws -> Data {
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        components.path = path
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.invalidURL }

        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.http(0) }
            guard (200..<300).contains(http.statusCode) else { throw APIError.http(http.statusCode) }
            return data
        } catch let err as APIError {
            throw err
        } catch {
            throw APIError.transport(error)
        }
    }

    func serverInfo() async throws -> ServerInfo {
        try await get("/api/server/info")
    }

    func channels() async throws -> [Channel] {
        let resp: ChannelListResponse = try await get("/api/channels")
        return resp.channels
    }

    // HLS の m3u8 URL は AVPlayer に直接渡すため、ここでは URL 構築だけ提供する。
    func hlsLiveURL(channel: String, quality: String? = nil, sid: Int? = nil,
                    audio: String? = nil) -> URL? {
        guard let base = config.baseURL,
              var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        c.path = "/hls/live"
        var items: [URLQueryItem] = [URLQueryItem(name: "ch", value: channel)]
        if let q = quality { items.append(URLQueryItem(name: "quality", value: q)) }
        if let s = sid { items.append(URLQueryItem(name: "sid", value: String(s))) }
        if let a = audio { items.append(URLQueryItem(name: "audio", value: a)) }
        c.queryItems = items
        return c.url
    }

    func hlsRecordingURL(path: String, quality: String? = nil, audio: String? = nil,
                         program: Int? = nil) -> URL? {
        guard let base = config.baseURL,
              var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        c.path = "/hls/recording"
        var items: [URLQueryItem] = [URLQueryItem(name: "path", value: path)]
        if let q = quality { items.append(URLQueryItem(name: "quality", value: q)) }
        if let a = audio { items.append(URLQueryItem(name: "audio", value: a)) }
        if let p = program { items.append(URLQueryItem(name: "program", value: String(p))) }
        c.queryItems = items
        return c.url
    }
}
