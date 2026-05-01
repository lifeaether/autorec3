#!/bin/bash
# 一度限りの DB 移行スクリプト:
#   - schedule.status / schedule.output_path カラム削除
#   - log テーブル削除
#   - schedule に UNIQUE(channel, start_time) 制約追加
#
# idempotent: 既に移行済みならスキップする
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

AUTOREC_DB="${AUTOREC_DB:-$AUTOREC_DIR/db/autorec.sqlite}"
SQLITE=(sqlite3 -cmd ".timeout 5000")

if [ ! -f "$AUTOREC_DB" ]; then
    echo "[migrate] エラー: DB が見つかりません: $AUTOREC_DB" >&2
    exit 1
fi

# 録画中なら中断 (recpt1 が走っている間は危険)
if pgrep -x recpt1 >/dev/null 2>&1; then
    echo "[migrate] エラー: recpt1 が実行中です。録画停止中に再実行してください" >&2
    exit 2
fi

# 冪等性チェック: status カラムが既に消えていれば no-op
if ! "${SQLITE[@]}" "$AUTOREC_DB" "SELECT name FROM pragma_table_info('schedule')" | grep -qx "status"; then
    echo "[migrate] schedule.status カラムは既に削除済みです。スキップ"
    exit 0
fi

BACKUP_PATH="$AUTOREC_DIR/db/autorec.sqlite.bak-migrate-$(date +%Y%m%d-%H%M%S)"
echo "[migrate] バックアップ: $BACKUP_PATH"
cp "$AUTOREC_DB" "$BACKUP_PATH"

echo "[migrate] スキーマ移行を開始します..."
"${SQLITE[@]}" "$AUTOREC_DB" <<'SQL'
BEGIN;
ALTER TABLE schedule DROP COLUMN status;
ALTER TABLE schedule DROP COLUMN output_path;
DROP TABLE IF EXISTS log;
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_channel_start ON schedule(channel, start_time);
COMMIT;
SQL

echo "[migrate] integrity_check..."
RESULT=$("${SQLITE[@]}" "$AUTOREC_DB" "PRAGMA integrity_check;")
if [ "$RESULT" != "ok" ]; then
    echo "[migrate] エラー: integrity_check 失敗: $RESULT" >&2
    echo "[migrate] バックアップから復元してください: cp $BACKUP_PATH $AUTOREC_DB"
    exit 3
fi

echo "[migrate] 完了。新スキーマ:"
"${SQLITE[@]}" "$AUTOREC_DB" ".schema schedule"
