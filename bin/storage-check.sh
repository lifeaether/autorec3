#!/bin/bash
# storage-check.sh - ストレージ残量チェック
# RECORD_DIR の使用率・空き容量を確認し、閾値超過時に notify.sh で通知
# 通知スパム防止: 状態ファイルで制御 (1回通知 → 回復まで再通知しない)
#
# Usage: storage-check.sh (cron から実行)
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

WARN_PERCENT="${STORAGE_WARN_PERCENT:-90}"
WARN_FREE_GB="${STORAGE_WARN_FREE_GB:-50}"
STATE_FILE="$AUTOREC_DIR/log/.storage-warn-notified"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ストレージチェック開始: $RECORD_DIR"

# RECORD_DIR の存在確認
if [ ! -d "$RECORD_DIR" ]; then
    echo "[error] RECORD_DIR が存在しません: $RECORD_DIR"
    exit 1
fi

# df -P でディスク情報取得 (POSIX 出力形式)
DF_LINE=$(df -P "$RECORD_DIR" | tail -1)
USAGE_PERCENT=$(echo "$DF_LINE" | awk '{gsub(/%/,""); print $5}')
AVAIL_KB=$(echo "$DF_LINE" | awk '{print $4}')
AVAIL_GB=$(awk "BEGIN {printf \"%.1f\", $AVAIL_KB / 1048576}")

echo "  使用率: ${USAGE_PERCENT}% (閾値: ${WARN_PERCENT}%)"
echo "  空き容量: ${AVAIL_GB}GB (閾値: ${WARN_FREE_GB}GB)"

# 閾値判定
EXCEEDED=0
REASONS=""

if [ "$USAGE_PERCENT" -ge "$WARN_PERCENT" ]; then
    EXCEEDED=1
    REASONS="使用率 ${USAGE_PERCENT}% (閾値: ${WARN_PERCENT}%)"
fi

if awk "BEGIN {exit !($AVAIL_GB < $WARN_FREE_GB)}"; then
    EXCEEDED=1
    if [ -n "$REASONS" ]; then
        REASONS="$REASONS / "
    fi
    REASONS="${REASONS}空き ${AVAIL_GB}GB (閾値: ${WARN_FREE_GB}GB)"
fi

if [ "$EXCEEDED" -eq 1 ]; then
    if [ -f "$STATE_FILE" ]; then
        echo "  閾値超過 (通知済みのためスキップ)"
    else
        echo "  閾値超過 → 通知送信"
        "$AUTOREC_DIR/bin/notify.sh" \
            "ストレージ残量警告" \
            "録画先ディスクの容量が不足しています。\n${REASONS}\nパス: $RECORD_DIR"
        touch "$STATE_FILE"
    fi
else
    echo "  正常"
    if [ -f "$STATE_FILE" ]; then
        rm -f "$STATE_FILE"
        echo "  通知状態リセット"
    fi
fi
