#!/usr/bin/env python3
"""NX-Jikkyo 実況コメント録画スクリプト

Usage: python3 jikkyo-rec.py <jk_id> <duration_seconds> <output_file>

NX-Jikkyo WebSocket から実況コメントを受信し、JSONL 形式で保存する。
Python 標準ライブラリのみ使用。いかなるエラーでも exit 0 で終了し、
録画処理に影響を与えない。
"""

import base64
import hashlib
import json
import os
import select
import signal
import socket
import ssl
import struct
import sys
import time
import urllib.parse

JIKKYO_HOST = 'nx-jikkyo.tsukumijima.net'

# --- WebSocket helpers ---

def _recv_exact(sock, n):
    """ソケットから正確に n バイト読む (非ブロッキング対応)"""
    buf = b''
    while len(buf) < n:
        try:
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError('connection closed')
            buf += chunk
        except (BlockingIOError, ssl.SSLWantReadError):
            # 非ブロッキングソケットでデータ未到着 — 待機して再試行
            select.select([sock], [], [], 5.0)
    return buf


def _ws_connect(host, path):
    """WebSocket 接続 (HTTP Upgrade + SSL ハンドシェイク)"""
    ctx = ssl.create_default_context()
    raw = socket.create_connection((host, 443), timeout=10)
    sock = ctx.wrap_socket(raw, server_hostname=host)

    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f'GET {path} HTTP/1.1\r\n'
        f'Host: {host}\r\n'
        f'Upgrade: websocket\r\n'
        f'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\n'
        f'Sec-WebSocket-Version: 13\r\n'
        f'\r\n'
    )
    sock.sendall(req.encode())

    # レスポンスヘッダー読み取り
    resp = b''
    while b'\r\n\r\n' not in resp:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError('handshake failed: no response')
        resp += chunk

    status_line = resp.split(b'\r\n', 1)[0].decode()
    if '101' not in status_line:
        raise ConnectionError(f'handshake failed: {status_line}')

    sock.setblocking(False)
    return sock


def _ws_recv(sock):
    """1 WebSocket フレーム受信 → (opcode, payload_bytes)"""
    # フレームヘッダ 2 バイト
    header = _recv_exact(sock, 2)
    opcode = header[0] & 0x0F
    masked = (header[1] & 0x80) != 0
    length = header[1] & 0x7F

    if length == 126:
        length = struct.unpack('!H', _recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack('!Q', _recv_exact(sock, 8))[0]

    if masked:
        mask = _recv_exact(sock, 4)

    payload = _recv_exact(sock, length)

    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

    return opcode, payload


def _ws_send(sock, data, op=0x1):
    """マスク付き WebSocket フレーム送信"""
    if isinstance(data, str):
        data = data.encode('utf-8')

    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))

    frame = bytearray()
    frame.append(0x80 | op)  # FIN + opcode

    length = len(data)
    if length < 126:
        frame.append(0x80 | length)  # MASK bit + length
    elif length < 65536:
        frame.append(0x80 | 126)
        frame.extend(struct.pack('!H', length))
    else:
        frame.append(0x80 | 127)
        frame.extend(struct.pack('!Q', length))

    frame.extend(mask)
    frame.extend(masked)
    sock.sendall(bytes(frame))


# --- Recorder ---

