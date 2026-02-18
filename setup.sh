#!/bin/bash
# autorec 初期セットアップスクリプト
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== autorec セットアップ ==="
echo "ディレクトリ: $AUTOREC_DIR"

# 必要なコマンドの確認
check_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "警告: $1 が見つかりません ($2)"
        return 1
    fi
    echo "OK: $1"
    return 0
}

echo ""
echo "--- 依存コマンド確認 ---"
check_cmd sqlite3 "必須: DBアクセス" || exit 1
check_cmd jq "EPG解析に使用" || true
check_cmd xmlstarlet "EPG XML解析に使用 (jqがない場合)" || true
check_cmd recpt1 "録画デバイス制御" || true
check_cmd epgdump "EPGデータ変換" || true
check_cmd curl "通知送信に使用" || true

# ディレクトリ作成
echo ""
echo "--- ディレクトリ作成 ---"
mkdir -p "$AUTOREC_DIR"/{db,log,conf}
echo "OK: ディレクトリ作成完了"

# EPG DB 初期化
echo ""
echo "--- データベース初期化 ---"
if [ ! -f "$AUTOREC_DIR/db/epg.sqlite" ]; then
    # schema.sql から EPG セクションを抽出して実行
    sed -n '/\[EPG_START\]/,/\[EPG_END\]/p' "$AUTOREC_DIR/db/schema.sql" | \
        grep -v '^\-\- \[EPG_' | \
        sqlite3 "$AUTOREC_DIR/db/epg.sqlite"
    echo "OK: epg.sqlite 作成完了"
else
    echo "SKIP: epg.sqlite は既に存在します"
fi

# 録画管理DB 初期化
if [ ! -f "$AUTOREC_DIR/db/autorec.sqlite" ]; then
    sed -n '/\[AUTOREC_START\]/,/\[AUTOREC_END\]/p' "$AUTOREC_DIR/db/schema.sql" | \
        grep -v '^\-\- \[AUTOREC_' | \
        sqlite3 "$AUTOREC_DIR/db/autorec.sqlite"
    echo "OK: autorec.sqlite 作成完了"
else
    echo "SKIP: autorec.sqlite は既に存在します"
fi

# 設定ファイル確認
echo ""
echo "--- 設定ファイル確認 ---"
if [ -f "$AUTOREC_DIR/conf/autorec.conf" ]; then
    echo "OK: autorec.conf"
else
    echo "警告: conf/autorec.conf が見つかりません"
fi

if [ -f "$AUTOREC_DIR/conf/channels.conf" ]; then
    echo "OK: channels.conf"
else
    echo "警告: conf/channels.conf が見つかりません"
fi

# シェルスクリプトに実行権限付与
echo ""
echo "--- 実行権限設定 ---"
chmod +x "$AUTOREC_DIR"/bin/*.sh 2>/dev/null || true
chmod +x "$AUTOREC_DIR"/setup.sh
echo "OK: 実行権限設定完了"

echo ""
echo "=== セットアップ完了 ==="
echo ""
echo "次のステップ:"
echo "  1. conf/autorec.conf を環境に合わせて編集"
echo "  2. conf/channels.conf のチャンネル設定を確認"
echo "  3. crontab に cron.txt の内容を登録:"
echo "     crontab cron.txt"
echo "  4. Web UI を起動:"
echo "     python3 $AUTOREC_DIR/web/server.py"
