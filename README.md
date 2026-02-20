# autorec

sh + SQLite ベースのテレビ自動録画システム。
recpt1 + epgdump + SQLite + Python で構成。

## 必要なもの

- Linux (PT3/PX4 などのチューナーデバイス)
- recpt1 (チューナー制御)
- epgdump (EPGデータ変換)
- ffmpeg (ライブ視聴・録画再生のトランスコード)
- sqlite3
- jq または xmlstarlet (EPG解析)
- Python 3 (Web UI, 標準ライブラリのみ)

## セットアップ

1. リポジトリをクローン
2. `bash setup.sh`
3. `conf/autorec.conf` を編集（録画先、通知設定）
4. `conf/channels.conf` を編集（受信可能なチャンネル）
5. `cron.txt` のパスを編集して `crontab cron.txt` で登録
6. `python3 web/server.py` で Web UI 起動

## 使い方

Web UI (デフォルト: http://localhost:8080) から:
- ライブ視聴
- 番組表の閲覧
- 録画ルールの作成・管理
- 録画済みファイルの再生・ダウンロード

## アーキテクチャ

- 録画パイプラインは cron + シェルスクリプトで動作（Web サーバー不要）
- Web UI は閲覧・管理用のインターフェース
- EPG は毎時自動更新、ルールマッチングでスケジュール自動生成

## ライセンス

MIT License
