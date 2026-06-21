#!/usr/bin/env python3
"""AirPlay Tab Caster — native bridge host (persistent, via connectNative).

This process is spawned by Chrome when the extension opens a native-messaging port.
It does two things at once:

  1. Runs a LAN HTTP relay (on 0.0.0.0:57842) that AVPlayer / the TV pull from.
  2. For every upstream URL the relay needs, it asks the EXTENSION to fetch it.
     Chrome fetches with its own session — which has already solved Cloudflare's
     "Just a moment" JS challenge and holds the cf_clearance cookie — and streams the
     bytes back here. The relay then rewrites HLS playlists and unwraps PNG-disguised
     segments before serving them.

So the TV plays content that ONLY the browser can fetch, without the browser running a
server. Flow:

  TV / AVPlayer ──► relay (this) ──fetch request──► extension (Chrome) ──► origin (Cloudflare)
                         ◄────────── bytes (base64 over native messaging) ◄──────────
"""
import sys
import os
import re
import json
import time
import struct
import base64
import queue
import socket
import threading
import subprocess
from urllib.parse import urlparse, urljoin
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("AIRPLAY_PROXY_PORT", "57842"))
HERE = os.path.dirname(os.path.abspath(__file__))
LOGFILE = os.path.join(HERE, "proxy.log")
IDLE_EXIT_SECS = 300            # exit if no fetches for 5 min (lets Chrome's SW idle too)

_stdout_lock = threading.Lock()
_pending = {}                   # fetch id -> queue.Queue
_pending_lock = threading.Lock()
_seq = 0
_last_fetch = time.time()
sessions = {}


def log(msg):
    try:
        with open(LOGFILE, "a") as f:
            f.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


# ---- native messaging I/O ---------------------------------------------------

def send(obj):
    data = json.dumps(obj).encode("utf-8")
    with _stdout_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    data = sys.stdin.buffer.read(n)
    if len(data) < n:
        return None
    return json.loads(data.decode("utf-8"))


def next_id():
    global _seq
    with _pending_lock:
        _seq += 1
        return _seq


def request_fetch(url, rng=None, timeout=30):
    """Ask the extension (Chrome) to fetch a URL; block until the bytes arrive."""
    global _last_fetch
    _last_fetch = time.time()
    fid = next_id()
    q = queue.Queue(maxsize=1)
    with _pending_lock:
        _pending[fid] = q
    send({"type": "fetch", "id": fid, "url": url, "range": rng or ""})
    try:
        return q.get(timeout=timeout)
    except queue.Empty:
        return {"ok": False, "error": "timeout"}
    finally:
        with _pending_lock:
            _pending.pop(fid, None)


# ---- helpers ----------------------------------------------------------------

def lan_ip():
    # Prefer a real physical interface (en0/en1/...). The default-route trick below
    # returns the VPN tunnel IP (e.g. ProtonVPN 10.x) when a VPN is up, and neither
    # AVPlayer nor the TV can reach that — so query the LAN interfaces directly first.
    for iface in ("en0", "en1", "en2", "en3", "en4", "en5"):
        try:
            r = subprocess.run(["ipconfig", "getifaddr", iface],
                               capture_output=True, text=True, timeout=3)
            ip = r.stdout.strip()
            if ip and not ip.startswith("169.254."):
                return ip
        except Exception:
            pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


LAN = lan_ip()
PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_IEND = b"IEND\xae\x42\x60\x82"


def b64u(s):
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def unb64u(s):
    return base64.urlsafe_b64decode((s + "=" * (-len(s) % 4)).encode("ascii")).decode("utf-8")


def prox_url(absolute, sid):
    return "http://%s:%d/s/%s/%s" % (LAN, PORT, sid, b64u(absolute))


def rewrite_playlist(text, base, sid):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
            continue
        if s.startswith("#"):
            line = re.sub(r'URI="([^"]+)"',
                          lambda m: 'URI="%s"' % prox_url(urljoin(base, m.group(1)), sid), line)
            out.append(line)
        else:
            out.append(prox_url(urljoin(base, s), sid))
    return "\n".join(out) + "\n"


def dewrap_png(body):
    if body[:8] != PNG_SIG:
        return None
    idx = body.find(PNG_IEND)
    if idx == -1:
        return None
    payload = body[idx + len(PNG_IEND):]
    return payload if payload else None


def guess_media_ct(payload):
    if payload[:1] == b"\x47":
        return "video/mp2t"
    if payload[4:8] in (b"ftyp", b"moof", b"styp", b"mdat"):
        return "video/mp4"
    return "application/octet-stream"


def is_playlist(body, ctype, url):
    return (body[:7] == b"#EXTM3U"
            or "mpegurl" in (ctype or "").lower()
            or urlparse(url).path.lower().endswith(".m3u8"))


