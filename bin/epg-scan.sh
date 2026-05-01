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

# 録画/Web 側との SQLite ロック競合を吸収
SQLITE=(sqlite3 -cmd ".timeout 5000")
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
    awk -F'\t' -v ch="$ch" '$1 == ch { print $2 }' \
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
    # Python で XML を解析
    # BS では1トランスポンダのスキャンに全チャンネルの番組が含まれるため、
    # 各番組の channel 属性から正しいチャンネル名を決定する
    python3 - "$EPG_XML" "$AUTOREC_DIR/conf/channels.conf" "$CHANNEL_NAME" \
        > "$WORK/insert.sql" 2>/dev/null << 'PYEOF'
import xml.etree.ElementTree as ET
import json, sys, unicodedata

xml_file, channels_conf, default_channel = sys.argv[1], sys.argv[2], sys.argv[3]

# channels.conf からチャンネル名一覧を取得
our_channels = set()
with open(channels_conf) as f:
    for line in f:
        line = line.split('#')[0].strip()
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) >= 2:
            our_channels.add(parts[1])

def normalize(s):
    """全角英数・記号を半角に正規化"""
    s = unicodedata.normalize('NFKC', s)
    for dash in '\u2010\u2012\u2013\u2014\u2015\u2212':
        s = s.replace(dash, '-')
    return s.strip()

tree = ET.parse(xml_file)
root = tree.getroot()

# XML <channel> 要素から channel_id → チャンネル名マッピングを構築
ch_map = {}
for ch_elem in root.findall('.//channel'):
    ch_id = ch_elem.get('id', '')
    dn = ch_elem.find('display-name')
    if dn is None or not dn.text:
        continue
    normalized = normalize(dn.text)
    # 完全一致
    matched = None
    for name in our_channels:
        if name == normalized:
            matched = name
            break
    # スペース除去して一致 (例: "BS12トゥエルビ" ↔ "BS12 トゥエルビ")
    if not matched:
        norm_nsp = normalized.replace(' ', '')
        for name in our_channels:
            if name.replace(' ', '') == norm_nsp:
                matched = name
                break
    # 前方一致 (例: channels.conf "BS11" ↔ XML "BS11イレブン")
    if not matched:
        norm_nsp = normalized.replace(' ', '')
        candidates = [n for n in our_channels
                      if norm_nsp.startswith(n.replace(' ', ''))
                      or n.replace(' ', '').startswith(norm_nsp)]
        if candidates:
            matched = max(candidates, key=len)
    if matched:
        ch_map[ch_id] = matched

# 番組データを SQL INSERT 文として出力
for prog in root.findall('.//programme'):
    ch_id = prog.get('channel', '')
    if ch_map:
        # マッピングがある場合、一致しないチャンネル (有料局等) はスキップ
        ch_name = ch_map.get(ch_id)
        if ch_name is None:
            continue
    else:
        # マッピングがない場合 (地上波等)、デフォルトチャンネル名を使用
        ch_name = default_channel
    if ch_name not in our_channels:
        continue
    eid = prog.get('event_id', '0') or '0'
    title = (prog.findtext('title') or '').replace("'", "''")
    desc = (prog.findtext('desc') or '').replace("'", "''")
    start = prog.get('start', '')
    stop = prog.get('stop', '')
    cats = [c.text for c in prog.findall('category') if c.text]
    cat_json = json.dumps(cats, ensure_ascii=False).replace("'", "''")
    ch_esc = ch_name.replace("'", "''")
    print(f"INSERT OR REPLACE INTO programme (event_id, channel, title, description, start_time, end_time, category) VALUES ({eid}, '{ch_esc}', '{title}', '{desc}', '{start}', '{stop}', '{cat_json}');")
PYEOF
fi

# SQL 実行
if [ -s "$WORK/insert.sql" ]; then
    COUNT=$(wc -l < "$WORK/insert.sql")
    echo "BEGIN TRANSACTION;" > "$WORK/batch.sql"
    cat "$WORK/insert.sql" >> "$WORK/batch.sql"
    # epgdump の日時形式 (YYYYMMDDHHmmSS +0900) を ISO 8601 に変換
    echo "UPDATE programme SET start_time = substr(start_time,1,4)||'-'||substr(start_time,5,2)||'-'||substr(start_time,7,2)||' '||substr(start_time,9,2)||':'||substr(start_time,11,2)||':'||substr(start_time,13,2) WHERE start_time NOT LIKE '____-__-%';" >> "$WORK/batch.sql"
    echo "UPDATE programme SET end_time = substr(end_time,1,4)||'-'||substr(end_time,5,2)||'-'||substr(end_time,7,2)||' '||substr(end_time,9,2)||':'||substr(end_time,11,2)||':'||substr(end_time,13,2) WHERE end_time NOT LIKE '____-__-%';" >> "$WORK/batch.sql"
    # 同一チャンネル・同一開始時刻でevent_idが異なる古い重複を削除
    cat >> "$WORK/batch.sql" << 'DEDUP'
DELETE FROM programme WHERE rowid IN (
    SELECT p1.rowid FROM programme p1
    INNER JOIN programme p2
        ON p1.channel = p2.channel AND p1.start_time = p2.start_time
    WHERE p1.event_id != p2.event_id
      AND (p1.updated_at < p2.updated_at
           OR (p1.updated_at = p2.updated_at AND p1.event_id < p2.event_id))
);
DEDUP
    echo "COMMIT;" >> "$WORK/batch.sql"
    "${SQLITE[@]}" "$EPG_DB" < "$WORK/batch.sql"
    echo "[epg-scan] 完了: $COUNT 番組を登録 (ch=$CHANNEL $CHANNEL_NAME)"
else
    echo "[epg-scan] 警告: 番組データが取得できませんでした (ch=$CHANNEL)" >&2
fi
