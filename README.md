<div align="center">

# 📺 AirPlay Tab Caster

**Send the video playing in any Chrome tab straight to your AirPlay TV — Apple TV, or an AirPlay 2 smart TV like LG / Samsung.**

Chrome can't do AirPlay on its own. This bridges the gap with a tiny native macOS helper, and a local relay that handles even the trickiest streams.

![platform](https://img.shields.io/badge/platform-macOS-000?logo=apple)
![chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

---

## Why this exists

AirPlay is an Apple system technology (WebKit / native apps). **Chrome has no API to start it** — extensions live in a sandbox and can't see your TV as an AirPlay target. The only thing Chrome's picker offers is Chromecast.

So AirPlay Tab Caster splits the job:

- A **Chrome extension** detects the video you're watching and asks if you want to send it.
- A **native macOS app** (`AirPlayCaster.app`) plays the stream and exposes the real AirPlay picker.
- A **local relay** (optional, automatic) makes hard-to-reach streams playable by your Mac *and* your TV.

## Features

- 🎯 **One click.** A floating AirPlay button finds the video you're watching and confirms before sending.
- 📋 **Picker popup.** Lists every playable video/stream detected in the tab.
- 🔗 **Real AirPlay.** Plays through `AVPlayer` and the native macOS route picker — not screen mirroring.
- 🌐 **DNS-resilient.** The relay resolves hosts over **DoH** (like Chrome's Secure DNS), so locally blocked domains still work.
- 🛡️ **Session-aware.** Forwards your browser **User-Agent + cookies + referer**, so streams behind bot protection load.
- 🧩 **Smart relay.** Rewrites HLS playlists and serves them from your Mac's LAN address, so the TV can always reach the content.
- 🔓 **De-obfuscation.** Some sites disguise each video chunk as a tiny PNG; the relay unwraps it back to real MPEG-TS/fMP4.

## How it works

```
Chrome (extension)            detects the video → asks → sends
  │  URL + cookies + User-Agent
  ▼
airplay_host.py               starts the relay, registers a session
  │
  ▼
hls_proxy.py  (LAN relay)  ──  resolves hosts via DoH (bypasses DNS blocks)
  │                        ──  sends browser User-Agent + cookies + referer
  │                        ──  rewrites HLS so every segment/key flows back through it
  │                        ──  unwraps PNG-disguised segments → real MPEG-TS
  │                        ──  listens on your Mac's LAN IP
  ▼
AirPlayCaster.app             AVPlayer plays http://<lan-ip>:57842/…
  │
  ▼  AirPlay → your TV   (the TV reaches the relay over the LAN, so handoff just works)
```

For simple public videos the relay is a transparent passthrough; the machinery only matters for protected streams.

## Requirements

- **macOS** (built & tested on Apple Silicon, macOS 12+)
- **Google Chrome** (or Chromium / Brave)
- **Python 3** and **Command Line Tools** (`xcode-select --install`) — used to build the helper
- A TV / device that supports **AirPlay** (Apple TV, or AirPlay 2 smart TVs)

## Installation

### 1. Native side (one-time)

```bash
git clone https://github.com/Haki3/tab-to-airplay.git ~/airplay-tab-caster
cd ~/airplay-tab-caster
bash install.sh
```

This compiles `AirPlayCaster.app` (Objective-C + AVKit via `clang`), creates the native-messaging host, and registers it with Chrome.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `extension/` folder
4. The ID should be **`peikkecpbbkcopacloehlodpffhcjbhf`** (fixed by the public key in `manifest.json`, so the native host knows who to trust)

## Usage

- Open a tab with a video and click the floating **📺** button (bottom-right), **or** click the extension icon for the full list.
- Pick the video → confirm → the native player opens → **tap the AirPlay button and choose your TV**.

## What works / what doesn't

| Source | Works? |
|---|---|
| Direct `.mp4` / `.webm` / `.mov` | ✅ |
| HLS streams (`.m3u8`), public or private | ✅ |
| X/Twitter, Reddit, news sites, embedded players | ✅ |
| Streams blocked by local DNS / behind Cloudflare | ✅ (via the relay: DoH + UA + cookies) |
| Segments disguised as PNG (anti-bot) | ✅ (relay unwraps them to MPEG-TS) |
| Login-gated videos | ✅ usually (Chrome cookies are forwarded) |
| **YouTube / YouTube Shorts** | ❌ — video is served via encrypted MSE/`blob:`; there's no URL to capture |
| **MPEG-DASH** (`.mpd`) | ❌ — `AVPlayer` doesn't play DASH |
| **DRM** (Netflix, Disney+, etc.) | ❌ — protected by design |

## Troubleshooting

| Symptom | Fix |
|---|---|
| AirPlay connects but the TV stays black | Allow incoming connections for `python` in **System Settings → Network → Firewall** (or accept the prompt). |
| "Native helper not found" | Run `bash install.sh` again and reload the extension. |
| "Couldn't play / permission error" | The origin needs more than can be forwarded (single-use token, strict TLS fingerprint). Check `native/proxy.log`. |
| TV doesn't appear in the AirPlay menu | Mac and TV on the same Wi-Fi; AirPlay enabled on the TV. Accept the macOS "local network" prompt the first time. |
| Want to debug | `native/proxy.log` (every relay request + DoH resolution) and `native/player.log` (AVPlayer errors with HTTP codes). |

## Project structure

```
airplay-tab-caster/
├── extension/                # Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js         # stream sniffing + cookies + native messaging
│   ├── content.js            # floating AirPlay button + confirm panel
│   ├── popup.html / popup.js # detected-videos picker
│   └── icons/
├── native/
│   ├── Sources/main.m        # AirPlayCaster.app (Obj-C + AVKit)
│   ├── Info.plist
│   ├── build.sh              # compiles the .app
│   ├── airplay_host.py       # native-messaging host (boots the relay)
│   ├── hls_proxy.py          # LAN relay: DoH + UA + HLS rewrite + PNG unwrap
│   └── generate_icons.py
├── install.sh                # build + register with Chrome
└── LICENSE
```

## Technical notes

- The relay (`hls_proxy.py`) listens on `0.0.0.0:57842` and shuts itself down after 20 min idle.
- Host names are resolved over **DoH** (Cloudflare `1.1.1.1`, Google `8.8.8.8` fallback) to sidestep local DNS blocks — the same trick as Chrome's "Secure DNS".
- Cookies are only sent to the master playlist's own registrable domain (never to third parties).
- **PNG unwrap:** some sites wrap each chunk in a minimal 1×1 PNG with the real MPEG-TS/fMP4 appended after the `IEND` chunk. The relay detects the PNG, finds `IEND`, and serves only the real media with the correct `Content-Type`.
- The native app is written in **Objective-C on purpose** — it avoids a Swift compiler/SDK version mismatch present in some Command Line Tools installs.

## Responsible use

This tool relays streams you can already access in your own browser, for personal playback on your own TV. It does not break DRM. Respect the terms of service of the sites you use and applicable copyright law in your country. You are responsible for how you use it.

## License

[MIT](LICENSE) © Reda El Haki
