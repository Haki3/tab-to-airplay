#!/usr/bin/env python3
"""LAN HLS/media relay proxy for AirPlay Tab Caster.

Why this exists: some streams are (1) DNS-blocked on the local network, (2) behind
Cloudflare bot protection, and (3) only reachable from a real browser session. Chrome
handles all that; AVPlayer / the TV can't. This proxy bridges the gap:

  TV / AVPlayer  ──►  this proxy (on the Mac's LAN IP)  ──►  upstream CDN
                      · resolves hosts via DoH (bypasses the DNS block)
                      · sends a browser User-Agent + Referer + Cookies (passes Cloudflare)
                      · rewrites HLS playlists so every segment/sub-playlist/key also
                        flows back through this proxy
                      · serves on the LAN IP so the TV can always reach it (works whether
                        AirPlay hands off the URL or relays from the Mac)

It is a generic relay; the extension already supplies the URL + cookies + UA.
"""
import sys
import os
import re
import ssl
import json
import time
import socket
import base64
import secrets
import threading
import http.client
import urllib.request
import urllib.error
from urllib.parse import urlparse, urljoin
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("AIRPLAY_PROXY_PORT", "57842"))
DEFAULT_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
IDLE_SHUTDOWN_SECS = 20 * 60
LOGFILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy.log")

sessions = {}            # sid -> {ua, referer, cookie, master_host}
_last_active = time.time()
_captured = False        # one-time sample capture flag
_doh_cache = {}          # host -> (ip, expires)
_orig_getaddrinfo = socket.getaddrinfo


def log(msg):
    try:
        with open(LOGFILE, "a") as f:
            f.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass


# ---- DoH resolution (bypasses the local DNS block) -------------------------

def _is_ip(host):
    for fam in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(fam, host)
            return True
        except OSError:
            pass
    return False


def doh_resolve(host):
    now = time.time()
    hit = _doh_cache.get(host)
    if hit and hit[1] > now:
        return hit[0]
    ctx = ssl.create_default_context()
    providers = [
        ("1.1.1.1", "/dns-query?name=%s&type=A", {"accept": "application/dns-json"}),
        ("8.8.8.8", "/resolve?name=%s&type=A", {"accept": "application/dns-json"}),
    ]
    for ip, path_tmpl, headers in providers:
        try:
            conn = http.client.HTTPSConnection(ip, 443, context=ctx, timeout=8)
            conn.request("GET", path_tmpl % host, headers=headers)
            r = conn.getresponse()
            data = json.loads(r.read().decode("utf-8"))
            conn.close()
            answers = [a["data"] for a in data.get("Answer", []) if a.get("type") == 1]
            if answers:
                _doh_cache[host] = (answers[0], now + 300)
                log("DoH %s -> %s (via %s)" % (host, answers[0], ip))
                return answers[0]
        except Exception as e:  # noqa: BLE001
            log("DoH fail %s via %s: %s" % (host, ip, e))
    raise socket.gaierror("DoH could not resolve %s" % host)


def patched_getaddrinfo(host, *args, **kwargs):
    # Pass through IP literals, localhost and the DoH servers; DoH-resolve real hostnames.
    if not host or _is_ip(host) or host in ("localhost", "1.1.1.1", "8.8.8.8"):
        return _orig_getaddrinfo(host, *args, **kwargs)
    try:
        ip = doh_resolve(host)
        return _orig_getaddrinfo(ip, *args, **kwargs)
    except Exception:
        # Fall back to the system resolver (may be blocked, but try anyway).
        return _orig_getaddrinfo(host, *args, **kwargs)


socket.getaddrinfo = patched_getaddrinfo


# ---- helpers ---------------------------------------------------------------

def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no packets sent; just picks the route's source IP
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


LAN = lan_ip()


def b64u(s):
    return base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii").rstrip("=")


def unb64u(s):
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii")).decode("utf-8")


