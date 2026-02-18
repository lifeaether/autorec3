#!/bin/bash
# schedule-update.sh - 録画スケジュール生成
# 録画ルール (autorec.sqlite) と番組表 (epg.sqlite) をマッチングし、
# 録画スケジュールを生成して crontab に反映
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

EPG_DB="${EPG_DB:-$AUTOREC_DIR/db/epg.sqlite}"
AUTOREC_DB="${AUTOREC_DB:-$AUTOREC_DIR/db/autorec.sqlite}"
MARGIN_BEFORE="${MARGIN_BEFORE:-60}"
MARGIN_AFTER="${MARGIN_AFTER:-60}"

echo "[schedule] === スケジュール更新開始 ==="

# DB存在チェック
if [ ! -f "$EPG_DB" ]; then
    echo "[schedule] エラー: EPG DB が見つかりません: $EPG_DB" >&2
    exit 1
fi
if [ ! -f "$AUTOREC_DB" ]; then
    echo "[schedule] エラー: 録画管理DB が見つかりません: $AUTOREC_DB" >&2
    exit 1
fi

# 現在時刻 (ISO 8601)
NOW="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[schedule] 現在時刻: $NOW"

# epg.sqlite を ATTACH してルールマッチング
# 未来の番組のみ対象、既にスケジュール済み (同一 event_id + channel) は除外
sqlite3 "$AUTOREC_DB" <<SQL
ATTACH DATABASE '$EPG_DB' AS epg;

-- 有効ルールと番組をマッチングして schedule に INSERT
INSERT INTO schedule (rule_id, event_id, channel, title, start_time, end_time, status)
SELECT
    r.id,
    p.event_id,
    p.channel,
    p.title,
    p.start_time,
    p.end_time,
    'scheduled'
FROM rule r
JOIN epg.programme p ON 1=1
WHERE r.enabled = 1
  AND p.start_time > '$NOW'
  -- キーワードマッチ (NULLなら全マッチ)
  AND (r.keyword IS NULL OR r.keyword = '' OR p.title LIKE '%' || r.keyword || '%')
  -- チャンネルマッチ
  AND (r.channel IS NULL OR r.channel = '' OR p.channel = r.channel)
  -- ジャンルマッチ
  AND (r.category IS NULL OR r.category = '' OR p.category LIKE '%' || r.category || '%')
  -- 時間帯マッチ (HH:MM 形式で比較)
  AND (r.time_from IS NULL OR r.time_from = '' OR strftime('%H:%M', p.start_time) >= r.time_from)
  AND (r.time_to IS NULL OR r.time_to = '' OR strftime('%H:%M', p.start_time) <= r.time_to)
  -- 曜日マッチ (0=日, 1=月, ..., 6=土)
  AND (r.weekdays IS NULL OR r.weekdays = '' OR
       instr(r.weekdays, CAST(strftime('%w', p.start_time) AS TEXT)) > 0)
  -- 既存スケジュールとの重複排除
  AND NOT EXISTS (
      SELECT 1 FROM schedule s
      WHERE s.event_id = p.event_id
        AND s.channel = p.channel
        AND s.status IN ('scheduled', 'recording', 'done')
  );

DETACH DATABASE epg;
SQL

# マッチ結果表示
MATCHED=$(sqlite3 "$AUTOREC_DB" "SELECT COUNT(*) FROM schedule WHERE status = 'scheduled' AND start_time > '$NOW';")
echo "[schedule] スケジュール済み番組数: $MATCHED"

# 過去のスケジュールで scheduled のまま残っているものを skipped に変更
sqlite3 "$AUTOREC_DB" "UPDATE schedule SET status = 'skipped' WHERE status = 'scheduled' AND start_time < '$NOW';"

# crontab 生成
echo "[schedule] crontab 更新中..."
CRON_FILE="$AUTOREC_DIR/cron.txt"
CRON_GENERATED="$AUTOREC_DIR/log/cron-generated.txt"

# 基本 cron エントリ (EPG更新など)
if [ -f "$CRON_FILE" ]; then
    cp "$CRON_FILE" "$CRON_GENERATED"
else
    echo "# autorec 自動生成 cron" > "$CRON_GENERATED"
fi

echo "" >> "$CRON_GENERATED"
echo "# === 以下は自動生成された録画スケジュール ===" >> "$CRON_GENERATED"

# スケジュールから cron エントリを生成
# 開始時刻の MARGIN_BEFORE 秒前に record.sh を起動
sqlite3 -separator '|' "$AUTOREC_DB" \
    "SELECT id, start_time, end_time, channel, title FROM schedule WHERE status = 'scheduled' AND start_time > '$NOW' ORDER BY start_time;" | \
while IFS='|' read -r sched_id start_time end_time channel title; do
    # 開始マージンを考慮した cron 時刻を計算
    CRON_TIME=$(date -d "$start_time $MARGIN_BEFORE seconds ago" '+%M %H %d %m *' 2>/dev/null) || {
        # date -d が使えない環境用フォールバック
        CRON_TIME=$(python3 -c "
from datetime import datetime, timedelta
dt = datetime.fromisoformat('$start_time') - timedelta(seconds=$MARGIN_BEFORE)
print(f'{dt.minute} {dt.hour} {dt.day} {dt.month} *')
" 2>/dev/null) || continue
    }

    echo "# $title ($channel) $start_time" >> "$CRON_GENERATED"
    echo "$CRON_TIME $AUTOREC_DIR/bin/record.sh $sched_id >> $AUTOREC_DIR/log/record.log 2>&1" >> "$CRON_GENERATED"
done

# crontab に登録
crontab "$CRON_GENERATED" 2>/dev/null && {
    echo "[schedule] crontab 更新完了"
} || {
    echo "[schedule] 警告: crontab の更新に失敗しました (手動で登録してください)" >&2
    echo "[schedule] 生成ファイル: $CRON_GENERATED"
}

echo "[schedule] === スケジュール更新完了 ==="
