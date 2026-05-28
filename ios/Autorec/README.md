# autorec iOS アプリ

iPhone から autorec サーバを操作・視聴するためのネイティブアプリ。
AirPlay と外部ディスプレイ (HDMI) でテレビ出力に対応する。

## 要件

- Xcode 16 以上 (Swift 5.10+, iOS 17 SDK)
- 実機: iOS 17 以上
- ビルドツール: [`xcodegen`](https://github.com/yonaskolb/XcodeGen)
  ```sh
  brew install xcodegen
  ```

## ビルド・実行

```sh
cd ios/Autorec
xcodegen generate
open Autorec.xcodeproj
```

Xcode で実機を選択、Signing & Capabilities で自分の Apple ID チームを選び Run。

## 構成

- `project.yml` - xcodegen マニフェスト (`.xcodeproj` はここから生成、Git 管理外)
- `Autorec/App/` - エントリポイント
- `Autorec/Networking/` - REST API クライアント
- `Autorec/Player/` - AVPlayer / HLS 再生
- `Autorec/Comments/` - NX-Jikkyo 実況コメント
- `Autorec/ExternalDisplay/` - 外部スクリーン (HDMI/AirPlay) 投影
- `Autorec/Views/` - SwiftUI 画面
- `Autorec/Resources/` - 画像・アセット

## 初回起動時の設定

「設定」タブからサーバ URL (例: `http://192.168.1.10:8080`) を入力し「接続テスト」で疎通確認。
