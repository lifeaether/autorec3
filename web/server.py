#!/usr/bin/env python3
"""autorec Web UI - Python 標準ライブラリのみの軽量HTTPサーバー"""
import os
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote, quote

# autorec ディレクトリをパスに追加
AUTOREC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(AUTOREC_DIR, "web"))

import sqlite3
import api
import hls

STATIC_DIR = os.path.join(AUTOREC_DIR, "web", "static")

QUALITY_PRESETS = {
    "original": {
        "video": [
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-b:v", "12000k", "-maxrate", "15000k", "-bufsize", "20000k",
        ],
        "audio": ["-c:a", "aac", "-b:a", "320k", "-ac", "2"],
    },
    "high": {
        "video": [
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-b:v", "6000k", "-maxrate", "8000k", "-bufsize", "12000k",
        ],
        "audio": ["-c:a", "aac", "-b:a", "256k", "-ac", "2"],
    },
    "medium": {
        "video": [
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-b:v", "800k", "-maxrate", "900k", "-bufsize", "1200k",
            "-vf", "scale=640:-2",
        ],
        "audio": ["-c:a", "aac", "-b:a", "128k", "-ac", "2"],
    },
    "low": {
        "video": [
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-b:v", "250k", "-maxrate", "300k", "-bufsize", "600k",
            "-bf", "0",
            "-vf", "scale=360:-2",
        ],
        "audio": ["-c:a", "aac", "-b:a", "32k", "-ac", "2"],
    },
}

# 録画ファイル再生用プリセット: 低遅延要件がないため zerolatency を外し、
# B フレーム/ルックアヘッドを有効化して同ビットレートでの画質を底上げする。
RECORDING_QUALITY_PRESETS = {
    "original": {
        "video": [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-maxrate", "15000k", "-bufsize", "25000k",
            "-g", "120", "-keyint_min", "30",
        ],
        "audio": ["-c:a", "aac", "-b:a", "320k", "-ac", "2"],
    },
    "high": {
        "video": [
            "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", "6000k", "-maxrate", "8000k", "-bufsize", "12000k",
            "-g", "120", "-keyint_min", "30",
        ],
        "audio": ["-c:a", "aac", "-b:a", "256k", "-ac", "2"],
    },
    "medium": QUALITY_PRESETS["medium"],
    "low": QUALITY_PRESETS["low"],
}

DEFAULT_QUALITY = "high"


def _audio_filter(params):
    """audio クエリパラメータに応じて -af の引数を組み立てる。
    NHK のデュアルモノラル送出 (L=主音声 / R=副音声/解説) を分離して聞くため。
    """
    base = "aresample=async=1000:first_pts=0"
    mode = params.get("audio", [""])[0]
    if mode == "main":
        return f"pan=stereo|c0=c0|c1=c0,{base}"
    if mode == "sub":
        return f"pan=stereo|c0=c1|c1=c1,{base}"
    return base


def _build_program_map_args(file_path, params):
    """ffmpeg の -map 引数を組み立てる。

    クエリ program=<id> 指定時はそれを優先。未指定時は ffprobe で
    最大解像度の program を自動選択。判定不能なら従来挙動 (0:v:0/0:a:0)。
    """
    program = params.get("program", [""])[0]
    if program:
        try:
            pid = int(program)
        except ValueError:
            pid = None
        if pid is not None:
            return ["-map", f"0:p:{pid}:v:0?", "-map", f"0:p:{pid}:a:0?"]
    auto = api._select_main_program(file_path)
    if auto is not None:
        return ["-map", f"0:p:{auto}:v:0?", "-map", f"0:p:{auto}:a:0?"]
    return ["-map", "0:v:0", "-map", "0:a:0"]


def _relay_thread(recpt1_stdout, ffmpeg_write_fd, rec_ref, stop_event):
    """recpt1 stdout → ffmpeg stdin に転送しつつ、録画時はファイルにも書き出す"""
    CHUNK = 188 * 64  # TSパケット境界に揃えた 12032 bytes
    try:
        while not stop_event.is_set():
            data = recpt1_stdout.read(CHUNK)
            if not data:
                break
            try:
                os.write(ffmpeg_write_fd, data)
            except OSError:
                break
            f = rec_ref.get("file")
            if f is not None:
                try:
                    f.write(data)
                except Exception:
                    rec_ref["file"] = None
                    rec_ref["path"] = None
    finally:
        try:
            os.close(ffmpeg_write_fd)
        except OSError:
            pass
        f = rec_ref.get("file")
        if f is not None:
            try:
                f.close()
            except OSError:
                pass
            rec_ref["file"] = None