def reg_domain(host):
    parts = (host or "").split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def short(url):
    p = urlparse(url)
    tail = p.path.rsplit("/", 1)[-1] or p.path
    return "%s/…/%s%s" % (p.hostname or "?", tail[-48:], ("?" + p.query[:20]) if p.query else "")


PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_IEND = b"IEND\xae\x42\x60\x82"  # IEND chunk type + its fixed CRC


def dewrap_png(body):
    """Some streams disguise each media segment as a tiny PNG with the real MPEG-TS /
    fMP4 data appended after the PNG's IEND chunk. Return the hidden payload, or None
    if this is a genuine image (no trailing data)."""
    if body[:8] != PNG_SIG:
        return None
    idx = body.find(PNG_IEND)
    if idx == -1:
        return None
    payload = body[idx + len(PNG_IEND):]
    return payload if payload else None


def guess_media_ct(payload):
    if payload[:1] == b"\x47":                       # MPEG-TS sync byte
        return "video/mp2t"
    if payload[4:8] in (b"ftyp", b"moof", b"styp", b"mdat"):
        return "video/mp4"
    return "application/octet-stream"


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
            # Rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP, I-FRAME...).
            line = re.sub(
                r'URI="([^"]+)"',
                lambda m: 'URI="%s"' % prox_url(urljoin(base, m.group(1)), sid),
                line,
            )
            out.append(line)
        else:
            out.append(prox_url(urljoin(base, s), sid))
    return "\n".join(out) + "\n"


