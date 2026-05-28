"""HLS 配信 (iOS Safari/AVPlayer 向け)

ライブは ffmpeg HLS muxer による持続セッション、録画は事前計算プレイリスト +
セグメント on-demand トランスコードで実装する。
"""
import hashlib
import os
import shutil
import subprocess
import threading
import time

HLS_TMP_DIR = "/tmp/autorec-hls"
HLS_LIVE_SEGMENT_DURATION = 2
HLS_VOD_SEGMENT_DURATION = 6
HLS_IDLE_TIMEOUT = 30          # ライブ: 最終アクセスから何秒で ffmpeg を畳むか
HLS_VOD_SESSION_TTL = 600      # VOD: パラメータキャッシュ保持時間
HLS_PLAYLIST_WAIT_TIMEOUT = 12 # 最初の m3u8 + セグメントを待つ秒数
HLS_VOD_MAX_CONCURRENT = 4     # 同時 VOD セグメント生成数

_live_sessions = {}
_live_lock = threading.Lock()

_vod_sessions = {}
_vod_lock = threading.Lock()

_vod_semaphore = threading.BoundedSemaphore(value=HLS_VOD_MAX_CONCURRENT)


def init(base_dir=None, idle_timeout=None, live_segment_duration=None,
         vod_segment_duration=None):
    """初期化。既存セッションディレクトリを掃除し、クリーンアップスレッドを起動。"""
    global HLS_TMP_DIR, HLS_IDLE_TIMEOUT, HLS_LIVE_SEGMENT_DURATION, HLS_VOD_SEGMENT_DURATION
    if base_dir:
        HLS_TMP_DIR = base_dir
    if idle_timeout:
        HLS_IDLE_TIMEOUT = int(idle_timeout)
    if live_segment_duration:
        HLS_LIVE_SEGMENT_DURATION = int(live_segment_duration)
    if vod_segment_duration:
        HLS_VOD_SEGMENT_DURATION = int(vod_segment_duration)
    os.makedirs(HLS_TMP_DIR, exist_ok=True)
    # 前回起動の残骸を掃除
    try:
        for name in os.listdir(HLS_TMP_DIR):
            p = os.path.join(HLS_TMP_DIR, name)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
    except FileNotFoundError:
        pass
    t = threading.Thread(target=_cleanup_loop, daemon=True, name="hls-cleanup")
    t.start()


def shutdown():
    """全セッションを停止 (サーバ終了時)。"""
    with _live_lock:
        sessions = list(_live_sessions.values())
        _live_sessions.clear()
    for s in sessions:
        try:
            s.stop()
        except Exception:
            pass


# --- ライブ HLS ---

def live_key(channel, params):
    """ライブセッションの一意キー。チャンネル + 主要パラメータから決定論的に算出。"""
    quality = (params.get("quality", [""])[0]) or "default"
    sid = (params.get("sid", [""])[0]) or "0"
    audio = (params.get("audio", [""])[0]) or "stereo"
    return f"{channel}_{quality}_{sid}_{audio}"