# conf からポートと HLS 設定を読み込み
WEB_PORT = 8080
HLS_TMP_DIR = "/tmp/autorec-hls"
HLS_IDLE_TIMEOUT = 30
HLS_LIVE_SEGMENT_DURATION = 2
HLS_VOD_SEGMENT_DURATION = 6
_conf_path = os.path.join(AUTOREC_DIR, "conf", "autorec.conf")
if os.path.exists(_conf_path):
    with open(_conf_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            val = val.strip().strip('"').strip("'")
            key = key.strip()
            if key == "WEB_PORT":
                try:
                    WEB_PORT = int(val)
                except ValueError:
                    pass
            elif key == "HLS_TMP_DIR" and val:
                HLS_TMP_DIR = val
            elif key == "HLS_IDLE_TIMEOUT" and val:
                try:
                    HLS_IDLE_TIMEOUT = int(val)
                except ValueError:
                    pass
            elif key == "HLS_LIVE_SEGMENT_DURATION" and val:
                try:
                    HLS_LIVE_SEGMENT_DURATION = int(val)
                except ValueError:
                    pass
            elif key == "HLS_VOD_SEGMENT_DURATION" and val:
                try:
                    HLS_VOD_SEGMENT_DURATION = int(val)
                except ValueError:
                    pass


class AutorecHandler(SimpleHTTPRequestHandler):
    """autorec HTTP リクエストハンドラ"""
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def _get_quality_args(self, params, presets=None):
        presets = presets or QUALITY_PRESETS
        quality = params.get("quality", [DEFAULT_QUALITY])[0]
        preset = presets.get(quality, presets[DEFAULT_QUALITY])
        return preset["video"] + preset["audio"]

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api("GET", parsed)
        elif parsed.path == "/recordings/transcode":
            self._serve_recording_transcode(parsed)
        elif parsed.path == "/recordings/live":
            self._serve_recording_live(parsed)
        elif parsed.path.startswith("/recordings/"):
            self._serve_recording(parsed)
        elif parsed.path == "/live/stream":
            self._serve_live_stream(parsed)
        elif parsed.path == "/hls/live":
            self._serve_hls_live_playlist(parsed)
        elif parsed.path.startswith("/hls/live/seg/"):
            self._serve_hls_live_segment(parsed)
        elif parsed.path == "/hls/recording":
            self._serve_hls_recording_playlist(parsed)
        elif parsed.path.startswith("/hls/recording/seg/"):
            self._serve_hls_recording_segment(parsed)
        else:
            # 静的ファイル配信
            if parsed.path == "/":
                self.path = "/index.html"
            super().do_GET()

    def end_headers(self):
        """静的ファイルに Cache-Control ヘッダを追加"""
        parsed = urlparse(self.path)
        if (not parsed.path.startswith("/api/")
                and not parsed.path.startswith("/recordings/")
                and not parsed.path.startswith("/live/")
                and not parsed.path.startswith("/hls/")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api("POST", parsed)
        else:
            self.send_error(404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api("PUT", parsed)
        else:
            self.send_error(404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api("DELETE", parsed)
        else:
            self.send_error(404)

    def _handle_api(self, method, parsed):
        """API リクエスト処理"""
        params = parse_qs(parsed.query)
        body = b""
        if method in ("POST", "PUT"):
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                body = self.rfile.read(content_length)

        try:
            status, content_type, response_body = api.handle_request(
                method, parsed.path, params, body
            )
        except Exception as e:
            status = 500
            content_type = "application/json"
            import json
            response_body = json.dumps({"error": str(e)}).encode("utf-8")

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", len(response_body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(response_body)

    def _serve_recording(self, parsed):
        """録画ファイル配信 (Range リクエスト対応)"""
        # パスをデコードして RECORD_DIR 配下のファイルパスを構築
        rel_path = unquote(parsed.path[len("/recordings/"):])
        file_path = os.path.realpath(os.path.join(api.RECORD_DIR, rel_path))

        # パストラバーサル防止
        record_dir_real = os.path.realpath(api.RECORD_DIR)
        if not file_path.startswith(record_dir_real + os.sep) and file_path != record_dir_real:
            self.send_error(403, "Forbidden")
            return

        if not os.path.isfile(file_path):
            self.send_error(404, "Not Found")
            return

        file_size = os.path.getsize(file_path)
        params = parse_qs(parsed.query)
        is_download = params.get("download", [""])[0] == "1"

        # Range ヘッダ処理
        range_header = self.headers.get("Range")
        start = 0
        end = file_size - 1

        if range_header and range_header.startswith("bytes="):
            try:
                byte_range = range_header[6:].split(",")[0].strip()
                if byte_range.startswith("-"):
                    # 末尾からの指定
                    suffix_len = int(byte_range[1:])
                    start = max(0, file_size - suffix_len)
                elif byte_range.endswith("-"):
                    start = int(byte_range[:-1])
                else:
                    parts = byte_range.split("-")
                    start = int(parts[0])
                    end = int(parts[1])
            except (ValueError, IndexError):
                self.send_error(416, "Range Not Satisfiable")
                return

            if start > end or start >= file_size:
                self.send_error(416, "Range Not Satisfiable")
                return
            end = min(end, file_size - 1)
            content_length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        else:
            content_length = file_size
            self.send_response(200)

        if file_path.endswith('.nicojk'):
            content_type = "application/x-ndjson"
        else:
            content_type = "video/mp2t"
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", content_length)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")

        if is_download:
            filename = os.path.basename(file_path)
            encoded_name = quote(filename)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded_name}")

        self.end_headers()

        # os.sendfile() でゼロコピー転送 (カーネル内で直接 disk→socket)
        try:
            with open(file_path, "rb") as f:
                self.wfile.flush()
                out_fd = self.wfile.fileno()
                in_fd = f.fileno()
                offset = start
                remaining = content_length
                while remaining > 0:
                    sent = os.sendfile(out_fd, in_fd, offset, min(remaining, 16777216))
                    if sent == 0:
                        break
                    offset += sent
                    remaining -= sent
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _serve_recording_transcode(self, parsed):
        """録画ファイルをトランスコードして配信 (MPEG-2 → H.264 for MSE)"""
        params = parse_qs(parsed.query)
        rel_path = params.get("path", [""])[0]
        if not rel_path:
            self.send_error(400, "path parameter is required")
            return

        file_path = os.path.realpath(os.path.join(api.RECORD_DIR, rel_path))

        # パストラバーサル防止
        record_dir_real = os.path.realpath(api.RECORD_DIR)
        if not file_path.startswith(record_dir_real + os.sep) and file_path != record_dir_real:
            self.send_error(403, "Forbidden")
            return

        if not os.path.isfile(file_path):
            self.send_error(404, "Not Found")
            return

        # シークパラメータ
        ss = params.get("ss", [""])[0]
        if ss:
            try:
                float(ss)
            except ValueError:
                self.send_error(400, "Invalid ss parameter")
                return

        cmd = [
            "ffmpeg",
            "-hide_banner", "-loglevel", "error",
            "-analyzeduration", "500000", "-probesize", "1000000",
            "-fflags", "+nobuffer+discardcorrupt+genpts",
            "-err_detect", "ignore_err",
        ]
        if ss:
            cmd += ["-ss", ss]
        cmd += ["-i", file_path] + _build_program_map_args(file_path, params)
        quality_args = self._get_quality_args(params, RECORDING_QUALITY_PRESETS)
        cmd += quality_args + [
            "-af", _audio_filter(params),
            "-vsync", "cfr",
            "-f", "mpegts",
            "-mpegts_flags", "+resend_headers+pat_pmt_at_frames",
            "-flush_packets", "1",
            "pipe:1",
        ]

        try:
            ffmpeg = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            self.send_error(503, "ffmpeg not found (playback requires ffmpeg for transcoding)")
            return

        try:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Connection", "close")
            self.end_headers()

            while True:
                data = ffmpeg.stdout.read(65536)
                if not data:
                    break
                self.wfile.write(data)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            ffmpeg.terminate()
            try:
                ffmpeg.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ffmpeg.kill()
                ffmpeg.wait()

    def _serve_recording_live(self, parsed):
        """録画中ファイルをライブ配信 (tail -f → ffmpeg → HTTP)

        schedule から命名規則で期待ファイルパスを計算し、ファイル存在 + mtime で
        「録画中」を判定する (status カラムには依存しない)。
        """
        params = parse_qs(parsed.query)
        schedule_id = params.get("schedule_id", [""])[0]
        if not schedule_id:
            self.send_error(400, "schedule_id parameter is required")
            return

        autorec_db = os.path.join(AUTOREC_DIR, "db", "autorec.sqlite")
        try:
            conn = sqlite3.connect(autorec_db)
            conn.execute("PRAGMA busy_timeout=5000")
            row = conn.execute(
                """SELECT s.channel, s.title, s.start_time, COALESCE(r.name, '') as rule_name
                   FROM schedule s LEFT JOIN rule r ON s.rule_id = r.id
                   WHERE s.id = ?""",
                (schedule_id,),
            ).fetchone()
            conn.close()
        except Exception:
            self.send_error(500, "Database error")
            return

        if not row:
            self.send_error(404, "Schedule not found")
            return

        from recording_path import expected_output_path
        file_path = expected_output_path(row[3], row[0], row[1], row[2], api.RECORD_DIR)
        if not os.path.isfile(file_path):
            self.send_error(404, "Recording file not found")
            return
        # 録画中判定: mtime が直近 (api.RECORDING_MTIME_THRESHOLD 秒以内)
        if (time.time() - os.path.getmtime(file_path)) >= api.RECORDING_MTIME_THRESHOLD:
            self.send_error(404, "Recording not active")
            return

        quality_args = self._get_quality_args(params)

        # tail -f で成長中のファイルの末尾付近から追従 (約10秒分 ≒ 20MB)
        tail_cmd = ["tail", "-c", "20000000", "-f", file_path]
        # program 自動選択は録画ファイルの先頭から ffprobe する (tail とは独立)
        map_args = _build_program_map_args(file_path, params)
        ffmpeg_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-analyzeduration", "500000", "-probesize", "1000000",
            "-fflags", "+nobuffer+discardcorrupt+genpts",
            "-err_detect", "ignore_err",
            "-f", "mpegts", "-i", "pipe:0",
        ] + map_args + quality_args + [
            "-af", _audio_filter(params),
            "-vsync", "cfr",
            "-f", "mpegts",
            "-mpegts_flags", "+resend_headers+pat_pmt_at_frames",
            "-flush_packets", "1",
            "pipe:1",
        ]

        try:
            tail = subprocess.Popen(tail_cmd, stdout=subprocess.PIPE)
            ffmpeg = subprocess.Popen(
                ffmpeg_cmd,
                stdin=tail.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            tail.stdout.close()  # ffmpeg が直接読む
        except FileNotFoundError:
            self.send_error(503, "ffmpeg or tail not found")
            return

        try:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Connection", "close")
            self.end_headers()

            while True:
                data = ffmpeg.stdout.read(65536)
                if not data:
                    break
                self.wfile.write(data)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            ffmpeg.terminate()
            tail.terminate()
            try:
                ffmpeg.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ffmpeg.kill()
                ffmpeg.wait()
            try:
                tail.wait(timeout=5)
            except subprocess.TimeoutExpired:
                tail.kill()
                tail.wait()

    def _serve_live_stream(self, parsed):
        """ライブTV ストリーム配信 (recpt1 → ffmpeg → HTTP)"""
        params = parse_qs(parsed.query)
        ch = params.get("ch", [""])[0]
        if not ch:
            self.send_error(400, "ch parameter is required")
            return

        valid_channels = api._get_valid_channels()
        if ch not in valid_channels:
            self.send_error(400, f"Invalid channel: {ch}")
            return

        channel_name = valid_channels[ch]

        # recpt1 起動
        try:
            recpt1 = subprocess.Popen(
                ["recpt1", "--b25", "--strip", ch, "-", "-"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            self.send_error(503, "recpt1 not found")
            return

        # 0.5秒待って起動エラー検出
        time.sleep(0.5)
        if recpt1.poll() is not None:
            stderr_out = recpt1.stderr.read().decode("utf-8", errors="replace")
            self.send_error(503, f"recpt1 failed to start: {stderr_out[:200]}")
            return

        # ffmpeg でトランスコード (MPEG-2 → H.264, ブラウザ MSE 互換)
        quality_args = self._get_quality_args(params)
        sid = params.get("sid", [""])[0]
        if sid:
            map_args = ["-map", f"0:p:{sid}:v:0?", "-map", f"0:p:{sid}:a:0?"]
        else:
            # -map を指定しない: ffmpeg の自動ストリーム選択に任せることで
            # 番組切り替わり時の PMT 変更 (音声PID/構成変更) に追従できる
            map_args = []
        ffmpeg_cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-analyzeduration", "500000", "-probesize", "1000000",
            "-fflags", "+nobuffer+discardcorrupt+genpts",
            "-err_detect", "ignore_err",
            "-i", "pipe:0",
        ] + map_args + quality_args + [
            "-af", _audio_filter(params),
            "-vsync", "cfr",
            "-f", "mpegts",
            "-mpegts_flags", "+resend_headers+pat_pmt_at_frames",
            "-flush_packets", "1",
            "pipe:1",
        ]
        r_fd, w_fd = os.pipe()
        try:
            ffmpeg = subprocess.Popen(
                ffmpeg_cmd,
                stdin=r_fd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            os.close(r_fd)
            os.close(w_fd)
            recpt1.terminate()
            recpt1.wait()
            self.send_error(503, "ffmpeg not found (live playback requires ffmpeg for transcoding)")
            return
        os.close(r_fd)

        rec_ref = {"file": None, "path": None}
        stop_event = threading.Event()
        relay = threading.Thread(
            target=_relay_thread,
            args=(recpt1.stdout, w_fd, rec_ref, stop_event),
            daemon=True,
        )
        relay.start()

        # ストリーム登録 (上限チェック)
        stream_id = api.register_live_stream(
            ch, channel_name, recpt1.pid, rec_ref,
            stop_event=stop_event, recpt1_proc=recpt1, ffmpeg_proc=ffmpeg,
        )
        if stream_id is None:
            recpt1.terminate()
            ffmpeg.terminate()
            try:
                ffmpeg.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ffmpeg.kill()
            try:
                recpt1.wait(timeout=5)
            except subprocess.TimeoutExpired:
                recpt1.kill()
            self.send_error(503, "Max live streams reached")
            return

        try:
            # レスポンスヘッダ送信 (Content-Length なし → 接続終了で完了)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp2t")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Connection", "close")
            self.end_headers()

            # ffmpeg 出力をクライアントにストリーミング
            while True:
                data = ffmpeg.stdout.read(65536)
                if not data:
                    break
                self.wfile.write(data)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            # クライアント切断
            pass
        finally:
            stop_event.set()
            # 録画ファイルのクローズ
            f = rec_ref.get("file")
            if f is not None:
                try:
                    f.close()
                except OSError:
                    pass
                rec_ref["file"] = None
            # jikkyo-rec.py の停止
            jikkyo_proc = rec_ref.get("jikkyo_proc")
            if jikkyo_proc:
                jikkyo_proc.terminate()
                try:
                    jikkyo_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    jikkyo_proc.kill()
                rec_ref["jikkyo_proc"] = None
            # recpt1 と ffmpeg を終了
            recpt1.terminate()
            ffmpeg.terminate()
            try:
                ffmpeg.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ffmpeg.kill()
                ffmpeg.wait()
            try:
                recpt1.wait(timeout=5)
            except subprocess.TimeoutExpired:
                recpt1.kill()
                recpt1.wait()
            relay.join(timeout=5)
            api.unregister_live_stream(stream_id)

    # ---- HLS (iOS/AVPlayer 向け) ----

    def _build_hls_live_cmd(self, params, output_dir, playlist_path, base_url):
        """ライブ HLS の ffmpeg コマンドを組み立てる。"""
        sid = params.get("sid", [""])[0]
        if sid:
            map_args = ["-map", f"0:p:{sid}:v:0?", "-map", f"0:p:{sid}:a:0?"]
        else:
            map_args = []
        quality_args = self._get_quality_args(params, QUALITY_PRESETS)
        return [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-analyzeduration", "500000", "-probesize", "1000000",
            "-fflags", "+nobuffer+discardcorrupt+genpts",
            "-err_detect", "ignore_err",
            "-i", "pipe:0",
        ] + map_args + quality_args + [
            "-af", _audio_filter(params),
            # ARIB 字幕 (地上波 CC) は ffmpeg の HLS muxer がエンコードできず Error binding
            # するため明示的に捨てる。データ stream も同様に無視。
            "-sn", "-dn",
            "-vsync", "cfr",
            "-f", "hls",
            "-hls_time", str(HLS_LIVE_SEGMENT_DURATION),
            "-hls_list_size", "6",
            "-hls_flags",
            "delete_segments+independent_segments+omit_endlist+program_date_time",
            "-hls_segment_type", "mpegts",
            "-hls_segment_filename", os.path.join(output_dir, "seg_%05d.ts"),
            "-hls_allow_cache", "0",
            "-hls_base_url", base_url,
            playlist_path,
        ]

    def _serve_hls_live_playlist(self, parsed):
        """GET /hls/live?ch=27&quality=high&...  →  m3u8"""
        params = parse_qs(parsed.query)
        ch = params.get("ch", [""])[0]
        if not ch:
            self._serve_plain_error(400, "ch parameter is required")
            return
        valid_channels = api._get_valid_channels()
        if ch not in valid_channels:
            self._serve_plain_error(400, f"Invalid channel: {ch}")
            return

        channel_name = valid_channels[ch]
        key = hls.live_key(ch, params)
        base_url = f"/hls/live/seg/{key}/"

        def cmd_builder(output_dir, playlist_path):
            return self._build_hls_live_cmd(params, output_dir, playlist_path, base_url)

        session, err = hls.get_or_create_live_session(
            ch, channel_name, params, cmd_builder, api.register_live_stream,
        )
        if session is None:
            self._serve_plain_error(503, err or "Failed to start HLS session")
            return

        playlist = session.read_playlist()
        if playlist is None:
            self.send_error(503, "Playlist not ready")
            return

        body = playlist.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _serve_hls_live_segment(self, parsed):
        """GET /hls/live/seg/<key>/<seg_xxxxx.ts>  →  ライブ HLS セグメント"""
        rest = parsed.path[len("/hls/live/seg/"):]
        parts = rest.split("/", 1)
        if len(parts) != 2:
            self.send_error(404)
            return
        key, name = parts[0], parts[1]
        session = hls.get_live_session(key)
        if session is None:
            self.send_error(404, "Session not found or expired")
            return
        seg_path = session.segment_path(name)
        if not seg_path or not os.path.isfile(seg_path):
            self.send_error(404, "Segment not found")
            return
        try:
            size = os.path.getsize(seg_path)
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Content-Length", str(size))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.end_headers()
        try:
            with open(seg_path, "rb") as f:
                out_fd = self.wfile.fileno()
                in_fd = f.fileno()
                offset = 0
                remaining = size
                while remaining > 0:
                    sent = os.sendfile(out_fd, in_fd, offset, min(remaining, 4 * 1024 * 1024))
                    if sent == 0:
                        break
                    offset += sent
                    remaining -= sent
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _serve_hls_recording_playlist(self, parsed):
        """GET /hls/recording?path=...  →  事前計算した VOD m3u8"""
        params = parse_qs(parsed.query)
        rel_path = params.get("path", [""])[0]
        if not rel_path:
            self.send_error(400, "path parameter is required")
            return
        file_path = os.path.realpath(os.path.join(api.RECORD_DIR, rel_path))
        record_dir_real = os.path.realpath(api.RECORD_DIR)
        if not file_path.startswith(record_dir_real + os.sep) and file_path != record_dir_real:
            self.send_error(403, "Forbidden")
            return
        if not os.path.isfile(file_path):
            self.send_error(404, "Not Found")
            return
        # ffprobe で duration を取得
        try:
            result = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", file_path],
                capture_output=True, text=True, timeout=10,
            )
            duration = float(result.stdout.strip())
        except (FileNotFoundError, ValueError, subprocess.TimeoutExpired):
            self.send_error(500, "Could not determine duration")
            return
        if duration <= 0:
            self.send_error(500, "Invalid duration")
            return

        key = hls.register_vod_session(file_path, params, duration)
        playlist = hls.build_vod_playlist(key, duration, "/hls/recording/seg")
        body = playlist.encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.apple.mpegurl")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def _serve_hls_recording_segment(self, parsed):
        """GET /hls/recording/seg/<key>/seg_<N>.ts  →  ffmpeg で 1 セグメント生成"""
        rest = parsed.path[len("/hls/recording/seg/"):]
        parts = rest.split("/", 1)
        if len(parts) != 2:
            self.send_error(404)
            return
        key, name = parts[0], parts[1]
        seg_num = hls.parse_segment_name(name)
        if seg_num is None:
            self.send_error(404, "Invalid segment name")
            return
        session = hls.get_vod_session(key)
        if session is None:
            self.send_error(404, "Session not found or expired")
            return

        file_path = session["path"]
        params = session["params"]
        duration = session["duration"]
        seg_dur = hls.HLS_VOD_SEGMENT_DURATION
        start = seg_num * seg_dur
        if start >= duration:
            self.send_error(416, "Segment out of range")
            return
        seg_len = min(seg_dur, duration - start)

        if not os.path.isfile(file_path):
            self.send_error(404, "Source not found")
            return

        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}",
            "-i", file_path,
            "-t", f"{seg_len:.3f}",
        ] + _build_program_map_args(file_path, params) \
          + self._get_quality_args(params, RECORDING_QUALITY_PRESETS) + [
            "-af", _audio_filter(params),
            # NHK ニュース等で arib_caption / data stream が含まれるとセグメント生成が
            # 失敗するため除外する。
            "-sn", "-dn",
            "-vsync", "cfr",
            "-output_ts_offset", f"{start:.3f}",
            "-f", "mpegts",
            "-mpegts_flags", "+resend_headers+pat_pmt_at_frames",
            "-flush_packets", "1",
            "pipe:1",
        ]

        sem = hls.vod_semaphore()
        if not sem.acquire(timeout=15):
            self.send_error(503, "Too many concurrent segments")
            return
        # ffmpeg stderr を捨てずにセッションごとのログに残す (失敗番組の調査用)。
        log_dir = os.path.join(HLS_TMP_DIR, f"vod-{key}")
        try:
            os.makedirs(log_dir, exist_ok=True)
        except OSError:
            pass
        log_path = os.path.join(log_dir, f"seg_{seg_num:05d}.log")
        try:
            stderr_handle = open(log_path, "wb")
        except OSError:
            stderr_handle = subprocess.DEVNULL
        try:
            try:
                ffmpeg = subprocess.Popen(
                    cmd, stdout=subprocess.PIPE, stderr=stderr_handle,
                )
            except FileNotFoundError:
                self.send_error(503, "ffmpeg not found")
                return
            try:
                self.send_response(200)
                self.send_header("Content-Type", "video/mp2t")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-cache, no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                while True:
                    data = ffmpeg.stdout.read(65536)
                    if not data:
                        break
                    self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                ffmpeg.terminate()
                try:
                    ffmpeg.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    ffmpeg.kill()
                    ffmpeg.wait()
        finally:
            if stderr_handle is not subprocess.DEVNULL:
                try:
                    stderr_handle.close()
                except OSError:
                    pass
            sem.release()

    def _serve_plain_error(self, status, message):
        """send_error は status line に message を入れるため改行/長文で HTTP が壊れる。
        ここでは plaintext 本文として返し、ステータス行は短い理由語に固定する。"""
        body = (message or "").encode("utf-8", "replace")
        reasons = {400: "Bad Request", 404: "Not Found", 503: "Service Unavailable",
                   416: "Range Not Satisfiable"}
        self.send_response(status, reasons.get(status, "Error"))
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_OPTIONS(self):
        """CORS プリフライト対応"""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        """ログ出力"""
        sys.stderr.write("[web] %s - %s\n" % (self.address_string(), format % args))


def main():
    port = WEB_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    hls.init(
        base_dir=HLS_TMP_DIR,
        idle_timeout=HLS_IDLE_TIMEOUT,
        live_segment_duration=HLS_LIVE_SEGMENT_DURATION,
        vod_segment_duration=HLS_VOD_SEGMENT_DURATION,
    )

    server = ThreadingHTTPServer(("0.0.0.0", port), AutorecHandler)
    print(f"[web] autorec Web UI 起動: http://0.0.0.0:{port}")
    print(f"[web] 静的ファイル: {STATIC_DIR}")
    print(f"[web] EPG DB: {api.EPG_DB}")
    print(f"[web] 管理 DB: {api.AUTOREC_DB}")
    print(f"[web] 録画先: {api.RECORD_DIR}")
    print(f"[web] HLS tmp: {HLS_TMP_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[web] サーバー停止")
        hls.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
