#!/bin/bash
# record.sh - 録画実行スクリプト
# schedule_id を引数に取り、recpt1 で録画を実行
#
# 設計方針: 録画クリティカルパス上で SQLite に書き込まない (lock 競合で
# 録画が落ちる事故を構造的に排除)。schedule の SELECT のみ。
# 実行ログは log/record.log への echo のみ。
#
# Usage: record.sh <schedule_id>
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"
source "$AUTOREC_DIR/bin/recording_path.sh"

AUTOREC_DB="${AUTOREC_DB:-$AUTOREC_DIR/db/autorec.sqlite}"
RECORD_DIR="${RECORD_DIR:-/mnt/data}"
START_OFFSET="${START_OFFSET:-1}"
END_OFFSET="${END_OFFSET:-0}"

# SELECT 用 (録画完了後の SELECT は無いので書き込み競合リスクなし)
SQLITE=(sqlite3 -cmd ".timeout 5000")

SCHEDULE_ID="$1"

# ログは stdout のみ (cron が log/record.log にリダイレクト)
log_msg() {
    local level="$1"
    local msg="$2"
    echo "[record][$level] $msg"
}

# スケジュール情報取得
SCHED_INFO=$("${SQLITE[@]}" -separator '|' "$AUTOREC_DB" \
    "SELECT s.channel, s.title, s.start_time, s.end_time, s.rule_id, COALESCE(r.name, 'unknown')
     FROM schedule s LEFT JOIN rule r ON s.rule_id = r.id
     WHERE s.id = $SCHEDULE_ID;")

if [ -z "$SCHED_INFO" ]; then
    echo "[record] エラー: スケジュール ID $SCHEDULE_ID が見つかりません" >&2
    exit 1
fi

IFS='|' read -r CHANNEL TITLE START_TIME END_TIME RULE_ID RULE_NAME <<< "$SCHED_INFO"

# チャンネル番号を取得 (channels.conf から逆引き)
CH_NUM=$(awk -F'\t' -v name="$CHANNEL" '
    $2 == name { print $1; exit }
' "$AUTOREC_DIR/conf/channels.conf")

if [ -z "$CH_NUM" ]; then
    CH_NUM="$CHANNEL"
fi

# 録画時間計算 (秒)
START_EPOCH=$(date -d "$START_TIME" '+%s' 2>/dev/null) || \
    START_EPOCH=$(python3 -c "from datetime import datetime; print(int(datetime.fromisoformat('$START_TIME').timestamp()))")
END_EPOCH=$(date -d "$END_TIME" '+%s' 2>/dev/null) || \
    END_EPOCH=$(python3 -c "from datetime import datetime; print(int(datetime.fromisoformat('$END_TIME').timestamp()))")
NOW_EPOCH=$(date '+%s')

# 開始まで待機 (オフセット考慮)
RECORD_START=$((START_EPOCH - START_OFFSET))
if [ "$NOW_EPOCH" -lt "$RECORD_START" ]; then
    WAIT=$((RECORD_START - NOW_EPOCH))
    log_msg "info" "録画開始まで ${WAIT}秒 待機: $TITLE"
    sleep "$WAIT"
fi

# 録画時間 = 番組時間 + 前後オフセット
DURATION=$((END_EPOCH - START_EPOCH + START_OFFSET + END_OFFSET))

NOW_EPOCH=$(date '+%s')
ACTUAL_END=$((END_EPOCH + END_OFFSET))
if [ "$NOW_EPOCH" -gt "$START_EPOCH" ]; then
    DURATION=$((ACTUAL_END - NOW_EPOCH))
fi

if [ "$DURATION" -le 0 ]; then
    log_msg "warn" "録画時間が0以下のためスキップ: $TITLE"
    exit 0
fi

# 出力先ファイルパスを命名規則で決定
OUTPUT_FILE=$(compute_output_path "$RULE_NAME" "$CHANNEL" "$TITLE" "$START_TIME" "$RECORD_DIR")
OUTPUT_DIR=$(dirname "$OUTPUT_FILE")
mkdir -p "$OUTPUT_DIR"

log_msg "info" "録画開始: $TITLE (ch=$CH_NUM, ${DURATION}秒)"
log_msg "info" "保存先: $OUTPUT_FILE"

"$AUTOREC_DIR/bin/notify.sh" "録画開始" "$TITLE ($CHANNEL)" &

# 実況コメント並行録画 (失敗しても録画に影響しない)
JIKKYO_PID=""
JIKKYO_FILE="${OUTPUT_FILE%.ts}.nicojk"
JIKKYO_MAP_FILE="$AUTOREC_DIR/conf/jikkyo-map.conf"
if [ -f "$JIKKYO_MAP_FILE" ]; then
    JK_ID=$(awk -v name="$CHANNEL" '{
        if ($0 ~ /^#/ || $0 ~ /^$/) next
        n=""; for(i=2;i<=NF;i++) n=n (i>2?" ":"") $i
        if (n == name) { print $1; exit }
    }' "$JIKKYO_MAP_FILE")
    if [ -n "$JK_ID" ]; then
        log_msg "info" "実況コメント録画開始: $JK_ID"
        python3 "$AUTOREC_DIR/bin/jikkyo-rec.py" "$JK_ID" "$DURATION" "$JIKKYO_FILE" 2>&1 &
        JIKKYO_PID=$!
    fi
fi

# recpt1 で録画実行
if recpt1 --b25 "$CH_NUM" "$DURATION" "$OUTPUT_FILE" 2>&1; then
    FILE_SIZE=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || echo "0")
    FILE_SIZE_MB=$((FILE_SIZE / 1024 / 1024))
    log_msg "info" "録画完了: $TITLE (${FILE_SIZE_MB}MB)"

    if [ -n "$JIKKYO_PID" ]; then
        kill "$JIKKYO_PID" 2>/dev/null || true
        wait "$JIKKYO_PID" 2>/dev/null || true
        if [ -f "$JIKKYO_FILE" ] && [ -s "$JIKKYO_FILE" ]; then
            JIKKYO_LINES=$(wc -l < "$JIKKYO_FILE")
            log_msg "info" "実況コメント: ${JIKKYO_LINES}行 保存済み"
        else
            log_msg "info" "実況コメント: データなし"
        fi
    fi

    "$AUTOREC_DIR/bin/notify.sh" "録画完了" "$TITLE ($CHANNEL) - ${FILE_SIZE_MB}MB" || true
else
    if [ -n "$JIKKYO_PID" ]; then
        kill "$JIKKYO_PID" 2>/dev/null || true
        wait "$JIKKYO_PID" 2>/dev/null || true
    fi
    log_msg "error" "録画失敗: $TITLE (ch=$CH_NUM)"

    "$AUTOREC_DIR/bin/notify.sh" "録画失敗" "$TITLE ($CHANNEL)" || true
    exit 1
fi
