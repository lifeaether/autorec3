"""REST API ハンドラ for autorec Web UI"""
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
from urllib.parse import parse_qs

from recording_path import expected_output_path

AUTOREC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EPG_DB = os.path.join(AUTOREC_DIR, "db", "epg.sqlite")
AUTOREC_DB = os.path.join(AUTOREC_DIR, "db", "autorec.sqlite")
RECORD_DIR = "/mnt/data"
PLAYBACK_DIRS = ""

MAX_LIVE_STREAMS = 2
_live_streams = {}   # {stream_id: {"channel", "channel_name", "pid", "started_at"}}
_live_lock = threading.Lock()

# conf から DB パスを読み込み (あれば上書き)
_conf_path = os.path.join(AUTOREC_DIR, "conf", "autorec.conf")
if os.path.exists(_conf_path):
    with open(_conf_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            val = val.strip().strip('"').strip("'")
            val = val.replace("$AUTOREC_DIR", AUTOREC_DIR)
            if key.strip() == "EPG_DB" and val:
                EPG_DB = val
            elif key.strip() == "AUTOREC_DB" and val:
                AUTOREC_DB = val
            elif key.strip() == "RECORD_DIR" and val:
                RECORD_DIR = val
            elif key.strip() == "PLAYBACK_DIRS" and val:
                PLAYBACK_DIRS = val


# 再生対象ルート一覧 (RECORD_DIR を必ず先頭・優先。旧ディスク等を PLAYBACK_DIRS で追加)
PLAYBACK_ROOTS = [RECORD_DIR]
for _d in PLAYBACK_DIRS.split(":"):
    _d = _d.strip()
    if _d and _d not in PLAYBACK_ROOTS:
        PLAYBACK_ROOTS.append(_d)


def resolve_playback_path(rel_path):
    """rel_path ("シリーズ/ファイル") を再生ルート群から解決。実ファイルパス or None。

    各ルートごとに realpath 後の startswith 判定を行い、シンボリックリンク/".." による
    境界外流出を防ぎつつ、先頭ルート (RECORD_DIR) を優先して最初に見つかった実ファイルを返す。
    """
    for root in PLAYBACK_ROOTS:
        root_real = os.path.realpath(root)
        file_path = os.path.realpath(os.path.join(root, rel_path))
        if file_path != root_real and not file_path.startswith(root_real + os.sep):
            continue  # このルートの外 → 次のルートへ
        if os.path.isfile(file_path):
            return file_path
    return None


_connections = {}
_conn_lock = threading.Lock()


def _init_connection(db_path):
    """新しい SQLite 接続を作成し初期設定を実行"""
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    if db_path == EPG_DB:
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_programme_start_channel "
            "ON programme(start_time, channel)"
        )
    return conn


def _get_db(db_path):
    """SQLite 接続を取得 (モジュールレベルで共有)"""
    conn = _connections.get(db_path)
    if conn is not None:
        return conn
    with _conn_lock:
        conn = _connections.get(db_path)
        if conn is not None:
            return conn
        conn = _init_connection(db_path)
        _connections[db_path] = conn
        return conn


def _json_response(data, status=200):
    """JSON レスポンスを生成"""
    body = json.dumps(data, ensure_ascii=False, default=str)
    return status, "application/json", body.encode("utf-8")


def _error(message, status=400):
    return _json_response({"error": message}, status)


