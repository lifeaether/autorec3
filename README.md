# autorec

sh + SQLite ベースのテレビ自動録画システム。
recpt1 + epgdump + SQLite + Python で構成。外部 Python パッケージ不要。

## 機能

- **ライブ視聴** — ブラウザ上でリアルタイム視聴 (同時2ストリーム、3段階画質切替)
- **番組表** — 新聞式 EPG グリッドで番組を一覧表示、タップで録画予約
- **自動録画** — キーワード・ジャンル・チャンネルによる録画ルールで自動予約
- **録画再生** — 録画ファイルをブラウザ内で再生・シーク・ダウンロード
- **NX-Jikkyo 実況** — ライブ視聴・録画再生に実況コメントをオーバーレイ / サイドバー表示
- **ライブ録画** — 視聴中のチャンネルをワンタップで即座に録画開始
- **PiP** — Picture-in-Picture 対応 (Mac ではコメント付き Canvas PiP)
- **ダークモード** — OS 設定に自動追従
- **レスポンシブ UI** — デスクトップ / モバイル両対応

## 必要なもの

- Linux (PT3 / PX4 などのチューナーデバイス)
- recpt1 (チューナー制御)
- epgdump (EPG データ変換)
- ffmpeg (ライブ視聴・録画再生のトランスコード)
- sqlite3
- jq または xmlstarlet (EPG 解析)
- Python 3 (Web UI, 標準ライブラリのみ)

## セットアップ

```bash
git clone https://github.com/lifeaether/autorec3.git
cd autorec3
bash setup.sh
```

1. `conf/autorec.conf` を編集 (録画先ディレクトリ、通知設定)
2. `conf/channels.conf` を編集 (受信可能なチャンネル)
3. `conf/jikkyo-map.conf` を編集 (NX-Jikkyo チャンネルマッピング、任意)
4. `cron.txt` のパスを環境に合わせて編集し `crontab cron.txt` で登録
5. `python3 web/server.py` で Web UI 起動 (デフォルト: http://localhost:8080)

設定ファイルのテンプレートは `conf/*.example` を参照してください。

## Web UI の常時起動 (systemd)

Web UI サーバーを systemd ユーザーサービスとして登録すると、システム起動時に自動で立ち上がります。

### 1. サービスファイルを作成

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/autorec-web.service << 'EOF'
[Unit]
Description=autorec Web UI Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/autorec
ExecStart=/usr/bin/python3 /path/to/autorec/web/server.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
```

`WorkingDirectory` と `ExecStart` のパスは環境に合わせて変更してください。

### 2. サービスを有効化・起動

```bash
systemctl --user daemon-reload
systemctl --user enable autorec-web.service
systemctl --user start autorec-web.service
```

### 3. ログインなしでの自動起動

デフォルトではユーザーサービスはログインセッションが存在する間だけ動作します。
システム起動時 (ログイン前) から起動するには linger を有効にします:

```bash
sudo loginctl enable-linger $(whoami)
```

### 管理コマンド

```bash
systemctl --user status autorec-web     # 状態確認
systemctl --user restart autorec-web    # 再起動
systemctl --user stop autorec-web       # 停止
journalctl --user -u autorec-web        # ログ表示
```

> **注意**: ポート 80 など 1024 未満の特権ポートを使用する場合は、
> `sudo sysctl net.ipv4.ip_unprivileged_port_start=80` でカーネルの制限を緩和するか、
> `/etc/systemd/system/` にシステムサービスとして配置し `AmbientCapabilities=CAP_NET_BIND_SERVICE` を付与する必要があります。

## アーキテクチャ

```
cron ─→ bin/epg-update.sh ─→ EPG取得 → DB保存
     ─→ bin/schedule-update.sh ─→ ルールマッチング → 録画スケジュール生成
     ─→ bin/record.sh ─→ 録画実行 → 通知

python3 web/server.py ─→ Web UI (番組表 / ライブ / 録画管理)
```

- 録画パイプラインは cron + シェルスクリプトで動作 (Web サーバーとは独立)
- Web UI は閲覧・管理用のインターフェース (Python 標準ライブラリのみ)
- EPG データは SQLite に永続保存し、過去番組のアーカイブ検索が可能

## ディレクトリ構成

| ディレクトリ | 内容 |
|---|---|
| `bin/` | コア録画パイプライン (シェルスクリプト) |
| `web/` | Web UI (Python サーバー + 静的ファイル) |
| `conf/` | 設定ファイル |
| `db/` | SQLite データベース (EPG + 録画管理) |
| `log/` | ログ出力先 |

## ライセンス

MIT License