# ---- HTTP relay -------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_HEAD(self):
        self._handle("HEAD")

    def do_GET(self):
        self._handle("GET")

    def _handle(self, method):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            if method == "GET":
                self.wfile.write(b"ok")
            return

        m = re.match(r"^/s/([0-9a-f]+)/(.+)$", self.path)
        if not m:
            self.send_error(404)
            return
        sid, enc = m.group(1), m.group(2)
        if sid not in sessions:
            self.send_error(410, "session expired")
            return
        try:
            upstream = unb64u(enc)
        except Exception:
            self.send_error(400)
            return

        rng = self.headers.get("Range")
        log("REQ %s %s rng=%s -> %s" % (self.client_address[0], method, rng or "-", upstream[-60:]))

        if method == "HEAD":
            self.send_response(200)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
            return

        res = request_fetch(upstream)  # Chrome fetches it for us
        if not res.get("ok"):
            log("  fetch failed (%s) -> %s" % (res.get("error") or res.get("status"), upstream[-60:]))
            self.send_error(502, "bridge fetch failed")
            return

        status = res.get("status", 200)
        ctype = res.get("contentType", "") or ""
        final_url = res.get("finalUrl") or upstream
        try:
            body = base64.b64decode(res.get("bodyB64", "")) if res.get("bodyB64") else b""
        except Exception:
            self.send_error(502)
            return

        if status >= 400:
            log("  upstream %s -> %s" % (status, upstream[-60:]))

        if is_playlist(body, ctype, final_url):
            out = rewrite_playlist(body.decode("utf-8", "replace"), final_url, sid).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(out)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(out)
            return

        # binary: unwrap PNG-disguised segments, then serve with Range support
        if body[:8] == PNG_SIG:
            payload = dewrap_png(body)
            if payload is not None:
                log("  dewrapped PNG %d -> %d" % (len(body), len(payload)))
                self._serve_bytes(payload, guess_media_ct(payload))
                return
        self._serve_bytes(body, ctype or "application/octet-stream")

    def _serve_bytes(self, data, ctype):
        total = len(data)
        start, end, partial = 0, total - 1, False
        rng = self.headers.get("Range")
        if rng:
            mo = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if mo:
                s, e = mo.group(1), mo.group(2)
                if s == "" and e != "":
                    start, end = max(0, total - int(e)), total - 1
                else:
                    start = int(s) if s else 0
                    end = int(e) if e else total - 1
                start, end = max(0, start), min(end, total - 1)
                partial = start <= end
        chunk = data[start:end + 1] if partial else data
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(chunk)))
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
        self.end_headers()
        try:
            self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def start_server():
    for _ in range(24):
        try:
            return ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
        except OSError:
            time.sleep(0.25)
    return None


# ---- control handling -------------------------------------------------------

def handle_play(msg):
    url = (msg.get("url") or "").strip()
    title = msg.get("title", "") or ""
    if not url:
        send({"type": "played", "ok": False, "error": "no url"})
        return
    sid = "%08x%08x" % (next_id(), int(time.time()) & 0xffffffff)
    sessions[sid] = {"created": time.time()}
    play_url = prox_url(url, sid)
    app = os.path.join(HERE, "AirPlayCaster.app")
    if not os.path.isdir(app):
        send({"type": "played", "ok": False, "error": "AirPlayCaster.app missing"})
        return
    subprocess.Popen(["/usr/bin/open", "-n", app, "--args", "--url", play_url, "--title", title],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log("PLAY sid=%s -> %s" % (sid, url[-60:]))
    send({"type": "played", "ok": True, "url": play_url})


def deliver_fetch_result(msg):
    fid = msg.get("id")
    with _pending_lock:
        q = _pending.get(fid)
    if q:
        try:
            q.put_nowait(msg)
        except queue.Full:
            pass


def keepalive_loop():
    # Keep Chrome's service worker alive only while playback is active.
    while True:
        time.sleep(20)
        if time.time() - _last_fetch < IDLE_EXIT_SECS:
            try:
                send({"type": "ping"})
            except Exception:
                return


def idle_loop():
    while True:
        time.sleep(30)
        if time.time() - _last_fetch > IDLE_EXIT_SECS:
            log("idle exit")
            os._exit(0)


def main():
    httpd = start_server()
    if httpd is None:
        log("could not bind %d" % PORT)
        send({"type": "played", "ok": False, "error": "port busy"})
        return
    log("bridge up on 0.0.0.0:%d (lan=%s)" % (PORT, LAN))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    threading.Thread(target=keepalive_loop, daemon=True).start()
    threading.Thread(target=idle_loop, daemon=True).start()

    while True:
        try:
            msg = read_message()
        except Exception:
            break
        if msg is None:
            break  # port closed by Chrome -> exit, freeing the port
        t = msg.get("type")
        if t == "play":
            handle_play(msg)
        elif t == "fetchResult":
            deliver_fetch_result(msg)
        # "pong" and others: ignore


if __name__ == "__main__":
    main()