class JikkyoRecorder:
    def __init__(self, jk_id, duration, output_path):
        self.jk_id = jk_id
        self.duration = duration
        self.output_path = output_path
        self.watch_sock = None
        self.comment_sock = None
        self.outfile = None
        self.keep_interval = 30
        self.last_keep_seat = 0
        self.thread_id = None
        self.your_post_key = ''
        self.running = True

        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)

    def _on_signal(self, signum, frame):
        self.running = False

    def _log(self, msg):
        print(f'[jikkyo-rec] {msg}', file=sys.stderr, flush=True)

    def run(self):
        self.outfile = open(self.output_path, 'w', encoding='utf-8')
        try:
            self._connect_watch()
            self._main_loop()
        finally:
            self._close_all()

    def _connect_watch(self):
        path = f'/api/v1/channels/{self.jk_id}/ws/watch'
        self._log(f'watch WS connecting: wss://{JIKKYO_HOST}{path}')
        self.watch_sock = _ws_connect(JIKKYO_HOST, path)
        _ws_send(self.watch_sock, json.dumps({'type': 'startWatching', 'data': {}}))
        self.last_keep_seat = time.monotonic()
        self._log('watch WS connected, startWatching sent')

    def _connect_comment_ws(self):
        """room 受信後にコメント WS 接続・サブスクリプション送信"""
        if not self.thread_id:
            return

        # デフォルトコメント WS URL
        comment_url = f'wss://{JIKKYO_HOST}/api/v1/channels/{self.jk_id}/ws/comment'
        if hasattr(self, '_comment_ws_uri') and self._comment_ws_uri:
            comment_url = self._comment_ws_uri

        parsed = urllib.parse.urlparse(comment_url)
        host = parsed.hostname
        path = parsed.path
        if parsed.query:
            path += '?' + parsed.query

        self._log(f'comment WS connecting: {comment_url}')
        self.comment_sock = _ws_connect(host, path)

        # niwavided protocol: サブスクリプション配列を送信
        subscription = [
            {'ping': {'content': 'rs:0'}},
            {'ping': {'content': 'ps:0'}},
            {'thread': {
                'version': '20061206',
                'thread': self.thread_id,
                'threadkey': self.your_post_key,
                'user_id': '',
                'res_from': -100,
            }},
            {'ping': {'content': 'pf:0'}},
            {'ping': {'content': 'rf:0'}},
        ]
        _ws_send(self.comment_sock, json.dumps(subscription))
        self._log(f'comment WS connected, subscribed to thread {self.thread_id}')

    def _main_loop(self):
        """select() ベースのイベントループ"""
        deadline = time.monotonic() + self.duration

        while self.running and time.monotonic() < deadline:
            socks = [self.watch_sock]
            if self.comment_sock:
                socks.append(self.comment_sock)

            try:
                readable, _, _ = select.select(socks, [], [], 1.0)
            except (ValueError, OSError):
                # ソケットが閉じられた場合
                break

            for sock in readable:
                try:
                    op, payload = _ws_recv(sock)
                except Exception:
                    # 接続切断
                    if sock is self.watch_sock:
                        self._log('watch WS disconnected')
                        self.running = False
                    elif sock is self.comment_sock:
                        self._log('comment WS disconnected')
                        try:
                            self.comment_sock.close()
                        except Exception:
                            pass
                        self.comment_sock = None
                    continue

                if op == 0x8:  # close
                    if sock is self.watch_sock:
                        self._log('watch WS received close')
                        self.running = False
                    elif sock is self.comment_sock:
                        self._log('comment WS received close')
                        try:
                            self.comment_sock.close()
                        except Exception:
                            pass
                        self.comment_sock = None
                    continue

                if op == 0x9:  # ping
                    try:
                        _ws_send(sock, payload, op=0xA)  # pong
                    except Exception:
                        pass
                    continue

                if op != 0x1:  # text frame のみ処理
                    continue

                if sock is self.watch_sock:
                    self._handle_watch(payload)
                elif sock is self.comment_sock:
                    self._handle_comment(payload)

            # keepSeat タイマー
            now = time.monotonic()
            if now - self.last_keep_seat >= self.keep_interval:
                self.last_keep_seat = now
                try:
                    _ws_send(self.watch_sock, json.dumps({'type': 'keepSeat'}))
                except Exception:
                    self._log('keepSeat send failed')
                    self.running = False

    def _handle_watch(self, payload):
        """watch WS メッセージ処理"""
        try:
            msg = json.loads(payload)
        except json.JSONDecodeError:
            return

        msg_type = msg.get('type', '')
        data = msg.get('data', {})

        if msg_type == 'seat':
            self.keep_interval = data.get('keepIntervalSec', 30)
            self.last_keep_seat = time.monotonic()
            self._log(f'seat received, keepInterval={self.keep_interval}s')

        elif msg_type == 'room':
            self.thread_id = str(data.get('threadId', ''))
            self.your_post_key = data.get('yourPostKey', '') or ''
            ms = data.get('messageServer', {})
            self._comment_ws_uri = ms.get('uri', '') if ms else ''
            self._log(f'room: threadId={self.thread_id}')
            try:
                self._connect_comment_ws()
            except Exception as e:
                self._log(f'comment WS connection failed: {e}')

        elif msg_type == 'ping':
            try:
                _ws_send(self.watch_sock, json.dumps({'type': 'pong'}))
            except Exception:
                pass

        elif msg_type == 'disconnect':
            reason = data.get('reason', 'unknown')
            self._log(f'disconnect: {reason}')
            self.running = False

        elif msg_type == 'error':
            self._log(f'error: {data.get("message", "")}')

    def _handle_comment(self, payload):
        """comment WS → 受信 JSON をそのまま JSONL 書き出し"""
        try:
            line = payload.decode('utf-8')
        except UnicodeDecodeError:
            return

        # JSON として有効か最低限チェック (空行やバイナリを除外)
        stripped = line.strip()
        if not stripped:
            return

        self.outfile.write(stripped + '\n')
        self.outfile.flush()

    def _close_all(self):
        """全リソース解放"""
        for sock in (self.comment_sock, self.watch_sock):
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass
        if self.outfile:
            try:
                self.outfile.close()
            except Exception:
                pass
        self.watch_sock = None
        self.comment_sock = None
        self.outfile = None


def main():
    if len(sys.argv) != 4:
        print(f'Usage: {sys.argv[0]} <jk_id> <duration_seconds> <output_file>',
              file=sys.stderr)
        sys.exit(0)  # 引数不正でも exit 0

    jk_id = sys.argv[1]
    try:
        duration = int(sys.argv[2])
    except ValueError:
        print(f'[jikkyo-rec] invalid duration: {sys.argv[2]}', file=sys.stderr)
        sys.exit(0)

    output_path = sys.argv[3]

    try:
        recorder = JikkyoRecorder(jk_id, duration, output_path)
        recorder.run()
    except Exception as e:
        print(f'[jikkyo-rec] error: {e}', file=sys.stderr)

    sys.exit(0)


if __name__ == '__main__':
    main()
