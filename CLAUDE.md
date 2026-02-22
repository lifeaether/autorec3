# autorec - テレビ自動録画システム

## 概要
sh + SQLite ベースのテレビ自動録画システム。recpt1 + epgdump + SQLite で構成。
Web UI で番組表閲覧・ライブ視聴・録画ルール管理・録画再生が可能。

## ディレクトリ構成
- `bin/` - コア録画パイプライン (シェルスクリプト)
  - `epg-scan.sh` - 1チャンネルのEPGスキャン
  - `epg-update.sh` - 全チャンネルEPG一括更新
  - `schedule-update.sh` - ルール→スケジュール生成+crontab反映
  - `record.sh` - 録画実行
  - `notify.sh` - 通知送信
  - `jikkyo-rec.py` - NX-Jikkyo 実況コメント並行保存
- `web/` - Web UI (Python 標準ライブラリのみ)
  - `server.py` - HTTP サーバー (デフォルトポート: 8080)
  - `api.py` - REST API ハンドラ
  - `static/` - フロントエンド (index.html, epg.html, app.js, style.css)
- `db/` - SQLiteデータベース
  - `epg.sqlite` - 番組表アーカイブ (全履歴を蓄積、削除しない)
  - `autorec.sqlite` - 録画管理 (ルール、スケジュール、ログ)
- `conf/` - 設定ファイル (*.example がテンプレート)
- `log/` - ログ出力先

## Web UI 構成
- **ライブ** - リアルタイム視聴 (mpegts.js)、NX-Jikkyo 実況、ライブ録画
- **番組表** - 新聞式 EPG グリッド、番組詳細ポップアップ、録画予約
- **録画済み** - シリーズ別ファイル一覧、ブラウザ内再生 (シーク対応)、実況コメント再生
- **録画一覧** - スケジュール管理 (状態フィルタ)
- **録画ルール** - キーワード・ジャンル・チャンネルによる自動録画条件
- **ログ** - 録画ログ (レベルフィルタ)
- **アーカイブ** (epg.html) - 過去番組の横断検索

## デザインシステム
- Apple Design Language 準拠 (v2.1〜)
- ダークモード: `prefers-color-scheme` で OS 設定に自動追従
- レスポンシブ: デスクトップ (トップナビ) / モバイル (ボトムナビ)
- ブレークポイント: 768px / 480px

## 開発メモ
- Python は標準ライブラリのみ使用 (外部依存なし)
- EPG 解析は jq (JSON) または xmlstarlet (XML) を使用
- 番組表データは epg.sqlite に永続保存 (削除しない)
- シェルスクリプトは `set -euo pipefail` で安全に記述
- フロントエンドは vanilla JS (フレームワークなし)
- CSS カスタムプロパティでテーマ管理 (style.css の `:root`)