# ---- HTTP handler ----------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # silence default stderr logging

    def _touch(self):
        global _last_active
        _last_active = time.time()

    def do_POST(self):
        self._touch()
        if self.path != "/session":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            self.send_error(400)
            return
        sid = secrets.token_hex(8)
        master = body.get("master", "")
        sessions[sid] = {
            "ua": body.get("ua") or DEFAULT_UA,
            "referer": body.get("referer") or "",
            "cookie": body.get("cookie") or "",
            "master_host": urlparse(master).hostname or "",
        }
        resp = json.dumps({"sid": sid, "url": prox_url(master, sid), "lan": LAN, "port": PORT}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def do_HEAD(self):
        self._handle("HEAD")

    def do_GET(self):
        self._handle("GET")

    def _handle(self, method):
        self._touch()
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
        sess = sessions.get(sid)
        if not sess:
            self.send_error(410, "session expired")
            return
        try:
            upstream = unb64u(enc)
        except Exception:
            self.send_error(400)
            return
        log("REQ %s %s rng=%s -> %s" % (self.client_address[0], method,
                                        self.headers.get("Range", "-"), short(upstream)))
        self._proxy(method, upstream, sess)

    def _proxy(self, method, upstream, sess):
        host = urlparse(upstream).hostname or ""
        headers = {"User-Agent": sess["ua"], "Accept": "*/*"}
        if sess["referer"]:
            headers["Referer"] = sess["referer"]
        # Only send cookies to the master's own registrable domain.
        if sess["cookie"] and reg_domain(host) == reg_domain(sess["master_host"]):
            headers["Cookie"] = sess["cookie"]
        rng = self.headers.get("Range")
        if rng:
            headers["Range"] = rng

        req = urllib.request.Request(upstream, headers=headers, method=method)
        try:
            resp = urllib.request.urlopen(req, timeout=25)
        except urllib.error.HTTPError as e:
            resp = e  # still has status/headers/body
        except Exception as e:  # noqa: BLE001
            log("upstream error %s: %s" % (upstream, e))
            self.send_error(502, "upstream error")
            return

        status = getattr(resp, "status", 200) or 200
        ctype = resp.headers.get("Content-Type", "") or ""
        path_l = urlparse(upstream).path.lower()
        log("RES %s ct=%s clen=%s -> %s" % (status, ctype or "-",
                                            resp.headers.get("Content-Length", "-"), short(upstream)))
        if status >= 400:
            log("  !! upstream returned %s for %s" % (status, upstream))

        if method == "HEAD":
            self.send_response(status)
            for h in ("Content-Type", "Content-Length", "Accept-Ranges"):
                v = resp.headers.get(h)
                if v:
                    self.send_header(h, v)
            self.end_headers()
            try:
                resp.close()
            except Exception:
                pass
            return

        # Peek to detect a playlist regardless of content-type.
        head = resp.read(16)
        is_playlist = (head.startswith(b"#EXTM3U")
                       or "mpegurl" in ctype.lower()
                       or path_l.endswith(".m3u8"))
        if not is_playlist:
            log("  bin head=%s ct=%s clen=%s -> %s"
                % (head.hex(), ctype or "-", resp.headers.get("Content-Length", "-"), short(upstream)))

        if is_playlist:
            body = head + resp.read()
            try:
                text = body.decode("utf-8", "replace")
                out = rewrite_playlist(text, upstream, self._sid_from_path()).encode("utf-8")
            except Exception as e:  # noqa: BLE001
                log("rewrite error %s: %s" % (upstream, e))
                self.send_error(502)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.apple.mpegurl")
            self.send_header("Content-Length", str(len(out)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(out)
            return

        # De-disguise: segments wrapped in a tiny PNG (real media after IEND). Strip it.
        if head[:8] == PNG_SIG:
            body = head + resp.read()
            try:
                resp.close()
            except Exception:
                pass
            payload = dewrap_png(body)
            if payload is not None:
                ct = guess_media_ct(payload)
                log("  dewrapped PNG %d -> %d bytes (%s) <- %s"
                    % (len(body), len(payload), ct, short(upstream)))
                self._serve_bytes(payload, ct)
            else:
                self._serve_bytes(body, ctype or "image/png")
            return

        # Binary passthrough (segments, keys, mp4) with Range support.
        self.send_response(status)
        passthru = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges",
                    "Last-Modified", "ETag"]
        for h in passthru:
            v = resp.headers.get(h)
            if v:
                self.send_header(h, v)
        # Without a Content-Length the client can't tell when the body ends on a
        # keep-alive connection, so force close in that case.
        if not resp.headers.get("Content-Length"):
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        # One-time: capture a full sample of the first non-playlist response so we can
        # figure out how the segments are disguised (e.g. PNG-wrapped).
        global _captured
        capture = None
        if not _captured and ("image" in ctype.lower() or status == 200):
            _captured = True
            try:
                capture = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                            "sample_segment.bin"), "wb")
                log("  capturing sample_segment.bin from %s" % short(upstream))
            except Exception:
                capture = None

        sent = 0
        try:
            self.wfile.write(head)
            sent += len(head)
            if capture:
                capture.write(head)
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                sent += len(chunk)
                if capture and capture.tell() < 3_000_000:
                    capture.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            log("  client dropped after %d bytes -> %s" % (sent, short(upstream)))
        except Exception as e:  # noqa: BLE001
            log("  stream error after %d bytes %s: %s" % (sent, short(upstream), e))
        finally:
            if capture:
                try:
                    capture.close()
                except Exception:
                    pass
            try:
                resp.close()
            except Exception:
                pass

    def _sid_from_path(self):
        m = re.match(r"^/s/([0-9a-f]+)/", self.path)
        return m.group(1) if m else ""

    def _serve_bytes(self, data, ctype):
        """Serve a fully-buffered body (already de-wrapped) with Range support."""
        total = len(data)
        start, end, partial = 0, total - 1, False
        rng = self.headers.get("Range")
        if rng:
            mobj = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if mobj:
                s, e = mobj.group(1), mobj.group(2)
                if s == "" and e != "":            # suffix range: last N bytes
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


def idle_watchdog(httpd):
    while True:
        time.sleep(30)
        if time.time() - _last_active > IDLE_SHUTDOWN_SECS:
            log("idle shutdown")
            httpd.shutdown()
            return


def main():
    try:
        httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    except OSError as e:
        log("bind failed on %d: %s" % (PORT, e))
        sys.exit(1)
    log("proxy up on %s:%d (lan=%s)" % ("0.0.0.0", PORT, LAN))
    threading.Thread(target=idle_watchdog, args=(httpd,), daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
