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

echo "[epg-update] === EPG一括更新開始 ==="
echo "[epg-update] 日時: $(date '+%Y-%m-%d %H:%M:%S')"

# 録画中チェック: recpt1 プロセスが動いていたら中断
if pgrep -x recpt1 >/dev/null 2>&1; then
    echo "[epg-update] 警告: recpt1 が実行中のため、EPG更新をスキップします" >&2
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

while IFS= read -r line; do
    # コメント・空行スキップ
    line="$(echo "$line" | sed 's/#.*//' | xargs)"
    [ -z "$line" ] && continue

    CH_NUM="$(echo "$line" | awk '{print $1}')"
    CH_NAME="$(echo "$line" | awk '{for(i=2;i<=NF;i++) printf "%s%s", (i>2?" ":""), $i; print ""}')"
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

# スケジュール更新を実行
echo ""
echo "[epg-update] スケジュール更新を実行中..."
"$AUTOREC_DIR/bin/schedule-update.sh" || {
    echo "[epg-update] 警告: スケジュール更新に失敗しました" >&2
}
