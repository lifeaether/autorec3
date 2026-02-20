"""REST API ハンドラ for autorec Web UI"""
import json
import os
import sqlite3
import subprocess
import threading
from datetime import datetime, timedelta
from urllib.parse import parse_qs

AUTOREC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EPG_DB = os.path.join(AUTOREC_DIR, "db", "epg.sqlite")
AUTOREC_DB = os.path.join(AUTOREC_DIR, "db", "autorec.sqlite")
RECORD_DIR = "/mnt/data"

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
        f"SELECT event_id, channel, title, description, start_time, end_time, category FROM programme {where} ORDER BY start_time, channel LIMIT ? OFFSET ?",
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

    # ルール無効化時は紐付く予定も取り消し
    cancelled = 0
    if data.get("enabled") == 0:
        cancelled = conn.execute(
            "DELETE FROM schedule WHERE rule_id = ? AND status = 'scheduled'", (rule_id,)
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
    cancelled = conn.execute(
        "DELETE FROM schedule WHERE rule_id = ? AND status = 'scheduled'", (rule_id,)
    ).rowcount
    conn.execute("DELETE FROM rule WHERE id = ?", (rule_id,))
    conn.commit()
    return _json_response({"deleted": rule_id, "cancelled_schedules": cancelled})


# --- スケジュール API ---

def get_schedules(params):
    """GET /api/schedules - 録画予定一覧"""
    status = params.get("status", [""])[0]
    limit = int(params.get("limit", ["100"])[0])
    offset = int(params.get("offset", ["0"])[0])

    conditions = []
    args = []
    if status:
        conditions.append("s.status = ?")
        args.append(status)

    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    conn = _get_db(AUTOREC_DB)
    rows = conn.execute(
        f"""SELECT s.*, r.name as rule_name
            FROM schedule s
            LEFT JOIN rule r ON s.rule_id = r.id
            {where}
            ORDER BY s.start_time ASC
            LIMIT ? OFFSET ?""",
        args + [limit, offset],
    ).fetchall()
    total = conn.execute(
        f"SELECT COUNT(*) FROM schedule s {where}", args
    ).fetchone()[0]
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
    dup = conn.execute(
        "SELECT id FROM schedule WHERE event_id = ? AND channel = ? AND status IN ('scheduled','recording','done')",
        (data["event_id"], data["channel"]),
    ).fetchone()
    if dup:
        return _error("この番組は既に録画予定に登録されています", 409)

    cursor = conn.execute(
        """INSERT INTO schedule (event_id, channel, title, start_time, end_time, rule_id, status)
           VALUES (?, ?, ?, ?, ?, NULL, 'scheduled')""",
        (data["event_id"], data["channel"], data["title"], data["start_time"], data["end_time"]),
    )
    conn.commit()
    schedule_id = cursor.lastrowid

    # crontab 再生成 (非同期)
    script = os.path.join(AUTOREC_DIR, "bin", "schedule-update.sh")
    if os.path.exists(script):
        subprocess.Popen(["bash", script], cwd=AUTOREC_DIR)

    row = conn.execute("SELECT * FROM schedule WHERE id = ?", (schedule_id,)).fetchone()
    return _json_response({"schedule": dict(row)}, 201)


# --- ログ API ---

def get_logs(params):
    """GET /api/logs - 録画ログ"""
    level = params.get("level", [""])[0]
    schedule_id = params.get("schedule_id", [""])[0]
    limit = int(params.get("limit", ["100"])[0])
    offset = int(params.get("offset", ["0"])[0])

    conditions = []
    args = []
    if level:
        conditions.append("l.level = ?")
        args.append(level)
    if schedule_id:
        conditions.append("l.schedule_id = ?")
        args.append(int(schedule_id))

    where = "WHERE " + " AND ".join(conditions) if conditions else ""

    conn = _get_db(AUTOREC_DB)
    rows = conn.execute(
        f"""SELECT l.*, s.title as schedule_title, s.channel as schedule_channel
            FROM log l
            LEFT JOIN schedule s ON l.schedule_id = s.id
            {where}
            ORDER BY l.timestamp DESC
            LIMIT ? OFFSET ?""",
        args + [limit, offset],
    ).fetchall()
    total = conn.execute(
        f"SELECT COUNT(*) FROM log l {where}", args
    ).fetchone()[0]
    return _json_response({
        "logs": [dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    })


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
                parts = line.split(None, 1)
                if len(parts) >= 2:
                    channels.append({"number": parts[0], "name": parts[1]})
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
                parts = line.split(None, 1)
                if len(parts) >= 2:
                    result[parts[0]] = parts[1]
    return result


def register_live_stream(channel_num, channel_name, pid):
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
        }
        return stream_id


def unregister_live_stream(stream_id):
    """登録解除"""
    with _live_lock:
        _live_streams.pop(stream_id, None)


def get_live_status(_params):
    """GET /api/live/status"""
    with _live_lock:
        streams = [
            {"stream_id": sid, **info}
            for sid, info in _live_streams.items()
        ]
    return _json_response({
        "active_streams": len(streams),
        "max_streams": MAX_LIVE_STREAMS,
        "streams": streams,
    })


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


def get_recording_duration(params):
    """GET /api/recordings/duration?path=<path> - ffprobe で再生時間を取得"""
    rel_path = params.get("path", [""])[0]
    if not rel_path:
        return _error("path parameter is required")

    file_path = os.path.realpath(os.path.join(RECORD_DIR, rel_path))
    record_dir_real = os.path.realpath(RECORD_DIR)
    if not file_path.startswith(record_dir_real + os.sep) and file_path != record_dir_real:
        return _error("Forbidden", 403)

    if not os.path.isfile(file_path):
        return _error("Not found", 404)

    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "json", file_path],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        duration = float(data["format"]["duration"])
        return _json_response({"duration": duration})
    except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError,
            subprocess.TimeoutExpired):
        return _error("Could not determine duration", 500)