class HLSLiveSession:
    """1 セッション = recpt1 + ffmpeg HLS muxer。同一キーの複数 GET で共有する。"""

    def __init__(self, key, channel, channel_name, build_ffmpeg_cmd):
        self.key = key
        self.channel = channel
        self.channel_name = channel_name
        self.build_ffmpeg_cmd = build_ffmpeg_cmd  # callable(output_dir, playlist_path) -> List[str]
        self.dir = os.path.join(HLS_TMP_DIR, f"live-{key}")
        self.playlist_path = os.path.join(self.dir, "index.m3u8")
        self.recpt1 = None
        self.ffmpeg = None
        self.last_access = time.time()
        self.api_stream_id = None
        self.start_error = None

    def start(self, register_live_stream_fn):
        os.makedirs(self.dir, exist_ok=True)
        # デバッグ用に stderr をログファイルに残す (失敗時の原因特定用)
        recpt1_log = open(os.path.join(self.dir, "recpt1.log"), "wb")
        ffmpeg_log = open(os.path.join(self.dir, "ffmpeg.log"), "wb")
        self._recpt1_log = recpt1_log
        self._ffmpeg_log = ffmpeg_log
        try:
            self.recpt1 = subprocess.Popen(
                ["recpt1", "--b25", "--strip", self.channel, "-", "-"],
                stdout=subprocess.PIPE,
                stderr=recpt1_log,
            )
        except FileNotFoundError:
            self.start_error = "recpt1 not found"
            return False

        time.sleep(0.5)
        if self.recpt1.poll() is not None:
            try:
                recpt1_log.flush()
                with open(os.path.join(self.dir, "recpt1.log"), "rb") as f:
                    err = f.read()
            except OSError:
                err = b""
            self.start_error = f"recpt1 failed: {err.decode('utf-8', 'replace')[:200]}"
            return False

        cmd = self.build_ffmpeg_cmd(self.dir, self.playlist_path)
        try:
            self.ffmpeg = subprocess.Popen(
                cmd,
                stdin=self.recpt1.stdout,
                stdout=subprocess.DEVNULL,
                stderr=ffmpeg_log,
            )
        except FileNotFoundError:
            self.start_error = "ffmpeg not found"
            self._terminate_processes()
            return False
        # 親側で stdout を閉じて、ffmpeg 終了時にパイプ EOF が流れるようにする
        try:
            self.recpt1.stdout.close()
        except OSError:
            pass

        api_id = register_live_stream_fn(
            self.channel, self.channel_name, self.ffmpeg.pid, None,
            stop_event=None,
            recpt1_proc=self.recpt1,
            ffmpeg_proc=self.ffmpeg,
        )
        if api_id is None:
            self.start_error = "Max live streams reached"
            self._terminate_processes()
            return False
        self.api_stream_id = api_id
        return True

    def wait_for_playlist(self, timeout=None):
        """index.m3u8 が生成されて最初のセグメントが書かれるまで待機。"""
        deadline = time.time() + (timeout or HLS_PLAYLIST_WAIT_TIMEOUT)
        while time.time() < deadline:
            if self.ffmpeg and self.ffmpeg.poll() is not None:
                self.start_error = self._read_log_tail("ffmpeg.log")
                return False
            if self.recpt1 and self.recpt1.poll() is not None:
                self.start_error = self._read_log_tail("recpt1.log")
                return False
            try:
                with open(self.playlist_path) as f:
                    content = f.read()
                if "#EXTINF" in content:
                    return True
            except (FileNotFoundError, IOError):
                pass
            time.sleep(0.1)
        self.start_error = f"Playlist timeout (12s). ffmpeg.log tail: {self._read_log_tail('ffmpeg.log')}"
        return False

    def _read_log_tail(self, name, bytes_to_read=400):
        try:
            path = os.path.join(self.dir, name)
            with open(path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - bytes_to_read))
                return f.read().decode("utf-8", "replace").strip()
        except OSError:
            return ""

    def is_alive(self):
        return (
            self.ffmpeg is not None and self.ffmpeg.poll() is None
            and self.recpt1 is not None and self.recpt1.poll() is None
        )

    def touch(self):
        self.last_access = time.time()

    def read_playlist(self):
        try:
            with open(self.playlist_path) as f:
                return f.read()
        except (FileNotFoundError, IOError):
            return None

    def segment_path(self, name):
        # name は seg_XXXXX.ts 等。ディレクトリ越境を防ぐ。
        if "/" in name or ".." in name or not name:
            return None
        return os.path.join(self.dir, name)

    def stop(self):
        self._terminate_processes()
        if self.api_stream_id:
            try:
                import api as _api
                _api.unregister_live_stream(self.api_stream_id)
            except Exception:
                pass
            self.api_stream_id = None
        for handle_attr in ("_recpt1_log", "_ffmpeg_log"):
            handle = getattr(self, handle_attr, None)
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass
                setattr(self, handle_attr, None)
        try:
            shutil.rmtree(self.dir, ignore_errors=True)
        except OSError:
            pass

    def _terminate_processes(self):
        for proc in (self.ffmpeg, self.recpt1):
            if not proc:
                continue
            try:
                proc.terminate()
            except OSError:
                pass
        for proc in (self.ffmpeg, self.recpt1):
            if not proc:
                continue
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    proc.kill()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass


