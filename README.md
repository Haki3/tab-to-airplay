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
- 🧠 **Smart stream detection.** When a page exposes several streams, it fetches each playlist, sums the segment durations, and marks the longest real video as the **likely stream** — so you skip ads, previews and clips.
- ✅ **Playback pre-check.** Before listing anything, it probes the first segment of each candidate and **hides the ones that don't actually load** (dead links, 403s, expired tokens) — no more "tap → stuck loading".
- 📋 **Picker popup.** Lists only the videos that play, ranked by duration.
- 🔗 **Real AirPlay.** Plays through `AVPlayer` and the native macOS route picker — not screen mirroring.
- 🌐 **Browser-powered fetching.** The relay asks **Chrome** to fetch every segment, so anything your browser can load — DNS-blocked domains, **Cloudflare "Just a moment" JS-challenge sites**, login-gated streams — plays on the TV, using the session that already solved it.
- 🧩 **Smart relay.** Rewrites HLS playlists and serves them from your Mac's LAN address, so the TV can always reach the content.
- 🔓 **De-obfuscation.** Some sites disguise each video chunk as a tiny PNG; the relay unwraps it back to real MPEG-TS/fMP4.

## How it works

```
AirPlayCaster.app / TV ──pull──►  airplay_host.py  (LAN relay on your Mac, :57842)
                                        │  needs bytes for a URL
                                        ▼  native messaging
                                  Chrome extension  ── fetch() with the page's session:
                                        │              solves Cloudflare, sends cf_clearance,
                                        ▼              uses Secure DNS — just like a tab
                                     origin CDN
                                        │
                                        ▼  bytes flow back; the relay rewrites HLS playlists
                                           and unwraps PNG-disguised segments before serving
```

Two things make hard streams work:
1. **Chrome does the fetching**, so anything the browser can load works — including sites behind
   Cloudflare's "Just a moment" JS challenge that no standalone player/relay can pass.
2. **The relay is served from your Mac's LAN IP**, so the TV can always reach it (AirPlay handoff
   or relay — either way).

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
| Streams blocked by local DNS | ✅ (Chrome's Secure DNS does the lookup) |
| Cloudflare "Just a moment" JS-challenge sites | ✅ (Chrome solved it; the relay fetches through Chrome) |
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
| Want to debug | `native/proxy.log` (every relay request + bridge fetch) and `native/player.log` (AVPlayer errors with HTTP codes). |

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
│   ├── airplay_host.py       # native bridge: LAN relay + fetch-via-Chrome + HLS rewrite + PNG unwrap
│   └── generate_icons.py
├── install.sh                # build + register with Chrome
└── LICENSE
```

## Technical notes

- The native bridge (`airplay_host.py`) is spawned by Chrome via `connectNative`, runs the LAN
  relay on `0.0.0.0:57842`, and exits ~5 min after playback stops.
- Every upstream byte is fetched by the **extension** (`fetch` with credentials), so DNS, cookies
  (incl. `cf_clearance`), and the Cloudflare challenge are all handled by Chrome itself — the relay
  never talks to the origin directly.
- Segment bytes travel extension → host as base64 over native messaging; the host rewrites HLS
  playlists (so children route back through it) and unwraps PNG-disguised segments.
- **PNG unwrap:** some sites wrap each chunk in a minimal 1×1 PNG with the real MPEG-TS/fMP4 appended after the `IEND` chunk. The relay detects the PNG, finds `IEND`, and serves only the real media with the correct `Content-Type`.
- The native app is written in **Objective-C on purpose** — it avoids a Swift compiler/SDK version mismatch present in some Command Line Tools installs.

## Responsible use

This tool relays streams you can already access in your own browser, for personal playback on your own TV. It does not break DRM. Respect the terms of service of the sites you use and applicable copyright law in your country. You are responsible for how you use it.

## License

[MIT](LICENSE) © Reda El Haki
