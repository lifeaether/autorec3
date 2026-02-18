#!/bin/bash
# epg-scan.sh - 1チャンネル分のEPGスキャン
# recpt1 → epgdump → jq/xmlstarlet → SQLite
#
# Usage: epg-scan.sh <チャンネル番号> [秒数]
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

EPG_DB="${EPG_DB:-$AUTOREC_DIR/db/epg.sqlite}"
SCAN_DURATION="${2:-30}"
CHANNEL="$1"
TMPDIR="${TMPDIR:-/tmp}"
WORK="$TMPDIR/autorec-epg-$$"

cleanup() {
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK"

# チャンネル番号から表示名を取得
get_channel_name() {
    local ch="$1"
    awk -v ch="$ch" '$1 == ch { for(i=2;i<=NF;i++) printf "%s%s", (i>2?" ":""), $i; print "" }' \
        "$AUTOREC_DIR/conf/channels.conf" | head -1
}

CHANNEL_NAME="$(get_channel_name "$CHANNEL")"
if [ -z "$CHANNEL_NAME" ]; then
    CHANNEL_NAME="ch$CHANNEL"
fi

echo "[epg-scan] チャンネル: $CHANNEL ($CHANNEL_NAME) 受信時間: ${SCAN_DURATION}秒"

# recpt1 で受信
TS_FILE="$WORK/epg.ts"
recpt1 --b25 "$CHANNEL" "$SCAN_DURATION" "$TS_FILE" 2>/dev/null || {
    echo "[epg-scan] エラー: recpt1 受信失敗 (ch=$CHANNEL)" >&2
    exit 1
}

# epgdump でEPGデータ抽出
# JSON出力を試行、失敗したらXML出力
EPG_JSON="$WORK/epg.json"
EPG_XML="$WORK/epg.xml"

USE_JSON=0
if epgdump --json "$CHANNEL" "$TS_FILE" "$EPG_JSON" 2>/dev/null; then
    USE_JSON=1
elif epgdump json "$CHANNEL" "$TS_FILE" "$EPG_JSON" 2>/dev/null; then
    USE_JSON=1
else
    # XML出力にフォールバック
    epgdump "$CHANNEL" "$TS_FILE" "$EPG_XML" 2>/dev/null || {
        echo "[epg-scan] エラー: epgdump 解析失敗 (ch=$CHANNEL)" >&2
        exit 1
    }
fi

# SQLite に INSERT
if [ "$USE_JSON" -eq 1 ] && command -v jq >/dev/null 2>&1; then
    echo "[epg-scan] JSON モードで解析中..."
    # jq で番組データを抽出し、SQLite の INSERT 文を生成
    jq -r '
        .[] | select(.title != null and .title != "") |
        @sh "INSERT OR REPLACE INTO programme (event_id, channel, title, description, start_time, end_time, category, extra) VALUES (\(.event_id // 0), \(.channel // "'"$CHANNEL_NAME"'"), \(.title), \(.description // ""), \(.start // ""), \(.end // ""), \((.category // []) | tojson), \((.extra // {}) | tojson));"
    ' "$EPG_JSON" 2>/dev/null | while IFS= read -r sql; do
        echo "$sql"
    done > "$WORK/insert.sql"

    # jq出力が空の場合、別のJSONフォーマットを試行
    if [ ! -s "$WORK/insert.sql" ]; then
        jq -r '
            .programs[]? // .programme[]? // empty |
            select(.title != null and .title != "") |
            "INSERT OR REPLACE INTO programme (event_id, channel, title, description, start_time, end_time, category, extra) VALUES ("
            + (.event_id // .eventId // 0 | tostring) + ", "
            + ("'"$CHANNEL_NAME"'" | @sh) + ", "
            + (.title | @sh) + ", "
            + ((.description // .desc // "") | @sh) + ", "
            + ((.start // .startTime // "") | @sh) + ", "
            + ((.end // .endTime // "") | @sh) + ", "
            + (((.category // .categories // []) | tojson) | @sh) + ", "
            + (((.extra // .detail // {}) | tojson) | @sh) + ");"
        ' "$EPG_JSON" > "$WORK/insert.sql" 2>/dev/null || true
    fi
else
    echo "[epg-scan] XML モードで解析中..."
    # xmlstarlet で XML を解析
    if ! command -v xmlstarlet >/dev/null 2>&1; then
        echo "[epg-scan] エラー: jq も xmlstarlet も見つかりません" >&2
        exit 1
    fi

    xmlstarlet sel -t \
        -m "//programme" \
        -v "concat('INSERT OR REPLACE INTO programme (event_id, channel, title, description, start_time, end_time, category) VALUES (')" \
        -v "@event_id" -o ", " \
        -o "'$CHANNEL_NAME', " \
        -o "'" -v "normalize-space(title)" -o "', " \
        -o "'" -v "normalize-space(desc)" -o "', " \
        -o "'" -v "@start" -o "', " \
        -o "'" -v "@stop" -o "', " \
        -o "'" -v "normalize-space(category)" -o "'" \
        -o ");" -n \
        "$EPG_XML" > "$WORK/insert.sql" 2>/dev/null || {
        # シンプルなフォールバック: python3 で XML パース
        python3 -c "
import xml.etree.ElementTree as ET
import json, sys

tree = ET.parse('$EPG_XML')
root = tree.getroot()
for prog in root.findall('.//programme'):
    eid = prog.get('event_id', '0') or '0'
    ch = '$CHANNEL_NAME'.replace(\"'\", \"''\")
    title = (prog.findtext('title') or '').replace(\"'\", \"''\")
    desc = (prog.findtext('desc') or '').replace(\"'\", \"''\")
    start = prog.get('start', '')
    stop = prog.get('stop', '')
    cats = [c.text for c in prog.findall('category') if c.text]
    cat_json = json.dumps(cats, ensure_ascii=False).replace(\"'\", \"''\")
    print(f\"INSERT OR REPLACE INTO programme (event_id, channel, title, description, start_time, end_time, category) VALUES ({eid}, '{ch}', '{title}', '{desc}', '{start}', '{stop}', '{cat_json}');\")
" > "$WORK/insert.sql" 2>/dev/null || true
    }
fi

# SQL 実行
if [ -s "$WORK/insert.sql" ]; then
    COUNT=$(wc -l < "$WORK/insert.sql")
    echo "BEGIN TRANSACTION;" > "$WORK/batch.sql"
    cat "$WORK/insert.sql" >> "$WORK/batch.sql"
    # epgdump の日時形式 (YYYYMMDDHHmmSS +0900) を ISO 8601 に変換
    echo "UPDATE programme SET start_time = substr(start_time,1,4)||'-'||substr(start_time,5,2)||'-'||substr(start_time,7,2)||' '||substr(start_time,9,2)||':'||substr(start_time,11,2)||':'||substr(start_time,13,2) WHERE start_time NOT LIKE '____-__-%';" >> "$WORK/batch.sql"
    echo "UPDATE programme SET end_time = substr(end_time,1,4)||'-'||substr(end_time,5,2)||'-'||substr(end_time,7,2)||' '||substr(end_time,9,2)||':'||substr(end_time,11,2)||':'||substr(end_time,13,2) WHERE end_time NOT LIKE '____-__-%';" >> "$WORK/batch.sql"
    echo "COMMIT;" >> "$WORK/batch.sql"
    sqlite3 "$EPG_DB" < "$WORK/batch.sql"
    echo "[epg-scan] 完了: $COUNT 番組を登録 (ch=$CHANNEL $CHANNEL_NAME)"
else
    echo "[epg-scan] 警告: 番組データが取得できませんでした (ch=$CHANNEL)" >&2
fi
