import AVFoundation
import AVKit
import Foundation
import Observation

@MainActor
@Observable
final class PlayerViewModel {
    let player = AVPlayer()

    private(set) var currentSource: Source? = nil
    private(set) var lastError: String? = nil

    enum Source: Equatable {
        case live(channel: Channel, quality: String, audio: String)
        case recording(path: String, title: String, quality: String, audio: String)
    }

    init() {
        configureAudioSession()
        player.allowsExternalPlayback = true
        player.usesExternalPlaybackWhileExternalScreenIsActive = true
    }

    func playLive(channel: Channel, quality: String = "high", audio: String = "stereo",
                  api: APIClient) {
        guard let url = api.hlsLiveURL(channel: channel.channel, quality: quality, audio: audio) else {
            lastError = "再生 URL を構築できませんでした"
            return
        }
        let source = Source.live(channel: channel, quality: quality, audio: audio)
        replace(with: url, source: source)
    }

    func playRecording(path: String, title: String, quality: String = "high",
                       audio: String = "stereo", api: APIClient) {
        guard let url = api.hlsRecordingURL(path: path, quality: quality, audio: audio) else {
            lastError = "再生 URL を構築できませんでした"
            return
        }
        let source = Source.recording(path: path, title: title, quality: quality, audio: audio)
        replace(with: url, source: source)
    }

    func stop() {
        player.pause()
        player.replaceCurrentItem(with: nil)
        currentSource = nil
    }

    private func replace(with url: URL, source: Source) {
        let asset = AVURLAsset(url: url, options: [
            "AVURLAssetHTTPHeaderFieldsKey": [
                "User-Agent": "autorec-ios/1.0",
            ],
        ])
        let item = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: item)
        currentSource = source
        lastError = nil
        player.play()
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
