# autorec - テレビ自動録画システム

## 概要
sh + SQLite ベースのテレビ自動録画システム。recpt1 + epgdump + SQLite で構成。
Web UI で番組表閲覧・録画ルール管理が可能。

## ディレクトリ構成
- `bin/` - コア録画パイプライン (シェルスクリプト)
- `web/` - Web UI (Python 標準ライブラリのみ)
- `db/` - SQLiteデータベース (epg.sqlite + autorec.sqlite)
- `conf/` - 設定ファイル
- `log/` - ログ出力先

## DB構成
- `db/epg.sqlite` - 番組表アーカイブ (全履歴を蓄積、削除しない)
- `db/autorec.sqlite` - 録画管理 (ルール、スケジュール、ログ)

## 主要スクリプト
- `bin/epg-scan.sh <ch> [秒]` - 1チャンネルのEPGスキャン
- `bin/epg-update.sh [秒]` - 全チャンネルEPG一括更新
- `bin/schedule-update.sh` - ルール→スケジュール生成+crontab反映
- `bin/record.sh <schedule_id>` - 録画実行
- `bin/notify.sh <タイトル> <メッセージ>` - 通知送信

## Web UI
```bash
python3 web/server.py [ポート]
```
デフォルトポート: 8080

## セットアップ
```bash
bash setup.sh
```

## 開発メモ
- Python は標準ライブラリのみ使用 (外部依存なし)
- EPG 解析は jq (JSON) または xmlstarlet (XML) を使用
- 番組表データは epg.sqlite に永続保存 (削除しない)
- シェルスクリプトは `set -euo pipefail` で安全に記述
