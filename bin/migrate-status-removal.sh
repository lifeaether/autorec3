#!/bin/bash
# 一度限りの DB 移行スクリプト:
#   - schedule.status / schedule.output_path カラム削除
#   - idx_schedule_status インデックス削除
#   - log テーブル削除
#   - schedule に UNIQUE(channel, start_time) 制約追加
#
# idempotent: 既に移行済みならスキップ。途中まで進んでいれば残り作業のみ実行。
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

AUTOREC_DB="${AUTOREC_DB:-$AUTOREC_DIR/db/autorec.sqlite}"
SQLITE=(sqlite3 -cmd ".timeout 5000")

if [ ! -f "$AUTOREC_DB" ]; then
    echo "[migrate] エラー: DB が見つかりません: $AUTOREC_DB" >&2
    exit 1
fi

# 録画中なら中断
if pgrep -x recpt1 >/dev/null 2>&1; then
    echo "[migrate] エラー: recpt1 が実行中です。録画停止中に再実行してください" >&2
    exit 2
fi

# 現状の確認
HAS_STATUS=$("${SQLITE[@]}" "$AUTOREC_DB" "SELECT 1 FROM pragma_table_info('schedule') WHERE name='status'")
HAS_OUTPUT=$("${SQLITE[@]}" "$AUTOREC_DB" "SELECT 1 FROM pragma_table_info('schedule') WHERE name='output_path'")
HAS_LOG=$("${SQLITE[@]}" "$AUTOREC_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='log'")
HAS_UQ_INDEX=$("${SQLITE[@]}" "$AUTOREC_DB" "SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_schedule_channel_start'")

if [ -z "$HAS_STATUS" ] && [ -z "$HAS_OUTPUT" ] && [ -z "$HAS_LOG" ] && [ -n "$HAS_UQ_INDEX" ]; then
    echo "[migrate] 既に移行済みです。スキップ"
    exit 0
fi

BACKUP_PATH="$AUTOREC_DIR/db/autorec.sqlite.bak-migrate-$(date +%Y%m%d-%H%M%S)"
echo "[migrate] バックアップ: $BACKUP_PATH"
cp "$AUTOREC_DB" "$BACKUP_PATH"

# 1. status を参照するインデックスを先に削除 (DROP COLUMN status の前提)
echo "[migrate] 1/5 idx_schedule_status を削除"
"${SQLITE[@]}" "$AUTOREC_DB" "DROP INDEX IF EXISTS idx_schedule_status;"

# 2. (channel, start_time) の重複を解消 (UNIQUE 制約に必要)
DUP_COUNT=$("${SQLITE[@]}" "$AUTOREC_DB" \
    "SELECT COUNT(*) - COUNT(DISTINCT channel || start_time) FROM schedule;")
if [ "$DUP_COUNT" -gt 0 ]; then
    echo "[migrate] 2/5 (channel, start_time) 重複 $DUP_COUNT 件を解消 (古い id を残す)"
    "${SQLITE[@]}" "$AUTOREC_DB" \
        "DELETE FROM schedule WHERE id NOT IN (SELECT MIN(id) FROM schedule GROUP BY channel, start_time);"
else
    echo "[migrate] 2/5 重複なし"
fi

# 3. status / output_path カラムを削除
if [ -n "$HAS_STATUS" ]; then
    echo "[migrate] 3a/5 status カラムを削除"
    "${SQLITE[@]}" "$AUTOREC_DB" "ALTER TABLE schedule DROP COLUMN status;"
fi
if [ -n "$HAS_OUTPUT" ]; then
    echo "[migrate] 3b/5 output_path カラムを削除"
    "${SQLITE[@]}" "$AUTOREC_DB" "ALTER TABLE schedule DROP COLUMN output_path;"
fi

# 4. log テーブル削除
if [ -n "$HAS_LOG" ]; then
    echo "[migrate] 4/5 log テーブルを削除"
    "${SQLITE[@]}" "$AUTOREC_DB" "DROP TABLE log;"
fi

# 5. UNIQUE 制約を追加
if [ -z "$HAS_UQ_INDEX" ]; then
    echo "[migrate] 5/5 UNIQUE INDEX uq_schedule_channel_start を作成"
    "${SQLITE[@]}" "$AUTOREC_DB" \
        "CREATE UNIQUE INDEX uq_schedule_channel_start ON schedule(channel, start_time);"
fi

# integrity_check
echo "[migrate] integrity_check..."
RESULT=$("${SQLITE[@]}" "$AUTOREC_DB" "PRAGMA integrity_check;")
if [ "$RESULT" != "ok" ]; then
    echo "[migrate] エラー: integrity_check 失敗: $RESULT" >&2
    echo "[migrate] バックアップから復元してください: cp $BACKUP_PATH $AUTOREC_DB"
    exit 3
fi

echo "[migrate] 完了。新スキーマ:"
"${SQLITE[@]}" "$AUTOREC_DB" ".schema schedule"
