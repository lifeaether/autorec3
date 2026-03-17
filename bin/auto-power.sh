#!/bin/bash
# auto-power.sh - RTC アラームで次回起動時刻をセットしてシャットダウン
#
# Usage: auto-power.sh <起動時刻 HH:MM> [シャットダウン遅延分]
#   例: auto-power.sh 20:45       → 次の20:45に起動するようセットして即シャットダウン
#   例: auto-power.sh 20:45 1     → 1分後にシャットダウン
#
# cron 例 (毎日4:00にシャットダウン、20:45に自動起動):
#   0 4 * * * /path/to/auto-power.sh 20:45
#
# 必要な sudoers 設定:
#   user ALL=(ALL) NOPASSWD: /usr/sbin/rtcwake, /usr/sbin/shutdown
set -euo pipefail

WAKEUP_TIME="${1:?Usage: auto-power.sh <HH:MM> [delay_min]}"
DELAY_MIN="${2:-0}"

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 録画中なら中断しない
if pgrep -x recpt1 >/dev/null 2>&1; then
    echo "[auto-power] recpt1 が実行中のため、シャットダウンをスキップします" >&2
    exit 0
fi

# 次の起動時刻を計算 (今日の HH:MM が過去なら翌日)
TARGET_EPOCH=$(date -d "today $WAKEUP_TIME" '+%s' 2>/dev/null)
NOW_EPOCH=$(date '+%s')
if [ "$TARGET_EPOCH" -le "$NOW_EPOCH" ]; then
    TARGET_EPOCH=$(date -d "tomorrow $WAKEUP_TIME" '+%s')
fi

TARGET_STR=$(date -d "@$TARGET_EPOCH" '+%Y-%m-%d %H:%M')
echo "[auto-power] 次回起動: $TARGET_STR"
echo "[auto-power] シャットダウン: ${DELAY_MIN}分後"

# RTC アラームをセットしてシャットダウン
sudo rtcwake -m no -l -t "$TARGET_EPOCH"
sudo shutdown -h +"$DELAY_MIN" "autorec: ${DELAY_MIN}分後にシャットダウンします (次回起動 $TARGET_STR)"
