import SwiftUI

/// 実況コメントを 12 レーンに流すオーバーレイ。
/// Canvas + TimelineView でフレーム同期描画。AirPlay スクリーンミラーリング時は
/// この描画もそのまま TV 側に転送される。
struct CommentOverlayView: View {
    let client: JikkyoClient
    var fontSize: CGFloat = 22

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
            Canvas { ctx, size in
                let now = context.date
                let laneHeight = size.height / CGFloat(JikkyoClient.laneCount)
                let comments = client.activeComments
                for c in comments {
                    let elapsed = now.timeIntervalSince(c.startTime)
                    let progress = elapsed / JikkyoClient.commentDuration
                    if progress < 0 || progress > 1 { continue }

                    let text = Text(c.text)
                        .font(.system(size: fontSize, weight: .bold))
                        .foregroundColor(.white)
                    let resolved = ctx.resolve(text)
                    let textSize = resolved.measure(in: CGSize(width: .infinity, height: laneHeight))
                    let totalDistance = size.width + textSize.width
                    let x = size.width - CGFloat(progress) * totalDistance
                    let y = CGFloat(c.lane) * laneHeight + (laneHeight - textSize.height) / 2

                    // 黒い縁取りで視認性確保
                    let shadowText = Text(c.text)
                        .font(.system(size: fontSize, weight: .bold))
                        .foregroundColor(.black)
                    let resolvedShadow = ctx.resolve(shadowText)
                    for dx in [-1.0, 1.0] as [CGFloat] {
                        for dy in [-1.0, 1.0] as [CGFloat] {
                            ctx.draw(resolvedShadow, at: CGPoint(x: x + dx, y: y + dy), anchor: .topLeading)
                        }
                    }
                    ctx.draw(resolved, at: CGPoint(x: x, y: y), anchor: .topLeading)
                }
            }
        }
        .allowsHitTesting(false)
    }
}