def get_or_create_live_session(channel, channel_name, params, build_ffmpeg_cmd,
                                register_live_stream_fn):
    """ライブセッション取得 (なければ起動)。戻り値: (session, error_message_or_None)"""
    key = live_key(channel, params)
    new_session = None
    with _live_lock:
        existing = _live_sessions.get(key)
        if existing and existing.is_alive():
            existing.touch()
            return existing, None
        if existing:
            # 死んだセッションを掃除
            del _live_sessions[key]
            try:
                existing.stop()
            except Exception:
                pass
        new_session = HLSLiveSession(key, channel, channel_name, build_ffmpeg_cmd)
        if not new_session.start(register_live_stream_fn):
            err = new_session.start_error or "Failed to start"
            try:
                new_session.stop()
            except Exception:
                pass
            return None, err
        _live_sessions[key] = new_session
    # 起動成功。ロック外で playlist を待つ (他キーの並行リクエストを止めないため)
    if not new_session.wait_for_playlist():
        err = new_session.start_error or "Playlist generation timeout"
        with _live_lock:
            _live_sessions.pop(key, None)
        try:
            new_session.stop()
        except Exception:
            pass
        return None, err
    return new_session, None


def get_live_session(key):
    with _live_lock:
        sess = _live_sessions.get(key)
        if sess and sess.is_alive():
            sess.touch()
            return sess
    return None


# --- VOD HLS ---

def vod_key(path, params):
    quality = (params.get("quality", [""])[0]) or "default"
    program = (params.get("program", [""])[0]) or "auto"
    audio = (params.get("audio", [""])[0]) or "stereo"
    raw = f"{path}|{quality}|{program}|{audio}|{HLS_VOD_SEGMENT_DURATION}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def register_vod_session(path, params, duration):
    """VOD のパラメータをキャッシュ。後続のセグメント要求で参照する。"""
    key = vod_key(path, params)
    with _vod_lock:
        _vod_sessions[key] = {
            "path": path,
            "params": dict(params),  # 浅いコピーで保持
            "duration": float(duration),
            "last_access": time.time(),
        }
    return key


def get_vod_session(key):
    with _vod_lock:
        sess = _vod_sessions.get(key)
        if sess:
            sess["last_access"] = time.time()
            return dict(sess)  # 呼び出し側変更防止
    return None


def build_vod_playlist(key, duration, segment_url_prefix):
    """全セグメントを列挙した静的 VOD m3u8 を返す。"""
    seg_dur = HLS_VOD_SEGMENT_DURATION
    num_full = int(duration // seg_dur)
    last_seg_dur = duration - num_full * seg_dur
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        f"#EXT-X-TARGETDURATION:{seg_dur + 1}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
    ]
    for i in range(num_full):
        lines.append(f"#EXTINF:{seg_dur}.0,")
        lines.append(f"{segment_url_prefix}/{key}/seg_{i:05d}.ts")
    if last_seg_dur >= 0.5:
        lines.append(f"#EXTINF:{last_seg_dur:.3f},")
        lines.append(f"{segment_url_prefix}/{key}/seg_{num_full:05d}.ts")
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def parse_segment_name(name):
    """seg_NNNNN.ts -> int(N)。不正なら None。"""
    if not name.startswith("seg_") or not name.endswith(".ts"):
        return None
    try:
        return int(name[4:-3])
    except ValueError:
        return None


def vod_segment_start_time(seg_num):
    return seg_num * HLS_VOD_SEGMENT_DURATION


def vod_semaphore():
    """セグメント生成の同時実行を制限するためのセマフォを返す。"""
    return _vod_semaphore


# --- 内部 ---

def _cleanup_loop():
    while True:
        time.sleep(5)
        _cleanup_live()
        _cleanup_vod()


def _cleanup_live():
    now = time.time()
    to_stop = []
    with _live_lock:
        for key in list(_live_sessions.keys()):
            sess = _live_sessions[key]
            if not sess.is_alive() or (now - sess.last_access) > HLS_IDLE_TIMEOUT:
                to_stop.append(sess)
                del _live_sessions[key]
    for sess in to_stop:
        try:
            sess.stop()
        except Exception:
            pass


def _cleanup_vod():
    now = time.time()
    with _vod_lock:
        for key in list(_vod_sessions.keys()):
            if now - _vod_sessions[key]["last_access"] > HLS_VOD_SESSION_TTL:
                del _vod_sessions[key]


def live_status():
    """デバッグ/モニタリング用: 稼働中ライブセッションの一覧"""
    with _live_lock:
        return [
            {
                "key": s.key,
                "channel": s.channel,
                "alive": s.is_alive(),
                "last_access_ago": time.time() - s.last_access,
                "api_stream_id": s.api_stream_id,
            }
            for s in _live_sessions.values()
        ]
