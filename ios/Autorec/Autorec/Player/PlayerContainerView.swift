import AVKit
import SwiftUI

/// AVPlayerViewController を SwiftUI に橋渡し。
/// 標準コントロール (再生/停止/シーク/音量/AirPlay/PiP/全画面) はこれで自動付与される。
struct PlayerContainerView: UIViewControllerRepresentable {
    let player: AVPlayer
    var overlayProvider: ((UIView) -> Void)? = nil

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player
        vc.allowsPictureInPicturePlayback = true
        vc.canStartPictureInPictureAutomaticallyFromInline = true
        vc.entersFullScreenWhenPlaybackBegins = false
        vc.showsPlaybackControls = true
        vc.videoGravity = .resizeAspect
        overlayProvider?(vc.contentOverlayView ?? UIView())
        return vc
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {
        if uiViewController.player !== player {
            uiViewController.player = player
        }
    }
}
