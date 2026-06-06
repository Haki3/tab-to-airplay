#!/usr/bin/env python3
"""Native-messaging host for the AirPlay Tab Caster extension.

Chrome speaks to this over stdio (4-byte little-endian length prefix + JSON body).
On receiving {url, referer, title, cookie, userAgent} it:
  1. Ensures the local LAN relay proxy (hls_proxy.py) is running.
  2. Registers a session (URL + browser headers) with the proxy.
  3. Launches AirPlayCaster.app pointed at the proxied LAN URL, so the stream reaches
     the TV via AirPlay even when it's DNS-blocked / Cloudflare-gated / browser-bound.
Then it replies {ok: true}.
"""
import sys
import os
import json
import struct
import time
import subprocess
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY_PORT = int(os.environ.get("AIRPLAY_PROXY_PORT", "57842"))
PROXY_BASE = "http://127.0.0.1:%d" % PROXY_PORT


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    data = sys.stdin.buffer.read(msg_len)
    if len(data) < msg_len:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def proxy_healthy():
    try:
        with urllib.request.urlopen(PROXY_BASE + "/health", timeout=1.5) as r:
            return r.read() == b"ok"
    except Exception:
        return False


def ensure_proxy():
    if proxy_healthy():
        return True
    py = sys.executable or "/usr/bin/python3"
    proxy_py = os.path.join(HERE, "hls_proxy.py")
    try:
        subprocess.Popen(
            [py, proxy_py],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
            start_new_session=True,  # detach so it outlives this short-lived host
        )
    except Exception:
        return False
    for _ in range(40):  # up to ~6s
        if proxy_healthy():
            return True
        time.sleep(0.15)
    return False


def create_session(url, referer, cookie, ua):
    payload = json.dumps({
        "master": url, "referer": referer, "cookie": cookie, "ua": ua,
    }).encode("utf-8")
    req = urllib.request.Request(PROXY_BASE + "/session", data=payload,
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def launch_app(play_url, title):
    app = os.path.join(HERE, "AirPlayCaster.app")
    if not os.path.isdir(app):
        return False, "AirPlayCaster.app no encontrada; ejecuta install.sh"
    args = ["/usr/bin/open", "-n", app, "--args",
            "--url", play_url, "--title", title or ""]
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True, None


def main():
    try:
        msg = read_message()
    except Exception as e:  # noqa: BLE001
        send_message({"ok": False, "error": "bad message: %s" % e})
        return
    if not msg:
        return

    url = (msg.get("url") or "").strip()
    if not url:
        send_message({"ok": False, "error": "no url"})
        return

    referer = msg.get("referer", "") or ""
    cookie = msg.get("cookie", "") or ""
    ua = msg.get("userAgent", "") or ""
    title = msg.get("title", "") or ""

    play_url = url  # default: direct (used only if the proxy can't start)

    if url.lower().startswith(("http://", "https://")):
        if ensure_proxy():
            try:
                sess = create_session(url, referer, cookie, ua)
                play_url = sess["url"]
            except Exception as e:  # noqa: BLE001
                # Proxy up but session failed — fall back to direct.
                play_url = url
        # If the proxy couldn't start, play_url stays the direct URL.

    ok, err = launch_app(play_url, title)
    send_message({"ok": ok, "error": err} if not ok else {"ok": True, "via": ("proxy" if play_url != url else "direct")})


if __name__ == "__main__":
    main()
