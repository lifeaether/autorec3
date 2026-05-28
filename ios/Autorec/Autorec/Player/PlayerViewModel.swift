import AVFoundation
import AVKit
import Foundation
import Observation

@MainActor
@Observable
final class PlayerViewModel {
    let player = AVPlayer()

    enum AudioMode: String, CaseIterable, Identifiable {
        case stereo, main, sub
        var id: String { rawValue }
        var label: String {
            switch self {
            case .stereo: return "ステレオ"
            case .main: return "主音声"
            case .sub: return "副音声"
            }
        }
    }

    enum Quality: String, CaseIterable, Identifiable {
        case low, medium, high, original
        var id: String { rawValue }
        var label: String {
            switch self {
            case .low: return "低"
            case .medium: return "中"
            case .high: return "高"
            case .original: return "原画質"
            }
        }
    }

    var audioMode: AudioMode = .stereo
    var quality: Quality = .high

    private(set) var currentSource: Source? = nil
    private(set) var lastError: String? = nil

    enum Source: Equatable {
        case live(channel: Channel)
        case recording(path: String, title: String)
    }

    init() {
        configureAudioSession()
        player.allowsExternalPlayback = true
        player.usesExternalPlaybackWhileExternalScreenIsActive = true
    }

    func playLive(channel: Channel, api: APIClient) {
        let source = Source.live(channel: channel)
        currentSource = source
        reload(api: api)
    }

    func playRecording(path: String, title: String, api: APIClient) {
        let source = Source.recording(path: path, title: title)
        currentSource = source
        reload(api: api)
    }

    /// 音声/画質変更時に URL を再構築してプレイヤーを差し替える。
    /// AVPlayer に直接渡すと HTTP エラー本文が握りつぶされるため、先に URL を
    /// 取得して 200 を確認してから再生する。サーバ側のエラー本文がそのまま UI に出る。
    func reload(api: APIClient) {
        guard let source = currentSource else { return }
        let url: URL?
        switch source {
        case .live(let ch):
            url = api.hlsLiveURL(channel: ch.number, quality: quality.rawValue, audio: audioMode.rawValue)
        case .recording(let path, _):
            url = api.hlsRecordingURL(path: path, quality: quality.rawValue, audio: audioMode.rawValue)
        }
        guard let url else {
            lastError = "再生 URL を構築できませんでした"
            return
        }
        Task { await preflightAndAttach(url: url) }
    }

    private func preflightAndAttach(url: URL) async {
        do {
            var req = URLRequest(url: url)
            req.timeoutInterval = 25  // ライブは ffmpeg HLS muxer の初回セグメント書き出しまで待つ
            let (data, response) = try await URLSession.shared.data(for: req)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                let body = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                lastError = "HTTP \(http.statusCode)\n\(String(body.prefix(1200)))"
                return
            }
        } catch {
            lastError = "再生 URL 取得失敗: \(error.localizedDescription)"
            return
        }
        let asset = AVURLAsset(url: url, options: [
            "AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": "autorec-ios/1.0"],
        ])
        let item = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: item)
        lastError = nil
        player.play()
    }

    func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        currentSource = nil
    }

    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay])
            try session.setActive(true, options: [])
        } catch {
            lastError = "オーディオセッション初期化失敗: \(error.localizedDescription)"
        }
    }
}
