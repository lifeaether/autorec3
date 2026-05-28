import AVFoundation
import Foundation
import Observation
import UIKit

/// 外部ディスプレイ (HDMI/Lightning, AirPlay スクリーンミラーリング, AirPlay ビデオルーティング)
/// の接続状態を観測する。
///
/// 種別:
/// - `airplayVideo` : AVPlayer の AirPlay ビデオルーティング (映像のみ転送)
/// - `screen`       : 物理的な追加スクリーン (HDMI 等)。AirPlay スクリーンミラーリングは
///                    iOS では 1 画面扱いなので含まない
/// - `none`         : 外部出力なし
@Observable
final class ExternalDisplayManager {
    enum State: Equatable {
        case none
        case screen(String)
        case airplayVideo
    }

    @MainActor private(set) var state: State = .none

    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var kvo: NSKeyValueObservation?
    @ObservationIgnored private weak var player: AVPlayer?

    @MainActor
    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIScreen.didConnectNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.recompute() }
        })
        observers.append(center.addObserver(
            forName: UIScreen.didDisconnectNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.recompute() }
        })
        recompute()
    }

    deinit {
        let snapshot = observers
        let center = NotificationCenter.default
        for o in snapshot { center.removeObserver(o) }
    }

    /// 監視対象の AVPlayer を差し替える。AirPlay ビデオルーティング判定に使う。
    @MainActor
    func observe(player: AVPlayer) {
        self.player = player
        kvo?.invalidate()
        kvo = player.observe(\.isExternalPlaybackActive, options: [.initial, .new]) { [weak self] _, _ in
            Task { @MainActor in self?.recompute() }
        }
    }

    @MainActor
    private func recompute() {
        let externalScreens = UIScreen.screens.filter { $0 != UIScreen.main }
        if let screen = externalScreens.first {
            let size = screen.bounds.size
            state = .screen("\(Int(size.width))×\(Int(size.height))")
            return
        }
        if let player, player.isExternalPlaybackActive {
            state = .airplayVideo
            return
        }
        state = .none
    }
}
