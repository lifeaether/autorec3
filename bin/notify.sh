#!/bin/bash
# notify.sh - 通知送信
# autorec.conf の設定に基づき、録画結果を通知
#
# Usage: notify.sh <タイトル> <メッセージ>
set -euo pipefail

AUTOREC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$AUTOREC_DIR/conf/autorec.conf"

NOTIFY_TITLE="${1:-autorec}"
NOTIFY_MSG="${2:-}"

if [ -z "$NOTIFY_MSG" ]; then
    echo "[notify] メッセージが空のためスキップ"
    exit 0
fi

SENT=0

# Discord Webhook
if [ -n "${DISCORD_WEBHOOK:-}" ]; then
    PAYLOAD=$(jq -n --arg title "$NOTIFY_TITLE" --arg msg "$NOTIFY_MSG" \
        '{embeds: [{title: $title, description: $msg, color: 3447003}]}' 2>/dev/null) || \
    PAYLOAD="{\"embeds\":[{\"title\":\"$NOTIFY_TITLE\",\"description\":\"$NOTIFY_MSG\",\"color\":3447003}]}"

    if curl -s -o /dev/null -w "%{http_code}" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$DISCORD_WEBHOOK" | grep -q "^2"; then
        echo "[notify] Discord 送信完了"
        SENT=1
    else
        echo "[notify] 警告: Discord 送信失敗" >&2
    fi
fi

# LINE Notify
if [ -n "${LINE_NOTIFY_TOKEN:-}" ]; then
    if curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $LINE_NOTIFY_TOKEN" \
        -d "message=[${NOTIFY_TITLE}] ${NOTIFY_MSG}" \
        "https://notify-api.line.me/api/notify" | grep -q "^2"; then
        echo "[notify] LINE Notify 送信完了"
        SENT=1
    else
        echo "[notify] 警告: LINE Notify 送信失敗" >&2
    fi
fi

# 通知先未設定の場合
if [ "$SENT" -eq 0 ]; then
    echo "[notify] 通知先が未設定のためスキップ ($NOTIFY_TITLE: $NOTIFY_MSG)"
fi
