#!/bin/bash
# record.sh - 録画実行スクリプト
# schedule_id を引数に取り、recpt1 で録画を実行
#
# Usage: record.sh <schedule_id>
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

AUTOREC_DB="${AUTOREC_DB:-$AUTOREC_DIR/db/autorec.sqlite}"
RECORD_DIR="${RECORD_DIR:-/media/datb}"
START_OFFSET="${START_OFFSET:-1}"
END_OFFSET="${END_OFFSET:-0}"

SCHEDULE_ID="$1"

# ログ記録関数
log_msg() {
    local level="$1"
    local msg="$2"
    sqlite3 "$AUTOREC_DB" "INSERT INTO log (schedule_id, level, message) VALUES ($SCHEDULE_ID, '$level', '$(echo "$msg" | sed "s/'/''/g")');"
    echo "[record][$level] $msg"
}

# スケジュール情報取得
SCHED_INFO=$(sqlite3 -separator '|' "$AUTOREC_DB" \
    "SELECT s.channel, s.title, s.start_time, s.end_time, s.rule_id, COALESCE(r.name, 'unknown')
     FROM schedule s LEFT JOIN rule r ON s.rule_id = r.id
     WHERE s.id = $SCHEDULE_ID;")

if [ -z "$SCHED_INFO" ]; then
    echo "[record] エラー: スケジュール ID $SCHEDULE_ID が見つかりません" >&2
    exit 1
fi

IFS='|' read -r CHANNEL TITLE START_TIME END_TIME RULE_ID RULE_NAME <<< "$SCHED_INFO"

# チャンネル番号を取得 (channels.conf から逆引き)
CH_NUM=$(awk -v name="$CHANNEL" '{
    n=""; for(i=2;i<=NF;i++) n=n (i>2?" ":"") $i
    if (n == name) { print $1; exit }
}' "$AUTOREC_DIR/conf/channels.conf")

if [ -z "$CH_NUM" ]; then
    # チャンネル名がそのまま番号の場合
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

# 現在時刻から計算し直す (既に開始時刻を過ぎている場合)
NOW_EPOCH=$(date '+%s')
ACTUAL_END=$((END_EPOCH + END_OFFSET))
if [ "$NOW_EPOCH" -gt "$START_EPOCH" ]; then
    DURATION=$((ACTUAL_END - NOW_EPOCH))
fi

if [ "$DURATION" -le 0 ]; then
    log_msg "warn" "録画時間が0以下のためスキップ: $TITLE"
    sqlite3 "$AUTOREC_DB" "UPDATE schedule SET status = 'skipped' WHERE id = $SCHEDULE_ID;"
    exit 0
fi

# 保存先ディレクトリ作成
# 番組名からシリーズ名を抽出 (回数・サブタイトル等を除去)
SERIES_NAME=$(echo "$TITLE" | sed -E \
    -e 's/「[^」]*」//g' \
    -e 's/（[0-9]+）//g' \
    -e 's/\([0-9]+\)//g' \
    -e 's/[　 ]*#[0-9]+//' \
    -e 's/[　 ]*第[0-9]+[回話]//g' \
    -e 's/[　 ]+$//; s/^[　 ]+//')
[ -z "$SERIES_NAME" ] && SERIES_NAME="$TITLE"
SAFE_SERIES=$(echo "$SERIES_NAME" | sed 's/[\/\\:*?"<>|]/_/g')
SAFE_TITLE=$(echo "$TITLE" | sed 's/[\/\\:*?"<>|]/_/g')
DATE_STR=$(date -d "$START_TIME" '+%Y-%m-%d' 2>/dev/null) || \
    DATE_STR=$(python3 -c "from datetime import datetime; print(datetime.fromisoformat('$START_TIME').strftime('%Y-%m-%d'))")
SAFE_CHANNEL=$(echo "$CHANNEL" | sed 's/[\/\\:*?"<>|]/_/g')

OUTPUT_DIR="$RECORD_DIR/$SAFE_SERIES"
mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="$OUTPUT_DIR/${DATE_STR}_${SAFE_CHANNEL}_${SAFE_TITLE}.ts"

# 既に同名ファイルがある場合はサフィックス追加
if [ -f "$OUTPUT_FILE" ]; then
    OUTPUT_FILE="$OUTPUT_DIR/${DATE_STR}_${SAFE_CHANNEL}_${SAFE_TITLE}_$(date '+%H%M%S').ts"
fi

log_msg "info" "録画開始: $TITLE (ch=$CH_NUM, ${DURATION}秒)"
log_msg "info" "保存先: $OUTPUT_FILE"

# ステータスを recording に更新
sqlite3 "$AUTOREC_DB" "UPDATE schedule SET status = 'recording' WHERE id = $SCHEDULE_ID;"

# recpt1 で録画実行
if recpt1 --b25 "$CH_NUM" "$DURATION" "$OUTPUT_FILE" 2>&1; then
    # 成功
    FILE_SIZE=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || echo "0")
    FILE_SIZE_MB=$((FILE_SIZE / 1024 / 1024))
    sqlite3 "$AUTOREC_DB" "UPDATE schedule SET status = 'done' WHERE id = $SCHEDULE_ID;"
    log_msg "info" "録画完了: $TITLE (${FILE_SIZE_MB}MB)"

    # 通知
    "$AUTOREC_DIR/bin/notify.sh" "録画完了" "$TITLE ($CHANNEL) - ${FILE_SIZE_MB}MB" || true
else
    # 失敗
    sqlite3 "$AUTOREC_DB" "UPDATE schedule SET status = 'failed' WHERE id = $SCHEDULE_ID;"
    log_msg "error" "録画失敗: $TITLE (ch=$CH_NUM)"

    # エラー通知
    "$AUTOREC_DIR/bin/notify.sh" "録画失敗" "$TITLE ($CHANNEL)" || true
    exit 1
fi
