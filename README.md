# autorec

Linux + ISDB-T チューナーで地デジ・BS/CS を全自動録画。ブラウザだけで番組表の閲覧からライブ視聴、録画再生、実況コメント表示まで完結するテレビ自動録画システムです。

シェルスクリプトと SQLite で構成されたシンプルなアーキテクチャで、外部 Python パッケージも不要。cron ベースの録画パイプラインと Web UI は独立して動作し、堅牢かつ軽量に運用できます。

## 特徴

- **ライブ視聴** — ブラウザ上でリアルタイム視聴。3段階の画質切替
- **新聞式番組表** — EPG データを新聞のようなグリッドで一覧表示。タップで詳細確認・録画予約
- **自動録画** — キーワード・ジャンル・チャンネルの組み合わせでルールを設定すると、条件に合う番組を自動で予約
- **ブラウザ内再生** — 録画ファイルをシーク付きでブラウザ再生。ダウンロードも可能
- **NX-Jikkyo 実況** — ライブ視聴・録画再生中に実況コメントをオーバーレイまたはサイドバーで表示
- **ライブ録画** — 視聴中のチャンネルをワンタップで即座に録画開始
- **Picture-in-Picture** — PiP 対応。macOS ではコメント付き Canvas PiP にも対応
- **ダークモード** — OS の設定に自動追従
- **レスポンシブ UI** — デスクトップではトップナビ、モバイルではボトムナビに自動切替
- **番組アーカイブ検索** — EPG データを永続保存し、過去の番組情報を横断検索

## 動作環境の例

以下は実際に運用しているマシンの構成例です。自作 PC を組む際の参考にしてください。

### ハードウェア

| パーツ | 製品例 | 備考 |
|---|---|---|
| CPU | Intel Core i3-13100 (4コア / 8スレッド) | 録画自体は低負荷。ライブ視聴時の FFmpeg トランスコードが主な負荷なので、QSV 対応の Intel CPU がおすすめ |
| マザーボード | Mini-ITX / Micro-ATX (LGA 1700) | PCIe x1 スロットが1つ以上あること (チューナーカード用) |
| メモリ | DDR4 16 GB (8 GB x2) | 8 GB でも動作するが、余裕を持って 16 GB 推奨 |
| ストレージ (システム) | NVMe SSD 256 GB 以上 | OS + autorec 本体 + SQLite DB 用 |
| ストレージ (録画) | HDD 4〜8 TB | 地デジ 1 時間 ≒ 6〜7 GB。保持期間に応じて容量を選択。`/mnt/data` 等にマウント |
| チューナー | PLEX PX-W3PE5 | PCIe x1 接続。地デジ x2 / BS・CS x2 の計4チューナー。USB 接続の PX-S1UD V2.0 等でも可 |
| ケース | 小型 Mini-ITX ケース | 省スペース・静音重視で選択 |
| 電源 | 200〜300 W | 低消費電力構成なので大容量は不要 |

### ソフトウェア

| 項目 | 内容 |
|---|---|
| OS | Ubuntu 24.04 LTS (他の Linux ディストリビューションでも動作可能) |
| チューナードライバ | [px4_drv](https://github.com/nns779/px4_drv) (PLEX 系チューナー用の非公式 Linux ドライバ) |
| カードリーダー | B-CAS カードの読み取りに必要。PC 内蔵型または USB 接続型 |

### 構成のポイント

- **CPU**: 録画だけなら Celeron / Pentium クラスでも十分。ライブ視聴のトランスコードを快適に行うなら Core i3 以上を推奨
- **静音性**: ファンレスまたは大型ファンの静音ケースを選ぶと、リビングにも置ける
- **ストレージ**: 録画用 HDD は後から増設しやすい構成にしておくと便利。RAID は不要（録画データは再取得不可だが、RAID のコストに見合わないことが多い）
- **UPS**: 録画中の停電対策として、小型 UPS の導入も検討

## 必要なソフトウェア

| ソフトウェア | 役割 |
|---|---|
| [recpt1](https://github.com/stz2012/recpt1) | チューナー制御・TS ストリーム取得 |
| [epgdump](https://github.com/Piro77/epgdump) | TS から EPG (番組情報) を抽出 |
| [FFmpeg](https://ffmpeg.org/) | ライブ視聴・録画再生時のトランスコード |
| [SQLite3](https://www.sqlite.org/) | 番組表・録画管理データベース |
| [jq](https://jqlang.github.io/jq/) または [xmlstarlet](https://xmlstar.sourceforge.net/) | EPG データの解析 |
| Python 3 | Web UI サーバー (標準ライブラリのみ使用) |
| curl | 通知送信 (Webhook) |

## セットアップ

```bash
git clone https://github.com/lifeaether/autorec3.git
cd autorec3
bash setup.sh
```

### 1. 設定ファイルを編集

設定ファイルのテンプレートは `conf/*.example` にあります。コピーして編集してください。

```bash
cp conf/autorec.conf.example conf/autorec.conf
cp conf/channels.conf.example conf/channels.conf
cp conf/jikkyo-map.conf.example conf/jikkyo-map.conf  # 任意
```

| ファイル | 内容 |
|---|---|
| `conf/autorec.conf` | 録画先ディレクトリ、通知設定 (Webhook URL) など |
| `conf/channels.conf` | 受信可能なチャンネルの一覧 |
| `conf/jikkyo-map.conf` | NX-Jikkyo のチャンネルマッピング (実況コメントを使う場合) |

### 2. cron を登録

`cron.txt` のパスを環境に合わせて編集し、登録します。

```bash
crontab cron.txt
```

### 3. Web UI を起動

```bash
python3 web/server.py
```

ブラウザで http://localhost:8080 にアクセスして動作を確認できます。

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

## 電源管理・ストレージ監視 (オプション)

| スクリプト | 内容 |
|---|---|
| `bin/auto-power.sh` | RTC アラームを使い、次の録画に合わせて自動起動・シャットダウン。24時間稼働不要な環境で電気代を節約 |
| `bin/storage-check.sh` | ストレージ残量を定期チェックし、閾値を下回ると通知を送信 |

いずれも cron から定期実行する想定です。詳細はスクリプト内のコメントを参照してください。

## アーキテクチャ

```
cron ─→ bin/epg-update.sh ─→ EPG取得 → DB保存
     ─→ bin/schedule-update.sh ─→ ルールマッチング → 録画スケジュール生成
     ─→ bin/record.sh ─→ 録画実行 → 通知

python3 web/server.py ─→ Web UI (番組表 / ライブ / 録画管理)
```

- **録画パイプライン** — cron + シェルスクリプトで動作し、Web サーバーとは完全に独立。Web UI が停止していても録画は継続
- **Web UI** — 番組表閲覧・録画管理・ライブ視聴のためのインターフェース。Python 標準ライブラリのみで動作
- **EPG アーカイブ** — 番組情報を SQLite に永続保存し、過去の番組も検索可能

## ディレクトリ構成

| ディレクトリ | 内容 |
|---|---|
| `bin/` | コア録画パイプライン (シェルスクリプト) |
| `web/` | Web UI (Python サーバー + 静的ファイル) |
| `conf/` | 設定ファイル (`*.example` がテンプレート) |
| `db/` | SQLite データベース (EPG + 録画管理) |
| `log/` | ログ出力先 |

## ライセンス

MIT License
