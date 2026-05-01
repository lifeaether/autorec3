#!/bin/bash
# 録画ファイル名命名ロジック (record.sh と web/recording_path.py で同一仕様)
#
# Usage: source recording_path.sh
#        OUTPUT_FILE=$(compute_output_path "$RULE_NAME" "$CHANNEL" "$TITLE" "$START_TIME" "$RECORD_DIR")
#
# 命名仕様変更時は web/recording_path.py も同様に変更すること。

_extract_series_name() {
    echo "$1" | sed -E \
        -e 's/【新】//g; s/【終】//g' \
        -e 's/「[^」]*」//g' \
        -e "s/『[^』]*』//g" \
        -e 's/（[０-９]+）//g' \
        -e 's/（[0-9]+）//g' \
        -e 's/\([0-9]+\)//g' \
        -e 's/[　 ]*[★☆][^ 　]*//g' \
        -e 's/[　 ]*＃[０-９0-9]+//g' \
        -e 's/[　 ]*#[0-9]+//g' \
        -e 's/[　 ]*第[０-９0-9一二三四五六七八九十百]+[回話]//g' \
        -e 's/[　 ]+（/（/g; s/[　 ]+【/【/g' \
        -e 's/[　 ]{2,}/　/g; s/[　 ]+$//; s/^[　 ]+//'
}

_sanitize_filename() {
    echo "$1" | sed 's/[\/\\:*?"<>|]/_/g'
}

compute_output_path() {
    local rule_name="$1"
    local channel="$2"
    local title="$3"
    local start_time="$4"
    local record_dir="$5"

    local series
    if [ -n "$rule_name" ] && [ "$rule_name" != "unknown" ]; then
        series="$rule_name"
    else
        series=$(_extract_series_name "$title")
    fi
    [ -z "$series" ] && series="$title"

    local safe_series safe_channel safe_title date_str
    safe_series=$(_sanitize_filename "$series")
    safe_channel=$(_sanitize_filename "$channel")
    safe_title=$(_sanitize_filename "$title")
    date_str=$(date -d "$start_time" '+%Y-%m-%d' 2>/dev/null) || \
        date_str=$(python3 -c "from datetime import datetime; print(datetime.fromisoformat('$start_time').strftime('%Y-%m-%d'))")

    local output_dir="$record_dir/$safe_series"
    local output_file="$output_dir/${date_str}_${safe_channel}_${safe_title}.ts"

    if [ -f "$output_file" ]; then
        output_file="$output_dir/${date_str}_${safe_channel}_${safe_title}_$(date '+%H%M%S').ts"
    fi

    echo "$output_file"
}
