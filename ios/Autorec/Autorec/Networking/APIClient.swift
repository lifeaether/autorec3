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

extension APIError {
    func withMessage(_ msg: String) -> APIError {
        struct WrappedError: LocalizedError {
            var errorDescription: String?
        }
        return .transport(WrappedError(errorDescription: msg))
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

    func recordings() async throws -> [RecordingSeries] {
        let resp: RecordingsResponse = try await get("/api/recordings")
        return resp.series
    }

    func programmes(date: String? = nil, channel: String? = nil,
                    limit: Int = 500) async throws -> [Programme] {
        var query: [String: String] = ["limit": String(limit)]
        if let d = date { query["date"] = d }
        if let c = channel { query["channel"] = c }
        let resp: ProgrammeListResponse = try await get("/api/programmes", query: query)
        return resp.programmes
    }

    /// `true` 作成成功 / `false` 既に登録済み (409)
    func createSchedule(programme: Programme) async throws -> Bool {
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        components.path = "/api/schedules"
        guard let url = components.url else { throw APIError.invalidURL }

        let body: [String: Any] = [
            "event_id": programme.eventId ?? 0,
            "channel": programme.channel,
            "title": programme.title,
            "start_time": programme.startTime,
            "end_time": programme.endTime ?? "",
        ]
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 15
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.http(0) }
            if (200..<300).contains(http.statusCode) { return true }
            if http.statusCode == 409 { return false }
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = obj["error"] as? String {
                throw APIError.http(http.statusCode).withMessage(msg)
            }
            throw APIError.http(http.statusCode)
        } catch let err as APIError {
            throw err
        } catch {
            throw APIError.transport(error)
        }
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

    func rules() async throws -> [Rule] {
        let resp: RulesResponse = try await get("/api/rules")
        return resp.rules
    }

    func schedules(limit: Int = 200) async throws -> [Schedule] {
        let resp: SchedulesResponse = try await get("/api/schedules", query: ["limit": String(limit)])
        return resp.schedules
    }

    func storage() async throws -> StorageResponse {
        try await get("/api/storage")
    }

    func upsertRule(id: Int?, body: [String: Any]) async throws -> Rule {
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        components.path = id == nil ? "/api/rules" : "/api/rules/\(id!)"
        guard let url = components.url else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = id == nil ? "POST" : "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 15
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.http(0) }
            guard (200..<300).contains(http.statusCode) else { throw APIError.http(http.statusCode) }
            struct Wrap: Decodable { let rule: Rule }
            let wrap = try JSONDecoder().decode(Wrap.self, from: data)
            return wrap.rule
        } catch let err as APIError {
            throw err
        } catch let err as DecodingError {
            throw APIError.decoding(err)
        } catch {
            throw APIError.transport(error)
        }
    }

    func deleteRule(id: Int) async throws {
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        components.path = "/api/rules/\(id)"
        guard let url = components.url else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.timeoutInterval = 15
        do {
            let (_, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw APIError.http(0) }
            guard (200..<300).contains(http.statusCode) else { throw APIError.http(http.statusCode) }
        } catch let err as APIError {
            throw err
        } catch {
            throw APIError.transport(error)
        }
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