# --- 録画済みファイル API ---

def get_recordings(_params):
    """GET /api/recordings - 録画済みファイル一覧"""
    series = []
    if not os.path.isdir(RECORD_DIR):
        return _json_response({"series": []})

    try:
        with os.scandir(RECORD_DIR) as entries:
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                files = []
                total_size = 0
                max_mtime = 0.0
                try:
                    with os.scandir(entry.path) as sub_entries:
                        for f in sub_entries:
                            if not f.is_file(follow_symlinks=False):
                                continue
                            if not f.name.endswith(".ts"):
                                continue
                            try:
                                stat = f.stat()
                                mtime = stat.st_mtime
                                if mtime > max_mtime:
                                    max_mtime = mtime
                                files.append({
                                    "name": f.name,
                                    "size": stat.st_size,
                                    "mtime": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S"),
                                    "mtime_ts": mtime,
                                    "path": f"{entry.name}/{f.name}",
                                })
                                total_size += stat.st_size
                            except OSError:
                                continue
                except OSError:
                    continue
                if files:
                    files.sort(key=lambda f: f["mtime_ts"], reverse=True)
                    for f in files:
                        del f["mtime_ts"]
                    series.append({
                        "name": entry.name,
                        "file_count": len(files),
                        "total_size": total_size,
                        "max_mtime": max_mtime,
                        "files": files,
                    })
    except OSError:
        return _json_response({"series": []})

    series.sort(key=lambda s: s["max_mtime"], reverse=True)
    for s in series:
        del s["max_mtime"]

    return _json_response({"series": series})


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

    # ログ
    if method == "GET" and path == "/api/logs":
        return get_logs(params)

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

    # 録画済みファイル
    if method == "GET" and path == "/api/recordings":
        return get_recordings(params)
    if method == "GET" and path == "/api/recordings/duration":
        return get_recording_duration(params)

    # NX-Jikkyo プロキシ
    if method == "GET" and path.startswith("/api/jikkyo/channels/"):
        jk_id = path.split("/")[-1]
        return proxy_jikkyo_channel(jk_id)

    return _error("Not found", 404)