def _parse_json_body(body_bytes):
    """リクエストボディの JSON をパース"""
    try:
        return json.loads(body_bytes.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


# --- 番組表 API ---

def get_programmes(params):
    """GET /api/programmes - 番組表取得"""
    date = params.get("date", [""])[0]
    channel = params.get("channel", [""])[0]
    limit = int(params.get("limit", ["200"])[0])
    offset = int(params.get("offset", ["0"])[0])

    conditions = []
    args = []

    if date:
        # 日本の放送日慣行: 4:00起点 (date 04:00 〜 翌日 04:00)
        d = datetime.strptime(date, "%Y-%m-%d")
        next_day = (d + timedelta(days=1)).strftime("%Y-%m-%d")
        conditions.append("start_time >= ?")
        args.append(f"{date} 04:00:00")
        conditions.append("start_time < ?")
        args.append(f"{next_day} 04:00:00")
    if channel:
        conditions.append("channel = ?")
        args.append(channel)
    category = params.get("category", [""])[0]
    if category:
        conditions.append("category LIKE ?")
        args.append(f"%{category}%")
    active_after = params.get("active_after", [""])[0]
    if active_after:
        conditions.append("end_time > ?")
        args.append(active_after)

    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    conn = _get_db(EPG_DB)
    rows = conn.execute(
        f"SELECT event_id, channel, title, description, start_time, end_time, category, extra FROM programme {where} ORDER BY start_time, channel LIMIT ? OFFSET ?",
        args + [limit, offset],
    ).fetchall()
    programmes = [dict(r) for r in rows]
    return _json_response({
        "programmes": programmes,
        "total": len(programmes),
        "limit": limit,
        "offset": offset,
    })


def search_programmes(params):
    """GET /api/programmes/search - 番組表検索"""
    keyword = params.get("keyword", [""])[0]
    category = params.get("category", [""])[0]
    channel = params.get("channel", [""])[0]
    date_from = params.get("date_from", [""])[0]
    date_to = params.get("date_to", [""])[0]
    limit = int(params.get("limit", ["100"])[0])
    offset = int(params.get("offset", ["0"])[0])

    conditions = []
    args = []

    if keyword:
        conditions.append("(title LIKE ? OR description LIKE ?)")
        args.extend([f"%{keyword}%", f"%{keyword}%"])
    if category:
        conditions.append("category LIKE ?")
        args.append(f"%{category}%")
    if channel:
        conditions.append("channel = ?")
        args.append(channel)
    if date_from:
        conditions.append("start_time >= ?")
        args.append(date_from)
    if date_to:
        conditions.append("start_time <= ?")
        args.append(date_to)

    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    sort = params.get("sort", [""])[0]
    order = "ASC" if sort == "asc" else "DESC"

    conn = _get_db(EPG_DB)
    rows = conn.execute(
        f"SELECT * FROM programme {where} ORDER BY start_time {order} LIMIT ? OFFSET ?",
        args + [limit, offset],
    ).fetchall()
    total = conn.execute(
        f"SELECT COUNT(*) FROM programme {where}", args
    ).fetchone()[0]
    return _json_response({
        "programmes": [dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    })


def get_programme_stats(_params):
    """GET /api/programmes/stats - 番組統計"""
    conn = _get_db(EPG_DB)
    total = conn.execute("SELECT COUNT(*) FROM programme").fetchone()[0]
    by_channel = conn.execute(
        "SELECT channel, COUNT(*) as count FROM programme GROUP BY channel ORDER BY count DESC"
    ).fetchall()
    date_range = conn.execute(
        "SELECT MIN(start_time) as earliest, MAX(start_time) as latest FROM programme"
    ).fetchone()
    return _json_response({
        "total_programmes": total,
        "by_channel": [dict(r) for r in by_channel],
        "earliest": date_range["earliest"],
        "latest": date_range["latest"],
    })


def get_categories(_params):
    """GET /api/categories - ジャンル一覧"""
    conn = _get_db(EPG_DB)
    rows = conn.execute(
        "SELECT DISTINCT value FROM programme, json_each(programme.category) "
        "WHERE category IS NOT NULL ORDER BY value"
    ).fetchall()
    categories = [r[0] for r in rows if not r[0].isascii()]
    return _json_response({"categories": categories})


# --- 録画ルール API ---

def get_rules(_params):
    """GET /api/rules - 録画ルール一覧"""
    conn = _get_db(AUTOREC_DB)
    rows = conn.execute("SELECT * FROM rule ORDER BY priority DESC, id").fetchall()
    return _json_response({"rules": [dict(r) for r in rows]})


def create_rule(body):
    """POST /api/rules - ルール追加"""
    data = _parse_json_body(body)
    if not data:
        return _error("Invalid JSON body")
    if not data.get("name"):
        return _error("name is required")

    conn = _get_db(AUTOREC_DB)
    cursor = conn.execute(
        """INSERT INTO rule (name, keyword, channel, category, time_from, time_to, weekdays, enabled, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data["name"],
            data.get("keyword"),
            data.get("channel"),
            data.get("category"),
            data.get("time_from"),
            data.get("time_to"),
            data.get("weekdays"),
            data.get("enabled", 1),
            data.get("priority", 0),
        ),
    )
    conn.commit()

    # crontab 再生成 (非同期)
    script = os.path.join(AUTOREC_DIR, "bin", "schedule-update.sh")
    if os.path.exists(script):
        subprocess.Popen(["bash", script], cwd=AUTOREC_DIR)

    rule_id = cursor.lastrowid
    row = conn.execute("SELECT * FROM rule WHERE id = ?", (rule_id,)).fetchone()
    return _json_response({"rule": dict(row)}, 201)


def update_rule(rule_id, body):
    """PUT /api/rules/:id - ルール編集"""
    data = _parse_json_body(body)
    if not data:
        return _error("Invalid JSON body")

    conn = _get_db(AUTOREC_DB)
    existing = conn.execute("SELECT * FROM rule WHERE id = ?", (rule_id,)).fetchone()
    if not existing:
        return _error("Rule not found", 404)

    fields = ["name", "keyword", "channel", "category", "time_from", "time_to", "weekdays", "enabled", "priority"]
    updates = []
    args = []
    for f in fields:
        if f in data:
            updates.append(f"{f} = ?")
            args.append(data[f])

    if not updates:
        return _error("No fields to update")

    args.append(rule_id)
    conn.execute(f"UPDATE rule SET {', '.join(updates)} WHERE id = ?", args)

    # ルール無効化時は紐付く未来の予定も取り消し (過去の履歴は保持)
    cancelled = 0
    if data.get("enabled") == 0:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cancelled = conn.execute(
            "DELETE FROM schedule WHERE rule_id = ? AND start_time > ?", (rule_id, now)
        ).rowcount

    conn.commit()

    # crontab 再生成 (非同期)
    script = os.path.join(AUTOREC_DIR, "bin", "schedule-update.sh")
    if os.path.exists(script):
        subprocess.Popen(["bash", script], cwd=AUTOREC_DIR)

    row = conn.execute("SELECT * FROM rule WHERE id = ?", (rule_id,)).fetchone()
    result = {"rule": dict(row)}
    if cancelled:
        result["cancelled_schedules"] = cancelled
    return _json_response(result)


def delete_rule(rule_id):
    """DELETE /api/rules/:id - ルール削除 (紐付く予定も取り消し)"""
    conn = _get_db(AUTOREC_DB)
    existing = conn.execute("SELECT * FROM rule WHERE id = ?", (rule_id,)).fetchone()
    if not existing:
        return _error("Rule not found", 404)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cancelled = conn.execute(
        "DELETE FROM schedule WHERE rule_id = ? AND start_time > ?", (rule_id, now)
    ).rowcount
    conn.execute("DELETE FROM rule WHERE id = ?", (rule_id,))
    conn.commit()
    return _json_response({"deleted": rule_id, "cancelled_schedules": cancelled})


import re

_NEW_MARKER_RE = re.compile(r"【新】")
_TITLE_NORMALIZE_RE = re.compile(
    r"【[^】]*】|＃\d+|#\d+|　＃\d+|　#\d+|「[^」]*」|（[^）]*）|\s+$"
)


def get_new_programmes(_params):
    """GET /api/programmes/new - 新番組一覧 (EPG の【新】マーカーで検出)"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    epg = _get_db(EPG_DB)
    rows = epg.execute(
        "SELECT * FROM programme WHERE title LIKE '%【新】%' AND start_time > ? ORDER BY start_time",
        (now,),
    ).fetchall()

    # タイトル正規化してグループ化 (複数チャンネルの重複排除)
    seen = {}
    programmes = []
    for r in rows:
        d = dict(r)
        norm = _TITLE_NORMALIZE_RE.sub("", d["title"]).strip()
        norm = _NEW_MARKER_RE.sub("", norm).strip()
        d["normalized_title"] = norm
        if norm not in seen:
            seen[norm] = len(programmes)
            d["channels"] = [d["channel"]]
            programmes.append(d)
        else:
            programmes[seen[norm]]["channels"].append(d["channel"])

    # 既存ルールとの照合
    autorec = _get_db(AUTOREC_DB)
    rules = autorec.execute("SELECT keyword FROM rule WHERE enabled = 1 AND keyword IS NOT NULL AND keyword != ''").fetchall()
    keywords = [r["keyword"] for r in rules]

    for p in programmes:
        p["has_rule"] = any(kw in p["normalized_title"] for kw in keywords)
        # channels を重複排除
        p["channels"] = list(dict.fromkeys(p["channels"]))

    return _json_response({"programmes": programmes})


def get_ending_rules(_params):
    """GET /api/rules/ending - 終了候補ルール (未来の番組にマッチしないルール)"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    autorec = _get_db(AUTOREC_DB)
    rules = autorec.execute("SELECT * FROM rule WHERE enabled = 1 ORDER BY id").fetchall()
    if not rules:
        return _json_response({"rules": []})

    epg = _get_db(EPG_DB)
    ending = []
    for r in rules:
        kw = r["keyword"]
        ch = r["channel"]
        if not kw and not ch:
            continue  # 条件なしルールは対象外

        conditions = ["start_time > ?"]
        args = [now]
        if kw:
            conditions.append("title LIKE ?")
            args.append(f"%{kw}%")
        if ch:
            conditions.append("channel = ?")
            args.append(ch)

        where = " AND ".join(conditions)
        count = epg.execute(f"SELECT COUNT(*) FROM programme WHERE {where}", args).fetchone()[0]
        if count == 0:
            d = dict(r)
            d["future_count"] = 0
            ending.append(d)

    return _json_response({"rules": ending})


# --- スケジュール API ---

def get_schedules(params):
    """GET /api/schedules - 録画予約一覧 (時系列リスト)"""
    limit = int(params.get("limit", ["100"])[0])
    offset = int(params.get("offset", ["0"])[0])

    conn = _get_db(AUTOREC_DB)
    rows = conn.execute(
        """SELECT s.id, s.rule_id, s.event_id, s.channel, s.title,
                  s.start_time, s.end_time, r.name as rule_name
           FROM schedule s
           LEFT JOIN rule r ON s.rule_id = r.id
           ORDER BY s.start_time DESC
           LIMIT ? OFFSET ?""",
        (limit, offset),
    ).fetchall()
    total = conn.execute("SELECT COUNT(*) FROM schedule").fetchone()[0]
    return _json_response({
        "schedules": [dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    })


def create_schedule(body):
    """POST /api/schedules - 番組表から直接録画予定を追加"""
    data = _parse_json_body(body)
    if not data:
        return _error("Invalid JSON body")

    for field in ("event_id", "channel", "title", "start_time", "end_time"):
        if not data.get(field):
            return _error(f"{field} is required")

    conn = _get_db(AUTOREC_DB)
    # 重複は (channel, start_time) で判定 (UNIQUE 制約と同じキー)
    dup = conn.execute(
        "SELECT id FROM schedule WHERE channel = ? AND start_time = ?",
        (data["channel"], data["start_time"]),
    ).fetchone()
    if dup:
        return _error("この番組は既に録画予定に登録されています", 409)

    cursor = conn.execute(
        """INSERT INTO schedule (event_id, channel, title, start_time, end_time, rule_id)
           VALUES (?, ?, ?, ?, ?, NULL)""",
        (data["event_id"], data["channel"], data["title"], data["start_time"], data["end_time"]),
    )
    conn.commit()
    schedule_id = cursor.lastrowid

    # crontab 再生成 (非同期)
    script = os.path.join(AUTOREC_DIR, "bin", "schedule-update.sh")
    if os.path.exists(script):
        subprocess.Popen(["bash", script], cwd=AUTOREC_DIR)

    row = conn.execute(
        """SELECT id, rule_id, event_id, channel, title, start_time, end_time
           FROM schedule WHERE id = ?""", (schedule_id,)
    ).fetchone()
    return _json_response({"schedule": dict(row)}, 201)


# --- 録画中検出 API ---

# 録画ファイル mtime がこの秒数以内に更新されていれば「録画中」と判定する。
# recpt1 は連続書き込みで mtime を頻繁に更新する (数秒以内)。30 秒は十分な余裕。
RECORDING_MTIME_THRESHOLD = 30


def _is_actively_recording(path):
    """ファイルが存在し、mtime が直近なら録画中"""
    try:
        st = os.stat(path)
    except OSError:
        return False
    return (time.time() - st.st_mtime) < RECORDING_MTIME_THRESHOLD


def get_active_recordings(_params):
    """GET /api/recordings/active - 現在録画中の予約一覧

    - 録画時刻の窓内 (start_time 直前 〜 end_time 直後) の予約を SELECT
    - 命名規則で期待ファイルパスを計算し、存在 + mtime < 30s なら録画中
    """
    now = datetime.now()
    window_start = (now - timedelta(seconds=10)).strftime("%Y-%m-%d %H:%M:%S")
    window_end = (now + timedelta(seconds=30)).strftime("%Y-%m-%d %H:%M:%S")

    conn = _get_db(AUTOREC_DB)
    rows = conn.execute(
        """SELECT s.id, s.rule_id, s.event_id, s.channel, s.title,
                  s.start_time, s.end_time, r.name as rule_name
           FROM schedule s
           LEFT JOIN rule r ON s.rule_id = r.id
           WHERE s.start_time <= ? AND s.end_time >= ?
           ORDER BY s.start_time""",
        (window_end, window_start),
    ).fetchall()

    active = []
    for r in rows:
        path = expected_output_path(
            r["rule_name"], r["channel"], r["title"], r["start_time"], RECORD_DIR
        )
        if _is_actively_recording(path):
            d = dict(r)
            d["output_path"] = path
            active.append(d)

    return _json_response({"recordings": active})


# --- チャンネル一覧 API ---

def get_channels(_params):
    """GET /api/channels - チャンネル一覧"""
    channels = []
    conf_path = os.path.join(AUTOREC_DIR, "conf", "channels.conf")
    if os.path.exists(conf_path):
        with open(conf_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                fields = line.split("\t")
                fields = [f.strip() for f in fields if f.strip()]
                if len(fields) < 2:
                    continue
                number = fields[0]
                name = fields[1]
                sids = fields[2].split(",") if len(fields) >= 3 else []
                sids = [s.strip() for s in sids if s.strip()]
                services = []
                if len(sids) >= 2:
                    for i, sid in enumerate(sids):
                        services.append({"name": f"{name}{i + 1}", "sid": sid})
                channels.append({
                    "number": number,
                    "name": name,
                    "sid": sids[0] if sids else None,
                    "services": services,
                })
    return _json_response({"channels": channels})


def _get_valid_channels():
    """channels.conf から {番号: 名前} の dict を返す"""
    result = {}
    conf_path = os.path.join(AUTOREC_DIR, "conf", "channels.conf")
    if os.path.exists(conf_path):
        with open(conf_path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                fields = line.split("\t")
                fields = [f.strip() for f in fields if f.strip()]
                if len(fields) >= 2:
                    result[fields[0]] = fields[1]
    return result


def register_live_stream(channel_num, channel_name, pid, rec_ref=None,
                         stop_event=None, recpt1_proc=None, ffmpeg_proc=None):
    """登録成功時 stream_id を返す。上限超過時は None"""
    with _live_lock:
        if len(_live_streams) >= MAX_LIVE_STREAMS:
            return None
        stream_id = f"live_{pid}_{channel_num}"
        _live_streams[stream_id] = {
            "channel": channel_num,
            "channel_name": channel_name,
            "pid": pid,
            "started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "_rec_ref": rec_ref,
            "_stop_event": stop_event,
            "_recpt1_proc": recpt1_proc,
            "_ffmpeg_proc": ffmpeg_proc,
        }
        return stream_id


def unregister_live_stream(stream_id):
    """登録解除"""
    with _live_lock:
        _live_streams.pop(stream_id, None)


def get_live_status(_params):
    """GET /api/live/status"""
    with _live_lock:
        streams = []
        for sid, info in _live_streams.items():
            s = {"stream_id": sid}
            for k, v in info.items():
                if k.startswith("_"):
                    continue
                s[k] = v
            rec_ref = info.get("_rec_ref")
            if rec_ref:
                s["recording"] = rec_ref.get("file") is not None
                s["recording_path"] = rec_ref.get("path")
            else:
                s["recording"] = False
                s["recording_path"] = None
            streams.append(s)
    return _json_response({
        "active_streams": len(streams),
        "max_streams": MAX_LIVE_STREAMS,
        "streams": streams,
    })


def stop_all_live_streams(_body=None):
    """POST /api/live/stop-all — 全ライブ配信を停止 (録画優先)"""
    with _live_lock:
        streams_to_stop = list(_live_streams.values())

    stopped = 0
    for info in streams_to_stop:
        stop_event = info.get("_stop_event")
        recpt1_proc = info.get("_recpt1_proc")
        ffmpeg_proc = info.get("_ffmpeg_proc")
        if stop_event:
            stop_event.set()
        if recpt1_proc:
            try:
                recpt1_proc.terminate()
            except OSError:
                pass
        if ffmpeg_proc:
            try:
                ffmpeg_proc.terminate()
            except OSError:
                pass
        stopped += 1

    return _json_response({"stopped": stopped})


# 録画開始の何秒前にライブを止めてチューナーを空けるか (小さいほど切替の空白は短いが
# record.sh のチューナー取得リトライ(3回×2秒)頼みになる。大きいほど確実だが空白が伸びる)。
PREEMPT_LEAD_SEC = 3

# 追っかけ移行先の候補 (直近で開始した/開始間近の録画)。フロントがポーリングで拾う。
_pending_handoff = []          # [{schedule_id, channel, title, start_time, _ts}]
_handoff_lock = threading.Lock()


def get_live_handoff(_params=None):
    """GET /api/live/handoff — 録画開始でライブが停止された際の移行先 (録画中番組) を返す。

    schedule ベースなので、まだファイル (mtime) が育っていない開始直後でも返せる。
    """
    cutoff = time.time() - 30
    with _handoff_lock:
        recs = [
            {"schedule_id": r["schedule_id"], "channel": r["channel"], "title": r["title"]}
            for r in _pending_handoff if r["_ts"] >= cutoff
        ]
    return _json_response({"recordings": recs})


def _recording_guard():
    """録画直前にライブ配信を停止してチューナーを確保し、追っかけ移行先を記録する常駐スレッド。

    以前は「録画優先でライブを止めるだけ」だったが、UX 改善のため停止に加えて移行先
    (録画中番組) を _pending_handoff に記録し、フロントが追っかけ再生へ自然に移動できるようにする。
    """
    while True:
        time.sleep(2)
        try:
            conn = _get_db(AUTOREC_DB)
            now_dt = datetime.now()
            # 開始 PREEMPT_LEAD_SEC 秒前 〜 開始5秒後 (retry 救済) の録画を対象にする
            lead = (now_dt + timedelta(seconds=PREEMPT_LEAD_SEC)).strftime("%Y-%m-%d %H:%M:%S")
            back = (now_dt - timedelta(seconds=5)).strftime("%Y-%m-%d %H:%M:%S")
            rows = conn.execute(
                "SELECT id, channel, title, start_time FROM schedule "
                "WHERE start_time > ? AND start_time <= ? ORDER BY start_time",
                (back, lead),
            ).fetchall()
            if not rows:
                continue

            # 移行先候補を記録 (フロントがポーリングで拾う)。60秒より古いものは掃除。
            ts = time.time()
            with _handoff_lock:
                existing = {r["schedule_id"] for r in _pending_handoff}
                for row in rows:
                    if row["id"] not in existing:
                        _pending_handoff.append({
                            "schedule_id": row["id"], "channel": row["channel"],
                            "title": row["title"], "start_time": row["start_time"], "_ts": ts,
                        })
                _pending_handoff[:] = [r for r in _pending_handoff if r["_ts"] >= ts - 60]

            # 稼働中ライブがあればチューナーを解放 (録画の recpt1 起動前に空ける)
            with _live_lock:
                has_streams = len(_live_streams) > 0
            if has_streams:
                stop_all_live_streams()
        except Exception:
            pass


threading.Thread(target=_recording_guard, daemon=True).start()


def get_now_playing(params):
    """GET /api/live/now?channel=NHK総合"""
    channel = params.get("channel", [""])[0]
    if not channel:
        return _error("channel parameter is required")

    conn = _get_db(EPG_DB)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    row = conn.execute(
        "SELECT event_id, channel, title, start_time, end_time, category FROM programme "
        "WHERE channel = ? AND start_time <= ? AND end_time > ? "
        "ORDER BY start_time DESC LIMIT 1",
        (channel, now, now),
    ).fetchone()

    if row:
        return _json_response({"now_playing": dict(row)})
    return _json_response({"now_playing": None})


def get_now_playing_all(_params):
    """GET /api/live/now-all - 全チャンネルの放送中番組"""
    conn = _get_db(EPG_DB)
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rows = conn.execute(
        "SELECT event_id, channel, title, description, start_time, end_time, category FROM programme "
        "WHERE start_time <= ? AND end_time > ? "
        "ORDER BY channel, start_time DESC",
        (now, now),
    ).fetchall()

    by_channel = {}
    for r in rows:
        d = dict(r)
        ch = d["channel"]
        if ch not in by_channel:
            by_channel[ch] = d

    return _json_response({"now_playing": by_channel, "timestamp": now})


def _get_jikkyo_map():
    """jikkyo-map.conf → {channel_name: jk_id}"""
    result = {}
    path = os.path.join(AUTOREC_DIR, "conf", "jikkyo-map.conf")
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split(None, 1)
                if len(parts) >= 2:
                    result[parts[1]] = parts[0]  # name → jk_id
    return result


def start_live_recording(body):
    """POST /api/live/record/start - ライブ録画開始"""
    data = _parse_json_body(body)
    if not data:
        return _error("Invalid JSON body")

    channel = data.get("channel")
    if not channel:
        return _error("channel is required")

    # チャンネル番号でストリームを検索
    rec_ref = None
    channel_name = None
    with _live_lock:
        for info in _live_streams.values():
            if info["channel"] == channel:
                rec_ref = info.get("_rec_ref")
                channel_name = info.get("channel_name")
                break

    if rec_ref is None:
        return _error("このチャンネルのライブストリームが見つかりません", 404)

    if rec_ref.get("file") is not None:
        return _error("既に録画中です", 409)

    # 保存先ディレクトリ作成
    output_dir = os.path.join(RECORD_DIR, "ライブ録画")
    os.makedirs(output_dir, exist_ok=True)

    # ファイル名: YYYYMMDD_HHMMSS_チャンネル名.ts
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{timestamp}_{channel_name}.ts"
    output_path = os.path.join(output_dir, filename)

    try:
        rec_ref["path"] = output_path
        rec_ref["file"] = open(output_path, "wb")
    except Exception as e:
        rec_ref["file"] = None
        rec_ref["path"] = None
        return _error(f"ファイルの作成に失敗しました: {e}", 500)

    # 実況コメント保存 (対応チャンネルのみ)
    jikkyo_map = _get_jikkyo_map()
    jk_id = jikkyo_map.get(channel_name)
    jikkyo_proc = None
    if jk_id:
        nicojk_path = output_path.replace(".ts", ".nicojk")
        try:
            jikkyo_proc = subprocess.Popen(
                [sys.executable, os.path.join(AUTOREC_DIR, "bin", "jikkyo-rec.py"),
                 jk_id, "86400", nicojk_path],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass  # コメント保存失敗は無視
    rec_ref["jikkyo_proc"] = jikkyo_proc

    rel_path = f"ライブ録画/{filename}"
    return _json_response({"status": "recording", "path": rel_path})


def stop_live_recording(body):
    """POST /api/live/record/stop - ライブ録画停止"""
    data = _parse_json_body(body)
    if not data:
        return _error("Invalid JSON body")

    channel = data.get("channel")
    if not channel:
        return _error("channel is required")

    # チャンネル番号でストリームを検索
    rec_ref = None
    with _live_lock:
        for info in _live_streams.values():
            if info["channel"] == channel:
                rec_ref = info.get("_rec_ref")
                break

    if rec_ref is None:
        return _error("このチャンネルのライブストリームが見つかりません", 404)

    f = rec_ref.get("file")
    saved_path = rec_ref.get("path")
    rec_ref["file"] = None
    rec_ref["path"] = None
    if f is not None:
        try:
            f.close()
        except OSError:
            pass

    # jikkyo-rec.py 停止
    jikkyo_proc = rec_ref.get("jikkyo_proc")
    if jikkyo_proc:
        jikkyo_proc.terminate()
        try:
            jikkyo_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            jikkyo_proc.kill()
        rec_ref["jikkyo_proc"] = None

    rel_path = None
    if saved_path:
        try:
            rel_path = os.path.relpath(saved_path, RECORD_DIR)
        except ValueError:
            rel_path = saved_path

    return _json_response({"status": "stopped", "path": rel_path})


def _extract_ts_start_time(filepath):
    """MPEG-TS ファイルの先頭付近から TDT を読み取り、(unix_epoch, tdt_byte_offset) を返す

    tdt_byte_offset はファイル先頭から TDT パケットまでのバイト数。
    ファイルサイズと再生時間から TDT の時間位置を補正するために使う。
    """
    TS_PACKET_SIZE = 188
    TDT_PID = 0x0014
    MAX_READ = 10 * 1024 * 1024  # 先頭 10MB のみスキャン

    with open(filepath, 'rb') as f:
        buf = f.read(MAX_READ)

    buf_len = len(buf)

    # sync byte (0x47) を確実に見つける: 3 連続パケットの sync を確認
    start = -1
    for i in range(min(buf_len - TS_PACKET_SIZE * 3, TS_PACKET_SIZE)):
        if (buf[i] == 0x47
                and buf[i + TS_PACKET_SIZE] == 0x47
                and buf[i + TS_PACKET_SIZE * 2] == 0x47):
            start = i
            break
    if start < 0:
        return None

    pos = start
    while pos + TS_PACKET_SIZE <= buf_len:
        if buf[pos] != 0x47:
            pos += 1
            continue

        pid = ((buf[pos + 1] & 0x1F) << 8) | buf[pos + 2]
        if pid != TDT_PID:
            pos += TS_PACKET_SIZE
            continue

        # adaptation field スキップ
        afc = (buf[pos + 3] >> 4) & 0x03
        if not (afc & 0x01):  # payload なし
            pos += TS_PACKET_SIZE
            continue
        payload_start = pos + 4
        if afc in (2, 3):  # adaptation field あり
            af_len = buf[pos + 4]
            payload_start = pos + 5 + af_len
        if payload_start >= pos + TS_PACKET_SIZE:
            pos += TS_PACKET_SIZE
            continue

        # PUSI (payload_unit_start_indicator) チェック
        pusi = (buf[pos + 1] >> 6) & 0x01
        if pusi:
            pointer = buf[payload_start]
            section = payload_start + 1 + pointer
        else:
            section = payload_start

        if section + 8 > pos + TS_PACKET_SIZE:
            pos += TS_PACKET_SIZE
            continue

        table_id = buf[section]
        if table_id not in (0x70, 0x73):  # TDT or TOT
            pos += TS_PACKET_SIZE
            continue

        # UTC/JST time: 5 bytes (2 MJD + 3 BCD)
        t = section + 3
        mjd = (buf[t] << 8) | buf[t + 1]
        hour = (buf[t + 2] >> 4) * 10 + (buf[t + 2] & 0x0F)
        minute = (buf[t + 3] >> 4) * 10 + (buf[t + 3] & 0x0F)
        second = (buf[t + 4] >> 4) * 10 + (buf[t + 4] & 0x0F)

        # MJD → Unix days (MJD of Unix epoch = 40587)
        unix_days = mjd - 40587
        # ARIB 規格では TDT は JST (UTC+9) なので 9時間引く
        unix_epoch = unix_days * 86400 + hour * 3600 + minute * 60 + second - 9 * 3600

        return unix_epoch, pos - start

    return None


def get_recording_duration(params):
    """GET /api/recordings/duration?path=<path> - ffprobe で再生時間を取得"""
    rel_path = params.get("path", [""])[0]
    if not rel_path:
        return _error("path parameter is required")

    file_path = resolve_playback_path(rel_path)
    if not file_path:
        return _error("Not found", 404)

    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "json", file_path],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        duration = float(data["format"]["duration"])
        resp = {"duration": duration}

        # TDT から録画開始時刻を取得 (TDT 位置分を補正)
        try:
            tdt_result = _extract_ts_start_time(file_path)
            if tdt_result:
                tdt_epoch, tdt_byte_offset = tdt_result
                # TDT はファイル先頭ではなく数秒後にある。
                # バイト位置から時間オフセットを推定して差し引く
                file_size = os.path.getsize(file_path)
                if file_size > 0 and duration > 0:
                    tdt_time_offset = (tdt_byte_offset / file_size) * duration
                else:
                    tdt_time_offset = 0
                resp["start_time"] = tdt_epoch - tdt_time_offset
        except Exception:
            pass

        return _json_response(resp)
    except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError,
            subprocess.TimeoutExpired):
        return _error("Could not determine duration", 500)


# --- TS プログラム解析 ---
# TOKYO MX 等のマルチプログラム TS から「メイン」(最大解像度) を選び、
# またフロントに program 一覧を返すための補助 API。

_program_cache = {}
_program_cache_lock = threading.Lock()


def _probe_programs(file_path):
    """ffprobe で TS の programs[] を解析し、構造化したリストを返す。

    結果は (path, mtime, size) をキーにキャッシュ。失敗時は None。
    返値の各要素: {program_id, name, video, audio}
        video: {codec, width, height} | None
        audio: {codec, channels} | None
    """
    try:
        st = os.stat(file_path)
    except OSError:
        return None
    key = (file_path, st.st_mtime, st.st_size)
    with _program_cache_lock:
        cached = _program_cache.get(key)
    if cached is not None:
        return cached

    try:
        result = subprocess.run(
            ["ffprobe", "-hide_banner", "-loglevel", "error",
             "-analyzeduration", "2000000", "-probesize", "4000000",
             "-show_programs", "-show_streams", "-of", "json", file_path],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout or "{}")
    except (FileNotFoundError, json.JSONDecodeError, subprocess.TimeoutExpired,
            OSError):
        return None

    programs_raw = data.get("programs") or []
    programs = []
    seen_ids = set()
    for p in programs_raw:
        pid = p.get("program_id")
        if pid is None or pid in seen_ids:
            continue
        seen_ids.add(pid)
        tags = p.get("tags") or {}
        raw_name = tags.get("service_name") or ""
        # ARIB 8 単位符号の制御文字 (SI/SO/ESC 等) と
        # UTF-8 デコード不能バイトの置換文字 (U+FFFD) を除去
        name = "".join(
            c for c in raw_name if c.isprintable() and c != "�"
        ).strip()
        if not name:
            name = f"program {pid}"
        video = None
        audio = None
        for s in p.get("streams") or []:
            ctype = s.get("codec_type")
            if ctype == "video" and video is None:
                w = s.get("width") or 0
                h = s.get("height") or 0
                # EPG 等の解像度なし stream は除外
                if w and h:
                    video = {
                        "codec": s.get("codec_name", ""),
                        "width": w,
                        "height": h,
                    }
            elif ctype == "audio" and audio is None:
                audio = {
                    "codec": s.get("codec_name", ""),
                    "channels": s.get("channels", 0),
                }
        # video/audio どちらも持たない program (EPG のみ等) はスキップ
        if video is None and audio is None:
            continue
        programs.append({
            "program_id": pid,
            "name": name.strip() if isinstance(name, str) else f"program {pid}",
            "video": video,
            "audio": audio,
        })

    with _program_cache_lock:
        _program_cache[key] = programs
    return programs


def _select_main_program(file_path):
    """最大解像度を持つ program の program_id を返す。

    - 単一 program / program 不明 / ffprobe 失敗時は None
    - 複数 program があり、video を持つものが 1 つだけなら None (現状の自動選択で十分)
    """
    programs = _probe_programs(file_path)
    if not programs or len(programs) <= 1:
        return None
    video_programs = [p for p in programs if p.get("video")]
    if len(video_programs) <= 1:
        return None
    best = max(
        video_programs,
        key=lambda p: (p["video"]["width"] * p["video"]["height"], -programs.index(p)),
    )
    return best["program_id"]


def get_recording_programs(params):
    """GET /api/recording/programs?path=<rel> | ?schedule_id=<id>
    TS に含まれる program 一覧と推奨 program_id を返す。
    """
    rel_path = params.get("path", [""])[0]
    schedule_id = params.get("schedule_id", [""])[0]

    if rel_path:
        file_path = resolve_playback_path(rel_path)
        if not file_path:
            return _error("Not found", 404)
    elif schedule_id:
        try:
            row = _get_db(AUTOREC_DB).execute(
                """SELECT s.channel, s.title, s.start_time,
                          COALESCE(r.name, '') as rule_name
                   FROM schedule s LEFT JOIN rule r ON s.rule_id = r.id
                   WHERE s.id = ?""",
                (schedule_id,),
            ).fetchone()
        except sqlite3.Error:
            return _error("Database error", 500)
        if not row:
            return _error("Schedule not found", 404)
        file_path = expected_output_path(
            row["rule_name"], row["channel"], row["title"], row["start_time"],
            RECORD_DIR,
        )
    else:
        return _error("path or schedule_id parameter is required")

    if not os.path.isfile(file_path):
        return _error("Not found", 404)

    programs = _probe_programs(file_path) or []
    default_id = _select_main_program(file_path)
    if default_id is None and programs:
        # 単一 program はそれが「メイン」
        default_id = programs[0]["program_id"]

    return _json_response({
        "programs": [
            {**p, "is_main": (p["program_id"] == default_id)}
            for p in programs
        ],
        "default_program_id": default_id,
    })


# --- 録画済みファイル API ---

def get_recordings(_params):
    """GET /api/recordings - 録画済みファイル一覧 (全再生ルートを横断してマージ)"""
    # シリーズ名をキーにマージ。ルートは PLAYBACK_ROOTS の優先順で走査し、
    # 同名シリーズ・同名ファイルは先頭ルート (RECORD_DIR) を優先して後続をスキップ。
    series_map = {}   # name -> {"files", "seen", "total_size", "max_mtime"}

    for root in PLAYBACK_ROOTS:
        if not os.path.isdir(root):
            continue
        try:
            with os.scandir(root) as entries:
                for entry in entries:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    s = series_map.setdefault(entry.name, {
                        "files": [], "seen": set(), "total_size": 0, "max_mtime": 0.0,
                    })
                    try:
                        with os.scandir(entry.path) as sub_entries:
                            for f in sub_entries:
                                if not f.is_file(follow_symlinks=False):
                                    continue
                                if not f.name.endswith(".ts"):
                                    continue
                                if f.name in s["seen"]:
                                    continue  # 先頭ルート優先: 後続ルートの同名ファイルは無視
                                try:
                                    stat = f.stat()
                                except OSError:
                                    continue
                                mtime = stat.st_mtime
                                if mtime > s["max_mtime"]:
                                    s["max_mtime"] = mtime
                                nicojk_path = os.path.join(entry.path, f.name.rsplit('.', 1)[0] + '.nicojk')
                                s["seen"].add(f.name)
                                s["files"].append({
                                    "name": f.name,
                                    "size": stat.st_size,
                                    "mtime": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S"),
                                    "mtime_ts": mtime,
                                    "path": f"{entry.name}/{f.name}",
                                    "has_nicojk": os.path.isfile(nicojk_path),
                                })
                                s["total_size"] += stat.st_size
                    except OSError:
                        continue
        except OSError:
            continue

    series = []
    for name, s in series_map.items():
        files = s["files"]
        if not files:
            continue
        files.sort(key=lambda f: f["mtime_ts"], reverse=True)
        for f in files:
            del f["mtime_ts"]
        series.append({
            "name": name,
            "file_count": len(files),
            "total_size": s["total_size"],
            "max_mtime": s["max_mtime"],
            "files": files,
        })

    series.sort(key=lambda s: s["max_mtime"], reverse=True)
    for s in series:
        del s["max_mtime"]

    return _json_response({"series": series})


# --- ストレージ API ---

def get_storage(_params):
    """GET /api/storage - ディスク使用状況 + シリーズ別内訳"""
    # ディスク全体の情報
    try:
        st = os.statvfs(RECORD_DIR)
    except OSError as e:
        return _error(f"RECORD_DIR にアクセスできません: {e}", 500)

    total = st.f_frsize * st.f_blocks
    free = st.f_frsize * st.f_bavail
    used = total - free
    usage_percent = round((used / total) * 100, 1) if total > 0 else 0.0

    disk = {
        "path": RECORD_DIR,
        "total": total,
        "used": used,
        "free": free,
        "usage_percent": usage_percent,
    }

    # シリーズ別サイズ集計 (.ts ファイルのみ)
    series = []
    if os.path.isdir(RECORD_DIR):
        try:
            with os.scandir(RECORD_DIR) as entries:
                for entry in entries:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    file_count = 0
                    total_size = 0
                    try:
                        with os.scandir(entry.path) as sub_entries:
                            for f in sub_entries:
                                if not f.is_file(follow_symlinks=False):
                                    continue
                                if not f.name.endswith(".ts"):
                                    continue
                                try:
                                    total_size += f.stat().st_size
                                    file_count += 1
                                except OSError:
                                    continue
                    except OSError:
                        continue
                    if file_count > 0:
                        series.append({
                            "name": entry.name,
                            "file_count": file_count,
                            "total_size": total_size,
                        })
        except OSError:
            pass

    series.sort(key=lambda s: s["total_size"], reverse=True)
    return _json_response({"disk": disk, "series": series})


# --- NX-Jikkyo プロキシ ---

def proxy_jikkyo_channel(jk_id):
    """GET /api/jikkyo/channels/{jk_id} - NX-Jikkyo チャンネル情報プロキシ (CORS対策)"""
    import re
    import urllib.request
    import urllib.error

    # jk_id バリデーション (jk1〜jk999)
    if not re.match(r'^jk\d{1,3}$', jk_id):
        return _error("Invalid jikkyo channel ID")

    url = f"https://nx-jikkyo.tsukumijima.net/api/v1/channels/{jk_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "autorec/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read()
            return 200, "application/json", data
    except urllib.error.HTTPError as e:
        return _json_response({"error": f"NX-Jikkyo returned {e.code}"}, e.code)
    except Exception:
        return _json_response({"error": "NX-Jikkyo connection failed"}, 502)


_jikkyo_force_cache = {"data": None, "expires": 0}

def get_jikkyo_force(_params):
    """GET /api/jikkyo/force - 全チャンネルの実況勢い"""
    import time as _time
    import urllib.request
    import urllib.error

    now = _time.time()
    if _jikkyo_force_cache["data"] is not None and now < _jikkyo_force_cache["expires"]:
        return _json_response(_jikkyo_force_cache["data"])

    try:
        req = urllib.request.Request(
            "https://nx-jikkyo.tsukumijima.net/api/v1/channels",
            headers={"User-Agent": "autorec/1.0"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            channels_data = json.loads(resp.read())
    except Exception:
        if _jikkyo_force_cache["data"] is not None:
            return _json_response(_jikkyo_force_cache["data"])
        return _json_response({"force": {}})

    force = {}
    for ch in channels_data:
        for t in ch.get("threads", []):
            if t.get("status") == "ACTIVE":
                force[ch["id"]] = {
                    "force": t.get("jikkyo_force"),
                    "viewers": t.get("viewers"),
                }
                break

    result = {"force": force}
    _jikkyo_force_cache["data"] = result
    _jikkyo_force_cache["expires"] = now + 60
    return _json_response(result)


# --- ルーティング ---

def handle_request(method, path, params, body=b""):
    """API リクエストのルーティング"""
    # 番組表
    if method == "GET" and path == "/api/programmes":
        return get_programmes(params)
    if method == "GET" and path == "/api/programmes/search":
        return search_programmes(params)
    if method == "GET" and path == "/api/programmes/stats":
        return get_programme_stats(params)
    if method == "GET" and path == "/api/categories":
        return get_categories(params)

    # 番組改編
    if method == "GET" and path == "/api/programmes/new":
        return get_new_programmes(params)
    if method == "GET" and path == "/api/rules/ending":
        return get_ending_rules(params)

    # ルール
    if method == "GET" and path == "/api/rules":
        return get_rules(params)
    if method == "POST" and path == "/api/rules":
        return create_rule(body)
    if method == "PUT" and path.startswith("/api/rules/"):
        rule_id = int(path.split("/")[-1])
        return update_rule(rule_id, body)
    if method == "DELETE" and path.startswith("/api/rules/"):
        rule_id = int(path.split("/")[-1])
        return delete_rule(rule_id)

    # スケジュール
    if method == "GET" and path == "/api/schedules":
        return get_schedules(params)
    if method == "POST" and path == "/api/schedules":
        return create_schedule(body)

    # チャンネル
    if method == "GET" and path == "/api/channels":
        return get_channels(params)

    # ライブ視聴
    if method == "GET" and path == "/api/live/status":
        return get_live_status(params)
    if method == "GET" and path == "/api/live/now":
        return get_now_playing(params)
    if method == "GET" and path == "/api/live/now-all":
        return get_now_playing_all(params)
    if method == "GET" and path == "/api/live/handoff":
        return get_live_handoff(params)

    # ライブ制御
    if method == "POST" and path == "/api/live/stop-all":
        return stop_all_live_streams(body)

    # ライブ録画
    if method == "POST" and path == "/api/live/record/start":
        return start_live_recording(body)
    if method == "POST" and path == "/api/live/record/stop":
        return stop_live_recording(body)

    # ストレージ
    if method == "GET" and path == "/api/storage":
        return get_storage(params)

    # 録画済みファイル
    if method == "GET" and path == "/api/recordings":
        return get_recordings(params)
    if method == "GET" and path == "/api/recordings/duration":
        return get_recording_duration(params)
    if method == "GET" and path == "/api/recordings/active":
        return get_active_recordings(params)
    if method == "GET" and path == "/api/recording/programs":
        return get_recording_programs(params)

    # NX-Jikkyo プロキシ
    if method == "GET" and path == "/api/jikkyo/force":
        return get_jikkyo_force(params)
    if method == "GET" and path.startswith("/api/jikkyo/channels/"):
        jk_id = path.split("/")[-1]
        return proxy_jikkyo_channel(jk_id)

    # サーバ情報 (iOS アプリ等の疎通確認・機能検出用)
    if method == "GET" and path == "/api/server/info":
        return get_server_info(params)

    # HLS 配信の診断ダンプ (失敗時のログ確認用)
    if method == "GET" and path == "/api/hls/debug":
        return get_hls_debug(params)

    return _error("Not found", 404)


def get_hls_debug(_params):
    """GET /api/hls/debug - HLS セッション稼働状況と ffmpeg/recpt1 ログを返す"""
    import hls
    return _json_response(hls.debug_dump())


# --- サーバ情報 ---

SERVER_API_VERSION = 1


def get_server_info(_params):
    """GET /api/server/info - クライアント向けサーバ機能情報"""
    return _json_response({
        "name": "autorec",
        "api_version": SERVER_API_VERSION,
        "max_live_streams": MAX_LIVE_STREAMS,
        "hls_enabled": True,
        "endpoints": {
            "hls_live": "/hls/live",
            "hls_recording": "/hls/recording",
            "mpegts_live": "/live/stream",
            "mpegts_recording_transcode": "/recordings/transcode",
            "mpegts_recording_live": "/recordings/live",
            "recording_file": "/recordings/",
        },
        "quality_presets": ["original", "high", "medium", "low"],
        "audio_modes": ["stereo", "main", "sub"],
    })
