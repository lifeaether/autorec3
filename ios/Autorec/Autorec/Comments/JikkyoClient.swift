import Foundation
import Observation

/// NX-Jikkyo の実況コメントを WebSocket で受信し、Comment レーンに割り当てる。
/// 仕様は既存 web/static/app.js の `jikkyo` オブジェクト (app.js:2382-2720) と同等。
@MainActor
@Observable
final class JikkyoClient {
    struct Comment: Identifiable, Hashable {
        let id = UUID()
        let text: String
        let lane: Int
        let startTime: Date
    }

    static let laneCount = 12
    static let commentDuration: TimeInterval = 6.0
    private static let baseHost = "nx-jikkyo.tsukumijima.net"
    private static let maxActive = 80

    static let channelMap: [String: String] = [
        // 地上波
        "NHK総合": "jk1", "NHK-Eテレ": "jk2", "日テレ": "jk4",
        "テレビ朝日": "jk5", "TBS": "jk6", "テレビ東京": "jk7",
        "フジテレビ": "jk8", "TOKYO MX": "jk9",
        // BS
        "NHK BS": "jk101", "BS日テレ": "jk141", "BSフジ": "jk181",
        "BS11": "jk211", "BS12 トゥエルビ": "jk222",
        "BS松竹東急": "jk260", "BSよしもと": "jk265",
    ]

    private(set) var activeComments: [Comment] = []
    private(set) var isConnected: Bool = false

    private var watchTask: URLSessionWebSocketTask?
    private var commentTask: URLSessionWebSocketTask?
    private var keepSeatTask: Task<Void, Never>?
    private var threadId: String?
    private var yourPostKey: String = ""
    private var generation: Int = 0
    private var lanes: [Date] = Array(repeating: .distantPast, count: JikkyoClient.laneCount)

    func start(channelName: String) {
        stop()
        guard let jkId = Self.channelMap[channelName] else { return }
        let gen = generation
        connectWatch(jkId: jkId, gen: gen)
    }

    func stop() {
        generation += 1
        watchTask?.cancel(with: .goingAway, reason: nil); watchTask = nil
        commentTask?.cancel(with: .goingAway, reason: nil); commentTask = nil
        keepSeatTask?.cancel(); keepSeatTask = nil
        threadId = nil
        yourPostKey = ""
        activeComments.removeAll()
        lanes = Array(repeating: .distantPast, count: Self.laneCount)
        isConnected = false
    }

    private func connectWatch(jkId: String, gen: Int) {
        guard let url = URL(string: "wss://\(Self.baseHost)/api/v1/channels/\(jkId)/ws/watch") else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        watchTask = task
        task.resume()
        Task { [weak self] in
            guard let self else { return }
            let payload = #"{"type":"startWatching","data":{}}"#
            try? await task.send(.string(payload))
            await self.listenWatch(task: task, gen: gen, jkId: jkId)
        }
    }

    private func listenWatch(task: URLSessionWebSocketTask, gen: Int, jkId: String) async {
        while gen == generation {
            do {
                let msg = try await task.receive()
                let text = Self.extractText(msg)
                if text.isEmpty { continue }
                await handleWatch(text: text, jkId: jkId, gen: gen)
            } catch {
                break
            }
        }
    }

    private func handleWatch(text: String, jkId: String, gen: Int) async {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "seat":
            let d = obj["data"] as? [String: Any]
            let interval = (d?["keepIntervalSec"] as? Double) ?? Double(d?["keepIntervalSec"] as? Int ?? 30)
            startKeepSeat(intervalSeconds: interval)
        case "room":
            guard let d = obj["data"] as? [String: Any] else { return }
            threadId = Self.stringValue(d["threadId"]) ?? ""
            yourPostKey = (d["yourPostKey"] as? String) ?? ""
            let uri = ((d["messageServer"] as? [String: Any])?["uri"] as? String)
                ?? "wss://\(Self.baseHost)/api/v1/channels/\(jkId)/ws/comment"
            connectComment(uri: uri, gen: gen)
        case "ping":
            try? await watchTask?.send(.string(#"{"type":"pong"}"#))
        case "disconnect":
            stop()
        default:
            break
        }
    }

    private func startKeepSeat(intervalSeconds: Double) {
        keepSeatTask?.cancel()
        let intervalNs = UInt64(max(1, intervalSeconds) * 1_000_000_000)
        keepSeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: intervalNs)
                guard !Task.isCancelled else { return }
                try? await self?.watchTask?.send(.string(#"{"type":"keepSeat"}"#))
            }
        }
    }

    private func connectComment(uri: String, gen: Int) {
        guard let url = URL(string: uri) else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        commentTask = task
        task.resume()
        Task { [weak self] in
            guard let self else { return }
            let subscription: [[String: Any]] = [
                ["ping": ["content": "rs:0"]],
                ["ping": ["content": "ps:0"]],
                ["thread": [
                    "version": "20061206",
                    "thread": self.threadId ?? "",
                    "threadkey": self.yourPostKey,
                    "user_id": "",
                    "res_from": -100,
                ]],
                ["ping": ["content": "pf:0"]],
                ["ping": ["content": "rf:0"]],
            ]
            if let data = try? JSONSerialization.data(withJSONObject: subscription),
               let str = String(data: data, encoding: .utf8) {
                try? await task.send(.string(str))
            }
            self.isConnected = true
            await self.listenComment(task: task, gen: gen)
        }
    }

    private func listenComment(task: URLSessionWebSocketTask, gen: Int) async {
        while gen == generation {
            do {
                let msg = try await task.receive()
                let text = Self.extractText(msg)
                if text.isEmpty { continue }
                handleComment(text: text)
            } catch {
                break
            }
        }
    }

    private func handleComment(text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let chat = obj["chat"] as? [String: Any],
              let content = chat["content"] as? String,
              !content.isEmpty else { return }
        addComment(text: content)
    }

    private func addComment(text: String) {
        let lane = assignLane()
        let comment = Comment(text: text, lane: lane, startTime: Date())
        activeComments.append(comment)
        let cutoff = Date().addingTimeInterval(-Self.commentDuration)
        activeComments.removeAll { $0.startTime < cutoff }
        if activeComments.count > Self.maxActive {
            activeComments.removeFirst(activeComments.count - Self.maxActive)
        }
    }

    private func assignLane() -> Int {
        let now = Date()
        for i in 0..<Self.laneCount {
            if lanes[i] <= now {
                lanes[i] = now.addingTimeInterval(Self.commentDuration)
                return i
            }
        }
        var minIdx = 0
        for i in 1..<Self.laneCount where lanes[i] < lanes[minIdx] {
            minIdx = i
        }
        lanes[minIdx] = now.addingTimeInterval(Self.commentDuration)
        return minIdx
    }

    private static func extractText(_ msg: URLSessionWebSocketTask.Message) -> String {
        switch msg {
        case .string(let s): return s
        case .data(let d): return String(data: d, encoding: .utf8) ?? ""
        @unknown default: return ""
        }
    }

    private static func stringValue(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }
}
