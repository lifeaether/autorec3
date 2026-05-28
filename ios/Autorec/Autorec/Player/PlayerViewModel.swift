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
        player.play()
    }

    func playRecording(path: String, title: String, api: APIClient) {
        let source = Source.recording(path: path, title: title)
        currentSource = source
        reload(api: api)
        player.play()
    }

    /// 音声/画質変更時に URL を再構築してプレイヤーを差し替える。
    func reload(api: APIClient) {
        guard let source = currentSource else { return }
        let url: URL?
        switch source {
        case .live(let ch):
            url = api.hlsLiveURL(channel: ch.channel, quality: quality.rawValue, audio: audioMode.rawValue)
        case .recording(let path, _):
            url = api.hlsRecordingURL(path: path, quality: quality.rawValue, audio: audioMode.rawValue)
        }
        guard let url else {
            lastError = "再生 URL を構築できませんでした"
            return
        }
        let asset = AVURLAsset(url: url, options: [
            "AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": "autorec-ios/1.0"],
        ])
        let item = AVPlayerItem(asset: asset)
        // 録画再生は最後の再生位置を引き継ぎたいケースが多いが、HLS の再ストリームで
        // 復元するには current time を保持して seek し直す必要がある。MVP では先頭から。
        player.replaceCurrentItem(with: item)
        lastError = nil
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
