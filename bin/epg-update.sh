#!/bin/bash
# epg-update.sh - EPG一括更新
# 全チャンネルのEPGデータを取得してDBに格納
#
# Usage: epg-update.sh [スキャン秒数]
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

SCAN_DURATION="${1:-30}"
CHANNELS_CONF="$AUTOREC_DIR/conf/channels.conf"

# ログは stdout のみ (cron が log/epg.log にリダイレクト)
log_msg() {
    local level="$1"
    local msg="$2"
    echo "[epg-update][$level] $msg"
}

echo "[epg-update] === EPG一括更新開始 ==="
echo "[epg-update] 日時: $(date '+%Y-%m-%d %H:%M:%S')"

# 録画中チェック: recpt1 プロセスが動いていたら中断
if pgrep -x recpt1 >/dev/null 2>&1; then
    log_msg "warn" "EPG更新スキップ (recpt1 実行中)"
    exit 0
fi

# チャンネル一覧読み込み
if [ ! -f "$CHANNELS_CONF" ]; then
    echo "[epg-update] エラー: $CHANNELS_CONF が見つかりません" >&2
    exit 1
fi

SUCCESS=0
FAIL=0
TOTAL=0

log_msg "info" "EPG更新開始"

while IFS= read -r line; do
    # コメント・空行スキップ
    line="$(echo "$line" | sed 's/#.*//' | xargs)"
    [ -z "$line" ] && continue

    CH_NUM="$(echo "$line" | awk '{print $1}')"
    CH_NAME="$(echo "$line" | awk -F'\t' '{print $2}')"
    TOTAL=$((TOTAL + 1))

    echo ""
    echo "[epg-update] --- $CH_NAME (ch=$CH_NUM) ---"

    if "$AUTOREC_DIR/bin/epg-scan.sh" "$CH_NUM" "$SCAN_DURATION"; then
        SUCCESS=$((SUCCESS + 1))
    else
        echo "[epg-update] 失敗: ch=$CH_NUM ($CH_NAME)" >&2
        FAIL=$((FAIL + 1))
    fi

    # チューナー解放のため少し待つ
    sleep 2
done < "$CHANNELS_CONF"

echo ""
echo "[epg-update] === EPG更新完了 ==="
echo "[epg-update] 成功: $SUCCESS / $TOTAL チャンネル"
[ "$FAIL" -gt 0 ] && echo "[epg-update] 失敗: $FAIL チャンネル"
echo "[epg-update] 日時: $(date '+%Y-%m-%d %H:%M:%S')"

if [ "$FAIL" -gt 0 ]; then
    log_msg "warn" "EPG更新完了 (成功: $SUCCESS/$TOTAL, 失敗: $FAIL チャンネル)"
else
    log_msg "info" "EPG更新完了 (成功: $SUCCESS/$TOTAL チャンネル)"
fi

# スケジュール更新を実行
echo ""
echo "[epg-update] スケジュール更新を実行中..."
"$AUTOREC_DIR/bin/schedule-update.sh" || {
    echo "[epg-update] 警告: スケジュール更新に失敗しました" >&2
}
