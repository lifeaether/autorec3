#!/usr/bin/env python3
"""autorec Web UI - Python 標準ライブラリのみの軽量HTTPサーバー"""
import os
import subprocess
import sys
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote, quote

# autorec ディレクトリをパスに追加
AUTOREC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(AUTOREC_DIR, "web"))

import api

STATIC_DIR = os.path.join(AUTOREC_DIR, "web", "static")

# conf からポートを読み込み
WEB_PORT = 8080
_conf_path = os.path.join(AUTOREC_DIR, "conf", "autorec.conf")
if os.path.exists(_conf_path):
    with open(_conf_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("WEB_PORT="):
                try:
                    WEB_PORT = int(line.split("=", 1)[1].strip().strip('"').strip("'"))
                except ValueError:
                    pass


class AutorecHandler(SimpleHTTPRequestHandler):
    """autorec HTTP リクエストハンドラ"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self._handle_api("GET", parsed)
        elif parsed.path.startswith("/recordings/"):
            self._serve_recording(parsed)
        elif parsed.path == "/live/stream":
            self._serve_live_stream(parsed)
        else:
            # 静的ファイル配信
            if parsed.path == "/":
                self.path = "/index.html"
            super().do_GET()

    def end_headers(self):
        """静的ファイルに Cache-Control ヘッダを追加"""
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/") and not parsed.path.startswith("/recordings/") and not parsed.path.startswith("/live/"):
            self.send_header("Cache-Control", "max-age=300")
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

        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Content-Length", content_length)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")

        if is_download:
            filename = os.path.basename(file_path)
            encoded_name = quote(filename)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded_name}")

        self.end_headers()

        # 64KB チャンクでストリーミング
        chunk_size = 65536
        try:
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    read_size = min(chunk_size, remaining)
                    data = f.read(read_size)
                    if not data:
                        break
                    self.wfile.write(data)
                    remaining -= len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

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
        try:
            ffmpeg = subprocess.Popen(
                [
                    "ffmpeg",
                    "-hide_banner", "-loglevel", "error",
                    "-analyzeduration", "500000",
                    "-probesize", "1000000",
                    "-fflags", "+nobuffer",
                    "-i", "pipe:0",
                    "-c:v", "libx264", "-preset", "ultrafast",
                    "-tune", "zerolatency",
                    "-c:a", "aac", "-b:a", "128k",
                    "-f", "mpegts",
                    "-mpegts_flags", "+resend_headers",
                    "pipe:1",
                ],
                stdin=recpt1.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            recpt1.terminate()
            recpt1.wait()
            self.send_error(503, "ffmpeg not found (live playback requires ffmpeg for transcoding)")
            return

        # recpt1 stdout を親プロセスから閉じる (pipe 連携用)
        recpt1.stdout.close()

        # ストリーム登録 (上限チェック)
        stream_id = api.register_live_stream(ch, channel_name, recpt1.pid)
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
            api.unregister_live_stream(stream_id)

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

    server = ThreadingHTTPServer(("0.0.0.0", port), AutorecHandler)
    print(f"[web] autorec Web UI 起動: http://0.0.0.0:{port}")
    print(f"[web] 静的ファイル: {STATIC_DIR}")
    print(f"[web] EPG DB: {api.EPG_DB}")
    print(f"[web] 管理 DB: {api.AUTOREC_DB}")
    print(f"[web] 録画先: {api.RECORD_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[web] サーバー停止")
        server.server_close()


if __name__ == "__main__":
    main()
