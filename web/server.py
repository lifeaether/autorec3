#!/usr/bin/env python3
"""autorec Web UI - Python 標準ライブラリのみの軽量HTTPサーバー"""
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

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
        else:
            # 静的ファイル配信
            if parsed.path == "/":
                self.path = "/index.html"
            super().do_GET()

    def end_headers(self):
        """静的ファイルに Cache-Control ヘッダを追加"""
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[web] サーバー停止")
        server.server_close()


if __name__ == "__main__":
    main()
